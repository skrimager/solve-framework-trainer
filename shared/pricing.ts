// Shared product-pricing source of truth. All money is USD cents.
// Pricing is flat-per-tier / volume pricing: every occupied paid seat receives
// the rate of the tier containing the office's total selected seat quantity.

export type SelfServeTier = "team" | "office" | "company";
export type PlanTierName = SelfServeTier | "enterprise";
export type BillingInterval = "month";

export interface PlanTier {
  tier: SelfServeTier;
  displayName: "Team" | "Office" | "Company";
  minSeats: number;
  maxSeats: number;
  seatRateCents: number;
  billingInterval: BillingInterval;
  commandCenterIncluded: true;
  // Compatibility read-model fields for existing internal screens. They are
  // derived from the authoritative cent amount; Command Center has no add-on fee.
  seatRate: number;
  dashboardRate: 0;
}

export const PLAN_TIERS = [
  { tier: "team", displayName: "Team", minSeats: 1, maxSeats: 5, seatRateCents: 12_900, billingInterval: "month", commandCenterIncluded: true, seatRate: 129, dashboardRate: 0 },
  { tier: "office", displayName: "Office", minSeats: 6, maxSeats: 15, seatRateCents: 11_500, billingInterval: "month", commandCenterIncluded: true, seatRate: 115, dashboardRate: 0 },
  { tier: "company", displayName: "Company", minSeats: 16, maxSeats: 21, seatRateCents: 9_900, billingInterval: "month", commandCenterIncluded: true, seatRate: 99, dashboardRate: 0 },
] as const satisfies readonly PlanTier[];

export const ENTERPRISE_MIN_SEATS = 22;
export const ENTERPRISE_CONTACT_EMAIL = "hello@solveframework.com";

export const EVALUATION_PRICING = {
  productName: "14-Day Team Evaluation",
  currency: "usd" as const,
  minParticipants: 1,
  smallTierMaxParticipants: 2,
  smallTierAmountCents: 17_500,
  standardTierMinParticipants: 3,
  includedParticipants: 5,
  standardTierAmountCents: 24_900,
  maxParticipants: 10,
  additionalParticipantAmountCents: 5_000,
  durationDays: 14,
  commandCenterIncluded: true,
} as const;

export interface EvaluationQuote {
  participantCount: number;
  tier: "small" | "standard";
  additionalParticipantCount: number;
  totalAmountCents: number;
}

export function isEnterpriseSeatCount(seatCount: number): boolean {
  return Number.isInteger(seatCount) && seatCount >= ENTERPRISE_MIN_SEATS;
}

export function planForSeatCount(seatCount: number): PlanTier | null {
  if (!Number.isInteger(seatCount) || seatCount < 1 || isEnterpriseSeatCount(seatCount)) return null;
  return PLAN_TIERS.find((tier) => seatCount >= tier.minSeats && seatCount <= tier.maxSeats) ?? null;
}

export function monthlySeatAmountCents(seatCount: number): number | null {
  const plan = planForSeatCount(seatCount);
  return plan ? plan.seatRateCents * seatCount : null;
}

export function validateEvaluationParticipantCount(participantCount: number): void {
  if (!Number.isInteger(participantCount) || participantCount < EVALUATION_PRICING.minParticipants || participantCount > EVALUATION_PRICING.maxParticipants) {
    throw new Error(`Evaluation participants must be an integer from ${EVALUATION_PRICING.minParticipants} to ${EVALUATION_PRICING.maxParticipants}.`);
  }
}

export function quoteEvaluation(participantCount: number): EvaluationQuote {
  validateEvaluationParticipantCount(participantCount);
  if (participantCount <= EVALUATION_PRICING.smallTierMaxParticipants) {
    return { participantCount, tier: "small", additionalParticipantCount: 0, totalAmountCents: EVALUATION_PRICING.smallTierAmountCents };
  }
  const additionalParticipantCount = Math.max(0, participantCount - EVALUATION_PRICING.includedParticipants);
  return {
    participantCount,
    tier: "standard",
    additionalParticipantCount,
    totalAmountCents: EVALUATION_PRICING.standardTierAmountCents + additionalParticipantCount * EVALUATION_PRICING.additionalParticipantAmountCents,
  };
}

// A conversion must retain at least the evaluated participant count and its first
// monthly subscription invoice must cover the recorded one-time evaluation credit.
export function meetsConversionSeatFloor(paidSeatCount: number, evaluationParticipantCount: number): boolean {
  if (!Number.isInteger(paidSeatCount) || !Number.isInteger(evaluationParticipantCount) || paidSeatCount < evaluationParticipantCount) {
    return false;
  }
  const firstInvoiceAmountCents = monthlySeatAmountCents(paidSeatCount);
  return firstInvoiceAmountCents !== null && firstInvoiceAmountCents >= quoteEvaluation(evaluationParticipantCount).totalAmountCents;
}
