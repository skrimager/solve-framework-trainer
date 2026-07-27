import type Stripe from "stripe";
import { storage } from "./storage";
import { getStripe, APP_URL } from "./stripe";

// One-time ($4.99) purchase of a single individual demo practice session.
//
// This is a NEW payment mode for the app and is deliberately kept apart from
// server/billing.ts, which is entirely subscription-mode and tied to an Office
// row. A demo visitor is anonymous: email + device fingerprint only, no login,
// no office, no seat. So nothing here creates a Stripe Customer, touches a
// subscription, or imports from billing.ts, and nothing in billing.ts knows
// this file exists. The two only share the Stripe client and the single webhook
// endpoint (see handleDemoPaymentEvent).
//
// The purchase itself lives in demo_paid_sessions: one row per Checkout Session,
// pending -> paid -> consumed. The Checkout Session id is the idempotency key
// for confirming payment, and a consumed row links to the demo_sessions row it
// funded. See shared/schema.ts.
//
// Environment: this module reads nothing beyond what stripe.ts already exports.
// It works with whichever key is configured in STRIPE_SECRET_KEY (test or live)
// and never inspects, chooses or changes that key.

// Single source of truth for the price. The client's display copy in
// client/src/lib/demoPaywall.ts cross-references this constant.
export const DEMO_SESSION_PRICE_CENTS = 499;

// Stamped on the Checkout Session's metadata so the webhook can tell a demo
// purchase apart from an office subscription checkout with no ambiguity.
export const DEMO_PAID_SESSION_KIND = "demo_paid_session";

// Shown to the buyer on the Stripe Checkout page and on their receipt.
const DEMO_SESSION_PRODUCT_NAME = "SOLVE Framework Individual Practice Session";

// Idempotency keys for demo payments are namespaced before being written to
// billing_events. Both webhook handlers run for every delivery, and they each
// guard on their own recorded key, so neither can swallow an event the other
// still needs to process.
const DEMO_EVENT_KEY_PREFIX = "demo_paid_session:";

// Create the Checkout Session for one paid practice session, and record the
// pending purchase. mode is "payment" (one-time), NOT "subscription": this is
// the critical difference from every checkout helper in billing.ts.
//
// The Stripe session is created FIRST so the demo_paid_sessions row can be
// written with the real Checkout Session id, rather than a placeholder that
// would need patching later. Callers guard with isStripeConfigured() at the
// route boundary, matching the existing billing convention.
export async function createDemoSessionCheckout(args: {
  signupId: number;
  email: string;
}): Promise<string> {
  const { signupId, email } = args;
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    // An anonymous one-off purchase needs no persistent Stripe Customer; the
    // email is only here so Stripe can send the receipt.
    customer_email: email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: DEMO_SESSION_PRODUCT_NAME },
          unit_amount: DEMO_SESSION_PRICE_CENTS,
        },
        quantity: 1,
      },
    ],
    metadata: { demoSignupId: String(signupId), email, kind: DEMO_PAID_SESSION_KIND },
    // Success lands on the demo's welcome screen, not straight into a session:
    // the visitor starts the session they bought through the normal flow, which
    // now sees an available credit.
    success_url: `${APP_URL}/#/demo?paid=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/#/demo?paid=cancelled`,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");

  await storage.createDemoPaidSession({
    signupId,
    email,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: null,
    amountTotal: DEMO_SESSION_PRICE_CENTS,
    status: "pending",
    createdAt: new Date().toISOString(),
    paidAt: null,
    consumedAt: null,
    consumedByDemoSessionId: null,
  });

  return session.url;
}

// The demo payments half of the Stripe webhook, called alongside (and entirely
// independently of) billing.handleStripeEvent for every verified delivery. A
// bug in either handler cannot affect the other, and each no-ops on events it
// does not own.
//
// Idempotent: the processed event id is recorded in billing_events under this
// module's own namespaced key, so a redelivery of the same event credits the
// session exactly once. The namespace matters: billing.ts records the bare
// event id for the same delivery, and if both handlers shared one key the
// second to run would skip an event it had never processed.
export async function handleDemoPaymentEvent(event: Stripe.Event): Promise<void> {
  if (event.type !== "checkout.session.completed") return;

  // Cheap filter on the raw payload so an office subscription checkout costs no
  // Stripe round trip here. The authoritative re-check is below.
  const raw = event.data.object as Stripe.Checkout.Session;
  if (raw.metadata?.kind !== DEMO_PAID_SESSION_KIND) return;

  const eventKey = `${DEMO_EVENT_KEY_PREFIX}${event.id}`;
  if (await storage.getBillingEventByStripeId(eventKey)) return;

  // Re-fetch as the source of truth rather than trusting the event payload,
  // matching the convention in billing.ts.
  const session = await getStripe().checkout.sessions.retrieve(raw.id);
  if (session.metadata?.kind !== DEMO_PAID_SESSION_KIND) return;

  const purchase = await storage.getDemoPaidSessionByStripeCheckoutSessionId(session.id);
  if (!purchase) {
    // Defensive: the row is written before the visitor is ever handed the
    // Checkout URL, so this should not happen.
    console.error(`No demo_paid_sessions row for Checkout Session ${session.id}`);
    return;
  }

  // Only a pending purchase can become paid. This keeps a second event for the
  // same Checkout Session (a different event id, so the guard above misses it)
  // from resurrecting a credit that has already been consumed.
  if (session.payment_status === "paid" && purchase.status === "pending") {
    await storage.updateDemoPaidSession(purchase.id, {
      status: "paid",
      paidAt: new Date().toISOString(),
      stripePaymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
    });
  }

  await storage.recordBillingEvent({
    stripeEventId: eventKey,
    eventType: event.type,
    officeId: null,
    payloadSummary: JSON.stringify({ type: event.type, id: event.id, demoPaidSessionId: purchase.id }),
    createdAt: new Date().toISOString(),
  });
}

// How many confirmed, unconsumed session credits this signup holds. Read by the
// session-start route to decide whether a visitor may begin a session after the
// free-session cap is reached.
export async function availablePaidSessionCredits(signupId: number): Promise<number> {
  const purchases = await storage.listDemoPaidSessionsBySignup(signupId);
  return purchases.filter((p) => p.status === "paid").length;
}

// Claim the oldest (FIFO) confirmed credit for the demo session just created and
// stamp the link both ways: the credit records which session spent it, and the
// session records which credit funded it (demo_sessions.paidSessionId, what the
// voice gate reads).
//
// Returns false when no credit was available. Callers must treat false as "this
// request should not have got here" and fail safe rather than granting a free
// session: the claim is a single conditional update, so it is the atomic
// re-verification of the credit check done earlier in the request.
export async function consumeOldestPaidCredit(
  signupId: number,
  demoSessionId: number,
): Promise<boolean> {
  const claimed = await storage.claimOldestPaidDemoSession(signupId, demoSessionId);
  if (!claimed) return false;
  await storage.updateDemoSession(demoSessionId, { paidSessionId: claimed.id });
  return true;
}
