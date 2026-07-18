// Shared pricing model (Pricing v2, flat-per-tier). Pure data + helpers with no
// server or Stripe dependencies so both the client (office setup page) and the
// server (billing) import the SAME source of truth for tiers and rates. Crossing a
// tier boundary re-prices EVERY seat at the new flat rate (not graduated billing).
// Enterprise (36+) is a custom quote with no self-serve price.
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

// Contact address for the Enterprise custom-quote path.
export const ENTERPRISE_CONTACT_EMAIL = "hello@solveframework.com";

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
