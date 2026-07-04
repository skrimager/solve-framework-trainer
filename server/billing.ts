import type Stripe from "stripe";
import type { Office } from "@shared/schema";
import { storage } from "./storage";
import {
  getStripe,
  APP_URL,
  MANAGER_DASHBOARD_PRICE_ID,
  CONSULTANT_SEAT_PRICE_ID,
} from "./stripe";

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

// Manager checkout: a subscription-mode Checkout Session containing only the flat
// annual Manager Dashboard line (qty 1). The volume-tiered consultant seat line is
// added lazily on the first seat join, so an office with no consultants yet is not
// billed for zero seats. Access is granted by the webhook, never by the redirect.
export async function createManagerCheckoutSession(office: Office, email?: string): Promise<string> {
  const stripe = getStripe();
  const customerId = await ensureCustomer(office, email);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: String(office.id),
    line_items: [{ price: MANAGER_DASHBOARD_PRICE_ID, quantity: 1 }],
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

// Push an exact seat quantity to Stripe, creating the tiered seat subscription item
// on first use. Returns the seat item id so the caller can persist it. This is the
// single choke point for changing billed seat count (join, remove, manager seat).
export async function setSeatQuantity(office: Office, quantity: number): Promise<string> {
  if (!office.stripeSubscriptionId) {
    throw new Error("Office has no active subscription to attach seats to");
  }
  const stripe = getStripe();

  if (office.seatItemId) {
    await stripe.subscriptionItems.update(office.seatItemId, { quantity });
    return office.seatItemId;
  }

  // First seat: create the tiered seat line on the existing subscription.
  const item = await stripe.subscriptionItems.create({
    subscription: office.stripeSubscriptionId,
    price: CONSULTANT_SEAT_PRICE_ID,
    quantity,
  });
  await storage.updateOffice(office.id, { seatItemId: item.id });
  return item.id;
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

  for (const item of subscription.items.data) {
    const priceId = item.price.id;
    if (priceId === MANAGER_DASHBOARD_PRICE_ID) {
      patch.managerItemId = item.id;
    } else if (priceId === CONSULTANT_SEAT_PRICE_ID) {
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
