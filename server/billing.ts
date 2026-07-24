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
  isAnnualDashboardDiscountConfigured,
  STRIPE_DASHBOARD_ANNUAL_COUPON_ID,
} from "./stripe";
import { generateUniqueInviteCode } from "./invite";
import { sendPaidWelcomeEmail, sendPaidCheckoutAdminNotification } from "./notifications";

// --- Pricing model: flat-per-tier (Pricing v2) ------------------------------
// The tier constants and helpers live in shared/pricing.ts so the client and
// server share one source of truth. Re-exported here so existing server imports
// (`from "./billing"`) keep working unchanged.
export {
  PLAN_TIERS,
  ENTERPRISE_MIN_SEATS,
  isEnterpriseSeatCount,
  planForSeatCount,
} from "@shared/pricing";
export type { SelfServeTier, PlanTier } from "@shared/pricing";

import {
  PLAN_TIERS,
  isEnterpriseSeatCount,
  planForSeatCount,
} from "@shared/pricing";
import type { SelfServeTier } from "@shared/pricing";

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
    success_url: `${APP_URL}/#/command-center?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/#/command-center?checkout=cancelled`,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

// Self-serve office signup (item 4). Unlike createManagerCheckoutSession this runs
// BEFORE any office row exists: a prospect coming from the welcome-email setup page
// picks an office name, a consultant count, and whether they want the Manager
// Dashboard, then pays. The office is provisioned by the webhook on
// checkout.session.completed (item 5), never here. All provisioning inputs ride on
// subscription metadata so the webhook can create the office from the authoritative
// Stripe object even if the browser never returns.
export interface SelfServeCheckoutInput {
  officeName: string;
  seatCount: number; // number of consultant seats to bill from day one
  includeDashboard: boolean;
  email?: string; // prospect email, prefills the Stripe customer + receipt
  setupToken?: string; // originating office_setup_token, marked used on provision
  contactId?: number; // originating lead, if any
  signupId?: number; // originating office_signups row; provisioning reads it to create the manager user
  annual?: boolean; // annual prepay: apply the 20%-off-dashboard coupon (dashboard only)
}

export async function createSelfServeCheckoutSession(
  input: SelfServeCheckoutInput,
): Promise<string> {
  const { officeName, seatCount, includeDashboard, email, setupToken, contactId, signupId, annual = false } = input;
  if (isEnterpriseSeatCount(seatCount)) {
    throw new EnterpriseQuoteRequiredError(seatCount);
  }
  const plan = planForSeatCount(seatCount);
  if (!plan || seatCount < 1) {
    throw new Error(`Invalid seat count for self-serve checkout: ${seatCount}`);
  }
  const stripe = getStripe();

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: seatPriceIdForTier(plan.tier), quantity: seatCount },
  ];
  if (includeDashboard) {
    lineItems.push({ price: dashboardPriceIdForTier(plan.tier), quantity: 1 });
  }

  // Annual prepay applies an extra 20% off the DASHBOARD ONLY. It is only meaningful
  // when the dashboard is included, and only when the coupon is configured. The
  // coupon is scoped in Stripe to the dashboard product (applies_to.products), so
  // even attached at the session level it can only reduce the dashboard line — the
  // seat line always bills at its normal per-seat monthly rate, never discounted.
  const applyAnnualDashboardDiscount =
    annual && includeDashboard && isAnnualDashboardDiscountConfigured();

  // Metadata the webhook reads to provision the office. selfServe flags THIS flow
  // so the webhook does not confuse it with an existing-office manager checkout.
  const provisioning: Record<string, string> = {
    selfServe: "true",
    officeName,
    seatCount: String(seatCount),
    dashboard: includeDashboard ? "true" : "false",
  };
  if (email) provisioning.email = email;
  if (setupToken) provisioning.setupToken = setupToken;
  if (contactId != null) provisioning.contactId = String(contactId);
  if (applyAnnualDashboardDiscount) provisioning.annual = "true";
  // Only the signup row ID rides on Stripe metadata, never the manager's chosen
  // password. Provisioning reads the row from our DB to create the manager login.
  if (signupId != null) provisioning.signupId = String(signupId);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    ...(email ? { customer_email: email } : {}),
    line_items: lineItems,
    ...(applyAnnualDashboardDiscount
      ? { discounts: [{ coupon: STRIPE_DASHBOARD_ANNUAL_COUPON_ID }] }
      : {}),
    metadata: provisioning,
    subscription_data: { metadata: provisioning },
    success_url: `${APP_URL}/#/office-setup/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/#/office-setup/${setupToken ?? ""}?checkout=cancelled`,
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
    return_url: `${APP_URL}/#/command-center`,
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

// Provision a brand-new office from a completed self-serve checkout (item 5).
// Idempotent by subscription id: if an office already exists for this subscription
// (webhook redelivery, or the customer.subscription.* event racing the checkout
// event) it is a no-op. Creates the office ACTIVE, mints an invite code, records
// the paid signup for the admin Vault, and best-effort emails the buyer + admin.
export async function provisionSelfServeOffice(
  session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
): Promise<Office | undefined> {
  const meta = { ...(subscription.metadata ?? {}), ...(session.metadata ?? {}) };
  if (meta.selfServe !== "true") return undefined;

  const existing = await storage.getOfficeByStripeSubscriptionId(subscription.id);
  if (existing) return existing;

  const officeName = (meta.officeName ?? "").trim() || "New Office";
  const seatCount = Number.parseInt(meta.seatCount ?? "0", 10) || 0;
  const dashboard = meta.dashboard === "true";
  const email =
    meta.email ||
    (typeof session.customer_details?.email === "string" ? session.customer_details.email : "") ||
    (typeof session.customer_email === "string" ? session.customer_email : "");
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null;

  const inviteCode = await generateUniqueInviteCode();
  const office = await storage.createOffice({
    name: await uniqueOfficeName(officeName),
    inviteCode,
    createdAt: new Date().toISOString(),
    status: "active",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
  });

  // Map seat/dashboard line items back onto the office (item ids + seat count).
  await syncOfficeFromSubscription(office, subscription);

  // Create the manager login from the originating signup row (item 5). The row
  // holds the buyer's chosen credentials (never sent to Stripe); we read it back
  // here (inside the payment webhook) so the office and its manager only ever
  // come into being on a confirmed payment. Skipped when no signupId is present
  // (e.g. the older welcome-email setup-token flow, which has no pre-chosen login).
  const signupId = meta.signupId ? Number.parseInt(meta.signupId, 10) : NaN;
  if (Number.isInteger(signupId)) {
    const signup = await storage.getOfficeSignup(signupId);
    if (signup && signup.username && signup.password) {
      const username = await uniqueUsername(signup.username);
      await storage.createUser({
        officeId: office.id,
        username,
        password: signup.password,
        role: "manager",
        displayName: (signup.managerName ?? "").trim() || username,
        currentLevel: "beginner",
      });
      // Consume the credentials so the plaintext password does not linger.
      await storage.updateOfficeSignup(signup.id, { password: null, code: null, codeExpiresAt: null });
    }
  }

  // Mark the originating setup token used so its link cannot be reused.
  if (meta.setupToken) {
    const token = await storage.getOfficeSetupToken(meta.setupToken);
    if (token && !token.usedAt) {
      await storage.updateOfficeSetupToken(token.id, { usedAt: new Date().toISOString() });
    }
  }

  // Persistent admin Vault record of the signup (item 7).
  await storage.createPaidOfficeSignup({
    officeId: office.id,
    officeName: office.name,
    seatCount,
    dashboard,
    stripeSubscriptionId: subscription.id,
    contactEmail: email || null,
    createdAt: new Date().toISOString(),
  });

  // Best-effort notifications (never block provisioning).
  const details = {
    officeName: office.name,
    inviteCode,
    seatCount,
    dashboard,
    stripeSubscriptionId: subscription.id,
    contactEmail: email || null,
  };
  if (email) {
    void sendPaidWelcomeEmail(email, details);
  }
  void sendPaidCheckoutAdminNotification(details);

  return office;
}

// Keep office names distinguishable in the admin view when two buyers pick the
// same name. The invite code is the real unique key; this only appends a numeric
// suffix so the Vault list is readable.
async function uniqueOfficeName(name: string): Promise<string> {
  const all = await storage.listOffices();
  const taken = new Set(all.map((o) => o.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} (${Date.now()})`;
}

// The username is globally unique. A buyer's chosen manager username may already
// be taken by another office's user, so append a numeric suffix until it is free
// rather than failing the whole (already-paid) provisioning.
async function uniqueUsername(desired: string): Promise<string> {
  const base = desired.trim();
  if (!(await storage.getUserByUsername(base))) return base;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}${n}`;
    if (!(await storage.getUserByUsername(candidate))) return candidate;
  }
  return `${base}${Date.now()}`;
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
      const subId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      // Every checkout we create is subscription-mode, so no subscription means
      // there is nothing to provision or sync.
      if (!subId) break;
      // Re-fetch the subscription as the source of truth (see the note on this
      // function) rather than trusting the event payload. Its metadata is the
      // authoritative signal for whether this is a self-serve signup: we stamp
      // selfServe onto both the session AND the subscription at Checkout creation
      // (createSelfServeCheckoutSession), and the subscription copy survives even
      // if the session's metadata is ever dropped. We deliberately do NOT infer
      // self-serve from the absence of client_reference_id: that was a fragile
      // proxy that would misclassify any future subscription checkout added
      // without a client_reference_id, and it is unnecessary now that provisioning
      // keys off explicit metadata.
      const subscription = await stripe.subscriptions.retrieve(subId);
      const isSelfServe =
        subscription.metadata?.selfServe === "true" || session.metadata?.selfServe === "true";
      if (isSelfServe) {
        await provisionSelfServeOffice(session, subscription);
        break;
      }
      // Existing-office manager checkout: locate the office and sync it. The
      // client_reference_id is the office id we set in createManagerCheckoutSession.
      const office = await resolveOffice({
        officeId: session.client_reference_id,
        customerId: typeof session.customer === "string" ? session.customer : session.customer?.id,
        subscriptionId: subId,
      });
      if (office) {
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
