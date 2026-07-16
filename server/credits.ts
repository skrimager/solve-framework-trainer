// ===========================================================================
// SOLVE Success Investment credits + Academy ranks.
//
// Four sequential Academy levels, each worth a flat $50 ($5,000-cent) credit to
// the consultant's office, capping a consultant's lifetime credit at $200. The
// raw qualifying criteria are keyed off the per-industry certification data (see
// industry_certifications): how many DISTINCT verticals a consultant has
// certified in, per track.
//
//   Level 1  "SOLVE Certified Consultant"          consulting cert in >= 1 vertical
//   Level 2  "Conflict Management Certified"        leadership cert in >= 1 vertical
//   Level 3  "Cross-Industry Certified"             consulting cert in >= 3 verticals
//   Level 4  "Master SOLVE Academy Consultant"      leadership cert in >= 3 verticals
//
// Levels are earned STRICTLY in sequence (1 before 2 before 3 before 4). If a
// consultant's practice pattern satisfies a later level's raw criteria before an
// earlier one, the later level is NOT awarded out of order: only the next level
// in sequence they qualify for is awarded, and every certification event
// re-checks whether earlier missed levels are now also satisfied (awarding them
// too, in order, in the same pass). Conflict-Management (leadership) certs never
// count toward Level 3's three-industry consulting total, and vice versa for
// Level 4. This module holds only pure logic so the sequencing is unit-testable.
// ===========================================================================

// Flat credit amount, in cents, earned per Academy level.
export const CREDIT_AMOUNT_CENTS = 5000;

// The four levels, in ascending order.
export const ACADEMY_LEVELS = [1, 2, 3, 4] as const;
export type AcademyLevel = (typeof ACADEMY_LEVELS)[number];

// Maximum lifetime credit per consultant (4 levels x $50).
export const MAX_CREDIT_CENTS = CREDIT_AMOUNT_CENTS * ACADEMY_LEVELS.length;

// How many distinct verticals Level 3 (consulting) and Level 4 (leadership)
// require. Levels 1 and 2 require just one.
export const CROSS_INDUSTRY_THRESHOLD = 3;

// A consultant's paid seat must have been active for at least this many days
// before they can earn credits (ToS: "Credits are earned only by consultants on
// seats active for at least 60 days").
export const SEAT_CREDIT_ELIGIBILITY_DAYS = 60;

// The permanent Apptix demo office (production office id 8, billing bypass). It
// is not a real paying customer, so it never accrues real-dollar credits.
export const APPTIX_DEMO_OFFICE_ID = 8;

// Display label for each level's rank/badge, shown on the rep profile and the
// dashboards. Level 1/2 read as titles, Level 3/4 read as badges per the ticket.
export const LEVEL_LABELS: Record<AcademyLevel, string> = {
  1: "SOLVE Certified Consultant",
  2: "Conflict Management Certified",
  3: "Cross-Industry Certified",
  4: "Master SOLVE Academy Consultant",
};

export type LevelDefinition = {
  level: AcademyLevel;
  label: string;
  amountCents: number;
  track: "consulting" | "leadership";
  requiredVerticals: number;
};

export const LEVEL_DEFINITIONS: LevelDefinition[] = [
  { level: 1, label: LEVEL_LABELS[1], amountCents: CREDIT_AMOUNT_CENTS, track: "consulting", requiredVerticals: 1 },
  { level: 2, label: LEVEL_LABELS[2], amountCents: CREDIT_AMOUNT_CENTS, track: "leadership", requiredVerticals: 1 },
  { level: 3, label: LEVEL_LABELS[3], amountCents: CREDIT_AMOUNT_CENTS, track: "consulting", requiredVerticals: CROSS_INDUSTRY_THRESHOLD },
  { level: 4, label: LEVEL_LABELS[4], amountCents: CREDIT_AMOUNT_CENTS, track: "leadership", requiredVerticals: CROSS_INDUSTRY_THRESHOLD },
];

// Whether a level's RAW criteria are met given the distinct certified-vertical
// counts per track. Sequencing is applied separately in computeAwardableLevels.
export function levelCriteriaMet(
  level: AcademyLevel,
  consultingCertifiedVerticals: number,
  leadershipCertifiedVerticals: number,
): boolean {
  switch (level) {
    case 1:
      return consultingCertifiedVerticals >= 1;
    case 2:
      return leadershipCertifiedVerticals >= 1;
    case 3:
      return consultingCertifiedVerticals >= CROSS_INDUSTRY_THRESHOLD;
    case 4:
      return leadershipCertifiedVerticals >= CROSS_INDUSTRY_THRESHOLD;
  }
}

export type AwardableInput = {
  // Distinct DISTINCT consulting verticals the consultant is certified in.
  consultingCertifiedVerticals: number;
  // Distinct leadership verticals the consultant is certified in.
  leadershipCertifiedVerticals: number;
  // Levels already awarded to this consultant (from the academy_credits ledger).
  alreadyAwarded: Iterable<number>;
};

// The heart of the feature: given current distinct certified-vertical counts and
// the levels already awarded, returns the list of NEW levels to award, in
// ascending order, honoring strict sequencing.
//
// Walk levels 1..4 in order. Skip a level already awarded. For an un-awarded
// level, it can only be considered once every earlier level has been awarded
// (previously or earlier in this same pass). This is what forbids awarding a
// later level out of order. If that next-in-sequence level's raw criteria are
// met, award it (and continue, so a single pass can catch up multiple missed
// levels); if they are not met, stop (a gap in the sequence blocks everything
// above it).
export function computeAwardableLevels(input: AwardableInput): AcademyLevel[] {
  const awarded = new Set<number>(input.alreadyAwarded);
  const toAward: AcademyLevel[] = [];
  for (const level of ACADEMY_LEVELS) {
    if (awarded.has(level)) continue;
    // Enforce sequence: the immediately-preceding level must already be earned
    // (or have just been queued in this pass) before this one can be considered.
    if (level > 1 && !awarded.has(level - 1)) break;
    if (levelCriteriaMet(level, input.consultingCertifiedVerticals, input.leadershipCertifiedVerticals)) {
      toAward.push(level);
      awarded.add(level);
    } else {
      break;
    }
  }
  return toAward;
}

// Whether a seat that first went active at `seatActivatedAt` has been active for
// at least SEAT_CREDIT_ELIGIBILITY_DAYS as of `now`. A null/absent activation
// timestamp is treated as not-yet-eligible (conservative: no credit until we can
// prove the 60-day tenure).
export function isSeatCreditEligible(seatActivatedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!seatActivatedAt) return false;
  const activated = new Date(seatActivatedAt);
  if (Number.isNaN(activated.getTime())) return false;
  const elapsedMs = now.getTime() - activated.getTime();
  const requiredMs = SEAT_CREDIT_ELIGIBILITY_DAYS * 24 * 60 * 60 * 1000;
  return elapsedMs >= requiredMs;
}

// Whether an office is allowed to accrue real-dollar credits. The Apptix demo
// office (id 8) is excluded.
export function officeEarnsCredits(officeId: number): boolean {
  return officeId !== APPTIX_DEMO_OFFICE_ID;
}

// Count DISTINCT certified verticals for one track from a set of per-industry
// certification rows. A row counts only once it has actually reached certified
// (certifiedAt set / currentLevel "certified").
type IndustryCertRow = { track: string; vertical: string; currentLevel: string; certifiedAt: string | null };

export function countDistinctCertifiedVerticals(
  rows: IndustryCertRow[],
  track: "consulting" | "leadership",
): number {
  const verticals = new Set<string>();
  for (const row of rows) {
    if (row.track !== track) continue;
    if (row.currentLevel === "certified" || row.certifiedAt) {
      verticals.add(row.vertical);
    }
  }
  return verticals.size;
}

// Format a cent amount as a whole-dollar string (credits are always $50
// multiples, so no fractional dollars appear). E.g. 5000 -> "$50", 20000 -> "$200".
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
