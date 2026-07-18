import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { averageScore } from "@shared/scoreStats";

// Covers the all-time running average shown in the rep's "Real Conversations"
// section: the multi-row average, rounding, exclusion of not-yet-scored rows, and
// the empty state (which must be null, not 0/NaN, so the UI shows a clear message).
describe("averageScore (Real Conversation running average)", () => {
  test("averages the overall scores across multiple submissions", () => {
    assert.equal(averageScore([80, 90, 85]), 85);
  });

  test("rounds the average to the nearest whole number", () => {
    // 80 + 81 = 161, / 2 = 80.5, rounds to 81.
    assert.equal(averageScore([80, 81]), 81);
  });

  test("excludes submissions that have no score yet", () => {
    // Only 100 and 50 count: (100 + 50) / 2 = 75.
    assert.equal(averageScore([100, null, 50, undefined]), 75);
  });

  test("returns null for the empty state (no submissions)", () => {
    assert.equal(averageScore([]), null);
  });

  test("returns null when no submission has been scored yet", () => {
    assert.equal(averageScore([null, undefined]), null);
  });
});
