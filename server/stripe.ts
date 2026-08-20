import Stripe from "stripe";

// Central Stripe configuration. All billing code imports the client and env
// helpers from here so there is a single place that knows about keys/price IDs.
//
// Locked pricing: consultant seats are Team (1-5, $129), Office (6-15, $115),
// and Company (16-21, $99), all per person/month. Command Center is included
// with every current tier. Enterprise begins at 22 seats and has no self-serve
// Stripe Price. Legacy dashboard IDs remain only to classify historical items.
// Evaluation pricing uses the configured 3-5 base and additional-participant
// Price IDs; the internal 1-2 participant rate is authored server-side in Checkout.
//
// No secrets are committed. In every environment these come from process.env:
//   STRIPE_SECRET_KEY                              Stripe secret key
//   STRIPE_WEBHOOK_SECRET                          Checkout webhook secret
//   STRIPE_SEAT_TEAM_PRICE_ID                      Team seat price
//   STRIPE_SEAT_OFFICE_PRICE_ID                    Office seat price
//   STRIPE_SEAT_COMPANY_PRICE_ID                   Company seat price
//   STRIPE_EVALUATION_BASE_PRICE_ID                $249 3-5 participant price
//   STRIPE_EVALUATION_ADDITIONAL_PARTICIPANT_PRICE_ID  $50 participant price
//   APP_URL                                        base URL for Checkout redirects
import type { SelfServeTier } from "@shared/pricing";

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
export const APP_URL = process.env.APP_URL ?? "http://localhost:5000";

const SEAT_PRICE_ID_BY_TIER: Record<SelfServeTier, string> = {
  team: process.env.STRIPE_SEAT_TEAM_PRICE_ID ?? "",
  office: process.env.STRIPE_SEAT_OFFICE_PRICE_ID ?? "",
  company: process.env.STRIPE_SEAT_COMPANY_PRICE_ID ?? "",
};

// Retained only for legacy subscriptions already carrying a dashboard item. New
// checkout paths do not use these prices because Command Center is included.
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

// One-time 14-Day Team Evaluation prices. The hidden 1–2 participant tier uses
// server-authored Checkout price_data; these ids cover the public 3–5 base and
// each additional participant.
export const STRIPE_EVALUATION_BASE_PRICE_ID = process.env.STRIPE_EVALUATION_BASE_PRICE_ID ?? "";
export const STRIPE_EVALUATION_ADDITIONAL_PARTICIPANT_PRICE_ID =
  process.env.STRIPE_EVALUATION_ADDITIONAL_PARTICIPANT_PRICE_ID ?? "";

export function assertStripePriceId(priceId: string, name: string): string {
  if (!priceId) throw new Error(`Stripe configuration is missing ${name}.`);
  return priceId;
}

// Reverse lookup: is this price id one of our seat / dashboard prices? Used by the
// webhook sync to classify subscription items regardless of which tier they're at.
export function isSeatPriceId(priceId: string): boolean {
  return priceId !== "" && Object.values(SEAT_PRICE_ID_BY_TIER).includes(priceId);
}
export function isDashboardPriceId(priceId: string): boolean {
  return priceId !== "" && Object.values(DASHBOARD_PRICE_ID_BY_TIER).includes(priceId);
}

let _stripe: Stripe | null = null;

// Billing is only wired up when a secret key is present. Everywhere billing is
// optional, callers check isStripeConfigured() first and degrade gracefully so
// the app still boots (and demo accounts still work) without Stripe credentials.
// It is also true once a test has injected a client, so "configured" always
// means the same thing as "getStripe() will work".
export function isStripeConfigured(): boolean {
  return _stripe !== null || STRIPE_SECRET_KEY.length > 0;
}

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
