import type Stripe from "stripe";
import type { Office } from "@shared/schema";
import { storage } from "./storage";
import {
  getStripe,
  APP_URL,
  seatPriceIdForTier,
  dashboardPriceIdForTier,
  isSeatPriceId,
  isDashboardPriceId,
} from "./stripe";

// --- Pricing model: flat-per-tier (Pricing v2) ------------------------------
// A consultant seat and the optional Manager Dashboard each have ONE flat monthly
// rate per plan tier. An office's tier is derived from its total seat count, and
// crossing a tier boundary re-prices EVERY seat (and the dashboard, if active) to
// the new tier's flat rate — NOT graduated/tax-bracket billing. Enterprise (36+)
// is a custom quote with no self-serve Stripe price.
export type SelfServeTier = "team" | "office" | "company";

export interface PlanTier {
  tier: SelfServeTier;
  minSeats: number;
  maxSeats: number;
  seatRate: number; // USD per seat / month
  dashboardRate: number; // USD / month for the optional dashboard at this tier
}

export const PLAN_TIERS: readonly PlanTier[] = [
  { tier: "team", minSeats: 1, maxSeats: 5, seatRate: 49, dashboardRate: 249 },
  { tier: "office", minSeats: 6, maxSeats: 20, seatRate: 45, dashboardRate: 389 },
  { tier: "company", minSeats: 21, maxSeats: 35, seatRate: 41, dashboardRate: 529 },
];

// 36+ seats is Enterprise: a custom quote handled off-platform, never self-serve.
export const ENTERPRISE_MIN_SEATS = 36;

export function isEnterpriseSeatCount(seatCount: number): boolean {
  return seatCount >= ENTERPRISE_MIN_SEATS;
}

// The self-serve plan tier a seat count falls into, or null for Enterprise (36+).
// A count of 0 (brand-new office, no consultants yet) is treated as the entry
// (Team) tier so the optional dashboard always has a well-defined price.
export function planForSeatCount(seatCount: number): PlanTier | null {
  if (isEnterpriseSeatCount(seatCount)) return null;
  const n = Math.max(seatCount, 1);
  return PLAN_TIERS.find((p) => n >= p.minSeats && n <= p.maxSeats) ?? null;
}

// Thrown when a self-serve billing action would push an office to 36+ seats.
// Callers should route the office to the custom-quote/contact flow instead.
export class EnterpriseQuoteRequiredError extends Error {
  constructor(seatCount: number) {
    super(
      `Enterprise pricing required: ${seatCount} seats is 36+, which is a custom ` +
        `quote. Contact sales instead of self-serve checkout.`,
    );
    this.name = "EnterpriseQuoteRequiredError";
  }
}

// Statuses that mean the office is paid-up and may use the product. Anything else
// (past_due, canceled, unpaid, incomplete, incomplete_expired) is locked out.
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export function officeIsActive(office: Pick<Office, "subscriptionStatus">): boolean {
  return ACTIVE_STATUSES.has(office.subscriptionStatus);
}

// Reuse the office's Stripe customer if one exists, otherwise create it and persist
// the id. Storing the customer id up front lets webhooks resolve the office even if
// the browser never returns from Checkout.
export async function ensureCustomer(office: Office, email?: string): Promise<string> {
  if (office.stripeCustomerId) return office.stripeCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: office.name,
    email,
    metadata: { officeId: String(office.id) },
  });
  await storage.updateOffice(office.id, { stripeCustomerId: customer.id });
  return customer.id;
}

// Manager checkout: a subscription-mode Checkout Session that bootstraps the
// office subscription with the optional Manager Dashboard line (qty 1) at the
// office's current tier rate. The dashboard is fully optional and removable later
// (see removeDashboard) so an office can run seats-only, but the subscription
// needs at least one line item to be created and the manager dashboard is the
// manager's own tool, so it is the natural bootstrap item. The per-seat line is
// added lazily on the first seat join (setSeatQuantity), so a brand-new office
// with no consultants yet is not billed for zero seats. A brand-new office sits
// in the entry (Team) tier and the dashboard re-tiers automatically as seats are
// added. Access is granted by the webhook, never by the redirect.
export async function createManagerCheckoutSession(
  office: Office,
  email?: string,
  opts: { includeDashboard?: boolean } = {},
): Promise<string> {
  const { includeDashboard = true } = opts;
  const stripe = getStripe();
  const customerId = await ensureCustomer(office, email);

  const tier = (planForSeatCount(office.activeSeatCount ?? 0) ?? PLAN_TIERS[0]).tier;
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  if (includeDashboard) {
    lineItems.push({ price: dashboardPriceIdForTier(tier), quantity: 1 });
  }
  if (lineItems.length === 0) {
    throw new Error("Checkout requires at least one line item (dashboard or a seat)");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: String(office.id),
    line_items: lineItems,
    subscription_data: { metadata: { officeId: String(office.id) } },
    success_url: `${APP_URL}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/dashboard?checkout=cancelled`,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

// Self-serve billing management (update card, cancel, view invoices).
export async function createBillingPortalSession(office: Office): Promise<string> {
  if (!office.stripeCustomerId) {
    throw new Error("Office has no Stripe customer yet");
  }
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: office.stripeCustomerId,
    return_url: `${APP_URL}/dashboard`,
  });
  return session.url;
}

// Push an exact seat quantity to Stripe, creating the seat subscription item on
// first use. Returns the seat item id so the caller can persist it. This is the
// single choke point for changing billed seat count (join, remove, manager seat).
//
// Flat-per-tier: the seat count determines the tier, and the seat line's PRICE is
// set to that tier's flat rate — so crossing a boundary re-prices EVERY seat, not
// just the marginal one. Reaching 36+ seats is Enterprise (custom quote) and is
// rejected here so the caller can route to the contact/quote flow.
export async function setSeatQuantity(office: Office, quantity: number): Promise<string> {
  if (!office.stripeSubscriptionId) {
    throw new Error("Office has no active subscription to attach seats to");
  }
  if (isEnterpriseSeatCount(quantity)) {
    throw new EnterpriseQuoteRequiredError(quantity);
  }
  const stripe = getStripe();
  const plan = planForSeatCount(quantity)!; // non-null: guarded against Enterprise above
  const seatPriceId = seatPriceIdForTier(plan.tier);

  let seatItemId = office.seatItemId;
  if (seatItemId) {
    // Update BOTH price and quantity: the tier (hence flat rate) may have changed.
    await stripe.subscriptionItems.update(seatItemId, {
      price: seatPriceId,
      quantity,
    });
  } else {
    const item = await stripe.subscriptionItems.create({
      subscription: office.stripeSubscriptionId,
      price: seatPriceId,
      quantity,
    });
    await storage.updateOffice(office.id, { seatItemId: item.id });
    seatItemId = item.id;
  }

  // The optional dashboard's price is tied to the office's CURRENT tier, so a seat
  // change that moves tiers must re-tier the dashboard too (no-op if not active).
  await retierDashboard({ ...office, seatItemId }, plan.tier);

  return seatItemId;
}

// Re-price the dashboard line to the given tier's rate. No-op when the office has
// no dashboard add-on (managerItemId unset) — the dashboard is fully optional.
async function retierDashboard(office: Office, tier: SelfServeTier): Promise<void> {
  if (!office.managerItemId) return;
  const stripe = getStripe();
  await stripe.subscriptionItems.update(office.managerItemId, {
    price: dashboardPriceIdForTier(tier),
    quantity: 1,
  });
}

// Add the optional Manager Dashboard line to an existing subscription, priced at
// the office's current tier. Idempotent: returns the existing item id if already
// present. The dashboard grants no personal training access — a manager who wants
// to practice must still buy a normal consultant seat (see /api/billing/manager-seat).
export async function addDashboard(office: Office): Promise<string> {
  if (office.managerItemId) return office.managerItemId;
  if (!office.stripeSubscriptionId) {
    throw new Error("Office has no active subscription to attach the dashboard to");
  }
  const stripe = getStripe();
  const tier = (planForSeatCount(office.activeSeatCount ?? 0) ?? PLAN_TIERS[0]).tier;
  const item = await stripe.subscriptionItems.create({
    subscription: office.stripeSubscriptionId,
    price: dashboardPriceIdForTier(tier),
    quantity: 1,
  });
  await storage.updateOffice(office.id, { managerItemId: item.id });
  return item.id;
}

// Remove the optional dashboard line so the office runs seats-only ($0 dashboard).
// Idempotent: a no-op if the office has no dashboard add-on.
export async function removeDashboard(office: Office): Promise<void> {
  if (!office.managerItemId) return;
  const stripe = getStripe();
  await stripe.subscriptionItems.del(office.managerItemId);
  await storage.updateOffice(office.id, { managerItemId: null });
}

// Reconcile the DB office row from the authoritative Stripe subscription object.
// Called by webhooks after re-fetching the subscription (never trusting the raw
// event payload). Maps line items back to our manager/seat item ids + seat count.
export async function syncOfficeFromSubscription(
  office: Office,
  subscription: Stripe.Subscription,
): Promise<void> {
  const patch: Partial<Office> = {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
  };

  // Classify each line by its price id against ANY tier's seat/dashboard prices,
  // so an item is recognised regardless of which tier it is currently priced at.
  for (const item of subscription.items.data) {
    const priceId = item.price.id;
    if (isDashboardPriceId(priceId)) {
      patch.managerItemId = item.id;
    } else if (isSeatPriceId(priceId)) {
      patch.seatItemId = item.id;
      patch.activeSeatCount = item.quantity ?? 0;
    }
  }

  await storage.updateOffice(office.id, patch);
}

// Resolve the office a Stripe object belongs to, trying the fields most likely to
// be populated in order. customerId is set as soon as we create the customer.
export async function resolveOffice(opts: {
  officeId?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<Office | undefined> {
  if (opts.officeId) {
    const byId = await storage.getOffice(Number(opts.officeId));
    if (byId) return byId;
  }
  if (opts.subscriptionId) {
    const bySub = await storage.getOfficeByStripeSubscriptionId(opts.subscriptionId);
    if (bySub) return bySub;
  }
  if (opts.customerId) {
    const byCust = await storage.getOfficeByStripeCustomerId(opts.customerId);
    if (byCust) return byCust;
  }
  return undefined;
}

// Handle a verified Stripe event. Idempotent: a redelivered event whose id we've
// already recorded is skipped. Always re-fetches the subscription for the source
// of truth rather than trusting the event payload's embedded object.
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const already = await storage.getBillingEventByStripeId(event.id);
  if (already) return;

  const stripe = getStripe();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const office = await resolveOffice({
        officeId: session.client_reference_id,
        customerId: typeof session.customer === "string" ? session.customer : session.customer?.id,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id,
      });
      if (office && session.subscription) {
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subId);
        await syncOfficeFromSubscription(office, subscription);
      }
      break;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const office = await resolveOffice({
        officeId: typeof sub.metadata?.officeId === "string" ? sub.metadata.officeId : null,
        subscriptionId: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      });
      if (office) {
        // Re-fetch for the authoritative current state.
        const fresh = await stripe.subscriptions.retrieve(sub.id);
        await syncOfficeFromSubscription(office, fresh);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const office = await resolveOffice({
        subscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id,
        customerId: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
      });
      if (office) {
        // Immediate lockout — no grace period. Stripe's own retries may continue;
        // access restores automatically on the next invoice.paid / subscription.updated.
        await storage.updateOffice(office.id, { subscriptionStatus: "past_due" });
      }
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
      const office = await resolveOffice({
        subscriptionId: subId,
        customerId: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
      });
      if (office && subId) {
        const subscription = await stripe.subscriptions.retrieve(subId);
        await syncOfficeFromSubscription(office, subscription);
      }
      break;
    }

    default:
      break;
  }

  await storage.recordBillingEvent({
    stripeEventId: event.id,
    eventType: event.type,
    officeId: null,
    payloadSummary: JSON.stringify({ type: event.type, id: event.id }),
    createdAt: new Date().toISOString(),
  });
}
