import Stripe from "stripe";

// Central Stripe configuration. All billing code imports the client and env
// helpers from here so there is a single place that knows about keys/price IDs.
//
// No secrets are committed. In every environment these come from process.env:
//   STRIPE_SECRET_KEY                      sk_test_... (or sk_live_... in prod)
//   STRIPE_WEBHOOK_SECRET                  whsec_...
//   STRIPE_MANAGER_DASHBOARD_PRICE_ID      price_... (annual flat $189, qty 1)
//   STRIPE_CONSULTANT_SEAT_PRICE_ID        price_... (monthly volume-tiered seat)
//   APP_URL                                base URL for Checkout/Portal redirects

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
export const MANAGER_DASHBOARD_PRICE_ID = process.env.STRIPE_MANAGER_DASHBOARD_PRICE_ID ?? "";
export const CONSULTANT_SEAT_PRICE_ID = process.env.STRIPE_CONSULTANT_SEAT_PRICE_ID ?? "";
export const APP_URL = process.env.APP_URL ?? "http://localhost:5000";

// Billing is only wired up when a secret key is present. Everywhere billing is
// optional, callers check isStripeConfigured() first and degrade gracefully so
// the app still boots (and demo accounts still work) without Stripe credentials.
export function isStripeConfigured(): boolean {
  return STRIPE_SECRET_KEY.length > 0;
}

let _stripe: Stripe | null = null;

// Returns the shared Stripe client, or throws if billing isn't configured. Guard
// with isStripeConfigured() at the route/webhook boundary before calling.
export function getStripe(): Stripe {
  if (_stripe) return _stripe; // already created, or injected by tests
  if (!isStripeConfigured()) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY is missing).");
  }
  _stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" });
  return _stripe;
}

// Test seam: unit tests inject a fake Stripe so no network/key is needed.
export function __setStripeForTests(fake: unknown): void {
  _stripe = fake as Stripe;
}
