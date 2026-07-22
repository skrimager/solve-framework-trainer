import Stripe from "stripe";

// Central Stripe configuration. All billing code imports the client and env
// helpers from here so there is a single place that knows about keys/price IDs.
//
// Pricing v2 (flat-per-tier): consultant seats and the optional Manager Dashboard
// each have ONE monthly Stripe Price per plan tier (Team / Office / Company).
// Enterprise (36+ seats) is a custom quote with no self-serve Price object. The
// app switches an office's seat item between these prices as its seat count moves
// tiers (see billing.setSeatQuantity). Create the Price objects with
// scripts/stripe-setup.ts and paste the printed ids into these env vars.
//
// No secrets are committed. In every environment these come from process.env:
//   STRIPE_SECRET_KEY                sk_test_... (or sk_live_... in prod)
//   STRIPE_WEBHOOK_SECRET            whsec_...
//   STRIPE_SEAT_TEAM_PRICE_ID        price_... ($49/seat/mo, Team 1-5)
//   STRIPE_SEAT_OFFICE_PRICE_ID      price_... ($45/seat/mo, Office 6-20)
//   STRIPE_SEAT_COMPANY_PRICE_ID     price_... ($41/seat/mo, Company 21-35)
//   STRIPE_DASHBOARD_TEAM_PRICE_ID   price_... ($249/mo optional dashboard, Team)
//   STRIPE_DASHBOARD_OFFICE_PRICE_ID price_... ($389/mo optional dashboard, Office)
//   STRIPE_DASHBOARD_COMPANY_PRICE_ID price_... ($529/mo optional dashboard, Company)
//   STRIPE_DASHBOARD_ANNUAL_COUPON_ID  <coupon_...> optional 20%-off-dashboard annual coupon
//   APP_URL                          base URL for Checkout/Portal redirects
import type { SelfServeTier } from "./billing";

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
export const APP_URL = process.env.APP_URL ?? "http://localhost:5000";

// Optional: the Stripe Coupon id for the annual-prepay dashboard discount (20% off
// the dashboard only). Must be a coupon whose applies_to.products is the Manager
// Dashboard product, so it can only ever reduce the dashboard line, never seats.
// Empty by default: until it is set the annual option is not offered and checkout
// behaves exactly as before. Create the coupon with scripts/stripe-setup.ts.
export const STRIPE_DASHBOARD_ANNUAL_COUPON_ID = process.env.STRIPE_DASHBOARD_ANNUAL_COUPON_ID ?? "";

const SEAT_PRICE_ID_BY_TIER: Record<SelfServeTier, string> = {
  team: process.env.STRIPE_SEAT_TEAM_PRICE_ID ?? "",
  office: process.env.STRIPE_SEAT_OFFICE_PRICE_ID ?? "",
  company: process.env.STRIPE_SEAT_COMPANY_PRICE_ID ?? "",
};

const DASHBOARD_PRICE_ID_BY_TIER: Record<SelfServeTier, string> = {
  team: process.env.STRIPE_DASHBOARD_TEAM_PRICE_ID ?? "",
  office: process.env.STRIPE_DASHBOARD_OFFICE_PRICE_ID ?? "",
  company: process.env.STRIPE_DASHBOARD_COMPANY_PRICE_ID ?? "",
};

// The Stripe Price id for a seat / dashboard subscription item at a given tier.
export function seatPriceIdForTier(tier: SelfServeTier): string {
  return SEAT_PRICE_ID_BY_TIER[tier];
}
export function dashboardPriceIdForTier(tier: SelfServeTier): string {
  return DASHBOARD_PRICE_ID_BY_TIER[tier];
}

// Reverse lookup: is this price id one of our seat / dashboard prices? Used by the
// webhook sync to classify subscription items regardless of which tier they're at.
export function isSeatPriceId(priceId: string): boolean {
  return priceId !== "" && Object.values(SEAT_PRICE_ID_BY_TIER).includes(priceId);
}
export function isDashboardPriceId(priceId: string): boolean {
  return priceId !== "" && Object.values(DASHBOARD_PRICE_ID_BY_TIER).includes(priceId);
}

// Billing is only wired up when a secret key is present. Everywhere billing is
// optional, callers check isStripeConfigured() first and degrade gracefully so
// the app still boots (and demo accounts still work) without Stripe credentials.
export function isStripeConfigured(): boolean {
  return STRIPE_SECRET_KEY.length > 0;
}

// The annual-prepay dashboard discount is only offered when its coupon is wired up.
export function isAnnualDashboardDiscountConfigured(): boolean {
  return STRIPE_DASHBOARD_ANNUAL_COUPON_ID.length > 0;
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
