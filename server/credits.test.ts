import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ACADEMY_LEVELS,
  CREDIT_AMOUNT_CENTS,
  MAX_CREDIT_CENTS,
  CROSS_INDUSTRY_THRESHOLD,
  SEAT_CREDIT_ELIGIBILITY_DAYS,
  APPTIX_DEMO_OFFICE_ID,
  LEVEL_LABELS,
  levelCriteriaMet,
  computeAwardableLevels,
  isSeatCreditEligible,
  officeEarnsCredits,
  countDistinctCertifiedVerticals,
  formatCents,
} from "./credits";

// ---------------------------------------------------------------------------
// Level definitions / constants
// ---------------------------------------------------------------------------

describe("academy level constants", () => {
  test("four levels worth $50 each cap at $200", () => {
    assert.deepEqual(ACADEMY_LEVELS, [1, 2, 3, 4]);
    assert.equal(CREDIT_AMOUNT_CENTS, 5000);
    assert.equal(MAX_CREDIT_CENTS, 20000);
  });

  test("exact labels from the ticket", () => {
    assert.equal(LEVEL_LABELS[1], "SOLVE Certified Consultant");
    assert.equal(LEVEL_LABELS[2], "Conflict Management Certified");
    assert.equal(LEVEL_LABELS[3], "Cross-Industry Certified");
    assert.equal(LEVEL_LABELS[4], "Master SOLVE Academy Consultant");
  });
});

// ---------------------------------------------------------------------------
// Raw criteria (before sequencing)
// ---------------------------------------------------------------------------

describe("levelCriteriaMet", () => {
  test("L1 needs one consulting vertical", () => {
    assert.equal(levelCriteriaMet(1, 0, 0), false);
    assert.equal(levelCriteriaMet(1, 1, 0), true);
  });
  test("L2 needs one leadership vertical", () => {
    assert.equal(levelCriteriaMet(2, 5, 0), false);
    assert.equal(levelCriteriaMet(2, 0, 1), true);
  });
  test("L3 needs three consulting verticals (leadership never counts)", () => {
    assert.equal(levelCriteriaMet(3, 2, 9), false);
    assert.equal(levelCriteriaMet(3, CROSS_INDUSTRY_THRESHOLD, 0), true);
  });
  test("L4 needs three leadership verticals (consulting never counts)", () => {
    assert.equal(levelCriteriaMet(4, 9, 2), false);
    assert.equal(levelCriteriaMet(4, 0, CROSS_INDUSTRY_THRESHOLD), true);
  });
});

// ---------------------------------------------------------------------------
// Strict-sequence awarding (the heart of the feature)
// ---------------------------------------------------------------------------

describe("computeAwardableLevels (strict sequencing)", () => {
  test("first consulting cert awards only L1", () => {
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 1, leadershipCertifiedVerticals: 0, alreadyAwarded: [] }),
      [1],
    );
  });

  test("does NOT skip ahead: 3 consulting verticals but no leadership yet awards only L1 (L3 blocked by missing L2)", () => {
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 3, leadershipCertifiedVerticals: 0, alreadyAwarded: [] }),
      [1],
    );
  });

  test("catches up multiple missed levels in one pass, in order", () => {
    // Already has L1. Now has 1 leadership + 3 consulting verticals: should get
    // L2 then L3 (in that order) but not L4 (only 1 leadership vertical).
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 3, leadershipCertifiedVerticals: 1, alreadyAwarded: [1] }),
      [2, 3],
    );
  });

  test("fully-qualified consultant with nothing awarded gets all four in order", () => {
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 3, leadershipCertifiedVerticals: 3, alreadyAwarded: [] }),
      [1, 2, 3, 4],
    );
  });

  test("a gap blocks everything above it: L1 awarded, only 1 leadership vertical and 3 consulting -> stops after L3", () => {
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 3, leadershipCertifiedVerticals: 1, alreadyAwarded: [1, 2] }),
      [3],
    );
  });

  test("no double-award: already has all levels", () => {
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 3, leadershipCertifiedVerticals: 3, alreadyAwarded: [1, 2, 3, 4] }),
      [],
    );
  });

  test("L2 not awarded again when already present; L3 unlocked by third consulting vertical", () => {
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 3, leadershipCertifiedVerticals: 1, alreadyAwarded: [1, 2] }),
      [3],
    );
  });

  test("leadership certs never satisfy L3, consulting never satisfies L4", () => {
    // Has L1, L2. 2 consulting + 5 leadership verticals: L3 needs 3 consulting
    // (not met), so nothing new even though leadership is plentiful.
    assert.deepEqual(
      computeAwardableLevels({ consultingCertifiedVerticals: 2, leadershipCertifiedVerticals: 5, alreadyAwarded: [1, 2] }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// 60-day seat tenure gate
// ---------------------------------------------------------------------------

describe("isSeatCreditEligible", () => {
  const now = new Date("2026-03-01T00:00:00.000Z");

  test("null/absent activation is never eligible", () => {
    assert.equal(isSeatCreditEligible(null, now), false);
    assert.equal(isSeatCreditEligible(undefined, now), false);
    assert.equal(isSeatCreditEligible("not-a-date", now), false);
  });

  test("exactly 60 days is eligible", () => {
    const activated = new Date(now.getTime() - SEAT_CREDIT_ELIGIBILITY_DAYS * 24 * 60 * 60 * 1000);
    assert.equal(isSeatCreditEligible(activated.toISOString(), now), true);
  });

  test("59 days is not eligible", () => {
    const activated = new Date(now.getTime() - 59 * 24 * 60 * 60 * 1000);
    assert.equal(isSeatCreditEligible(activated.toISOString(), now), false);
  });
});

// ---------------------------------------------------------------------------
// Office exclusion + distinct-vertical counting + formatting
// ---------------------------------------------------------------------------

describe("officeEarnsCredits", () => {
  test("excludes the Apptix demo office (id 8)", () => {
    assert.equal(officeEarnsCredits(APPTIX_DEMO_OFFICE_ID), false);
    assert.equal(officeEarnsCredits(1), true);
  });
});

describe("countDistinctCertifiedVerticals", () => {
  const rows = [
    { track: "consulting", vertical: "real_estate", currentLevel: "certified", certifiedAt: "2026-01-01" },
    { track: "consulting", vertical: "real_estate", currentLevel: "certified", certifiedAt: "2026-01-02" }, // dup vertical
    { track: "consulting", vertical: "manufactured_housing", currentLevel: "advanced", certifiedAt: null }, // not certified
    { track: "consulting", vertical: "auto", currentLevel: "certified", certifiedAt: null }, // certified via level
    { track: "leadership", vertical: "peer_conflict", currentLevel: "certified", certifiedAt: "2026-01-03" },
  ];

  test("counts distinct certified consulting verticals only", () => {
    assert.equal(countDistinctCertifiedVerticals(rows, "consulting"), 2); // real_estate + auto
  });

  test("counts distinct certified leadership verticals only", () => {
    assert.equal(countDistinctCertifiedVerticals(rows, "leadership"), 1);
  });
});

describe("formatCents", () => {
  test("whole-dollar formatting", () => {
    assert.equal(formatCents(5000), "$50");
    assert.equal(formatCents(20000), "$200");
    assert.equal(formatCents(0), "$0");
  });
});
