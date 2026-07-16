import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePracticeCap,
  sumMonthlyPracticeSeconds,
  resetDate,
  computeDurationSeconds,
  blockedMessage,
  MONTHLY_CAP_MINUTES,
  WARN_THRESHOLD_MINUTES,
} from "./fairUse";
import type { Session } from "@shared/schema";

// Build a minimal session row. Only createdAt + durationSeconds matter to the
// cap math; the rest are filled with valid defaults so the type is satisfied.
function mkSession(partial: Partial<Session> & { id: number; createdAt: string }): Session {
  return {
    userId: 1,
    scenarioId: 1,
    status: "completed",
    transcript: "[]",
    score: 90,
    rubricScores: null,
    feedback: null,
    completedAt: partial.createdAt,
    savedAt: null,
    durationSeconds: null,
    ...partial,
  };
}

const HOUR = 3600;
// A fixed "now" mid-month so month bucketing is unambiguous.
const NOW = new Date("2026-07-16T12:00:00.000Z");

describe("evaluatePracticeCap thresholds (10h cap, 9h warning)", () => {
  test("8.5 hours logged this month: no warning, not blocked", () => {
    const sessions = [
      mkSession({ id: 1, createdAt: "2026-07-02T10:00:00.000Z", durationSeconds: 5 * HOUR }),
      mkSession({ id: 2, createdAt: "2026-07-10T10:00:00.000Z", durationSeconds: Math.round(3.5 * HOUR) }),
    ];
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: false });
    assert.equal(cap.warning, false);
    assert.equal(cap.blocked, false);
    assert.equal(cap.minutesUsed, 8 * 60 + 30);
    assert.equal(cap.minutesRemaining, MONTHLY_CAP_MINUTES - (8 * 60 + 30));
  });

  test("9.2 hours logged this month: warning present, not blocked", () => {
    const sessions = [
      mkSession({ id: 1, createdAt: "2026-07-05T10:00:00.000Z", durationSeconds: Math.round(9.2 * HOUR) }),
    ];
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: false });
    assert.equal(cap.warning, true);
    assert.equal(cap.blocked, false);
    assert.equal(cap.minutesUsed, Math.floor(9.2 * 60));
  });

  test("exactly 9 hours: warning starts here", () => {
    const sessions = [mkSession({ id: 1, createdAt: "2026-07-05T10:00:00.000Z", durationSeconds: 9 * HOUR })];
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: false });
    assert.equal(cap.warning, true);
    assert.equal(cap.blocked, false);
    assert.equal(cap.warnMinutes, WARN_THRESHOLD_MINUTES);
  });

  test("10+ hours logged this month: blocked with correct reset date", () => {
    const sessions = [
      mkSession({ id: 1, createdAt: "2026-07-03T10:00:00.000Z", durationSeconds: 6 * HOUR }),
      mkSession({ id: 2, createdAt: "2026-07-09T10:00:00.000Z", durationSeconds: Math.round(4.5 * HOUR) }),
    ];
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: false });
    assert.equal(cap.blocked, true);
    assert.equal(cap.warning, false);
    assert.equal(cap.minutesRemaining, 0);
    // First of the next calendar month (UTC).
    assert.equal(cap.resetDate, "2026-08-01T00:00:00.000Z");
  });

  test("exactly 10 hours: blocked (cap is inclusive)", () => {
    const sessions = [mkSession({ id: 1, createdAt: "2026-07-05T10:00:00.000Z", durationSeconds: 10 * HOUR })];
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: false });
    assert.equal(cap.blocked, true);
  });
});

describe("month bucketing (unused time never rolls over)", () => {
  test("previous calendar month does not count toward this month", () => {
    const sessions = [
      // 12 hours in June: way over the cap, but must not affect July.
      mkSession({ id: 1, createdAt: "2026-06-20T10:00:00.000Z", durationSeconds: 12 * HOUR }),
      // Only 1 hour in July.
      mkSession({ id: 2, createdAt: "2026-07-02T10:00:00.000Z", durationSeconds: 1 * HOUR }),
    ];
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: false });
    assert.equal(cap.blocked, false);
    assert.equal(cap.warning, false);
    assert.equal(cap.minutesUsed, 60);
  });

  test("sumMonthlyPracticeSeconds excludes prior and next month rows", () => {
    const sessions = [
      mkSession({ id: 1, createdAt: "2026-06-30T23:59:59.000Z", durationSeconds: 5 * HOUR }),
      mkSession({ id: 2, createdAt: "2026-07-01T00:00:00.000Z", durationSeconds: 2 * HOUR }),
      mkSession({ id: 3, createdAt: "2026-07-31T23:59:59.000Z", durationSeconds: 1 * HOUR }),
      mkSession({ id: 4, createdAt: "2026-08-01T00:00:00.000Z", durationSeconds: 4 * HOUR }),
    ];
    assert.equal(sumMonthlyPracticeSeconds(sessions, NOW), 3 * HOUR);
  });

  test("in-progress sessions (null duration) contribute nothing", () => {
    const sessions = [
      mkSession({ id: 1, createdAt: "2026-07-02T10:00:00.000Z", durationSeconds: null, status: "in_progress" }),
      mkSession({ id: 2, createdAt: "2026-07-03T10:00:00.000Z", durationSeconds: 2 * HOUR }),
    ];
    assert.equal(sumMonthlyPracticeSeconds(sessions, NOW), 2 * HOUR);
  });

  test("reset date rolls over the year boundary (Dec to Jan)", () => {
    const dec = new Date("2026-12-10T09:00:00.000Z");
    assert.equal(resetDate(dec), "2027-01-01T00:00:00.000Z");
  });
});

describe("text and voice sessions count equally", () => {
  test("mixed sessions all sum into one monthly total", () => {
    // The sessions table is shared by text and voice attempts, so both are just
    // rows here: five 2-hour sessions total 10 hours and block.
    const sessions = [1, 2, 3, 4, 5].map((id) =>
      mkSession({ id, createdAt: `2026-07-0${id}T10:00:00.000Z`, durationSeconds: 2 * HOUR }),
    );
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: false });
    assert.equal(cap.blocked, true);
  });
});

describe("isDemoAccount bypass (founder/demo seats are never capped)", () => {
  test("a demo account with 15+ hours is never warned or blocked", () => {
    const sessions = [
      mkSession({ id: 1, createdAt: "2026-07-02T10:00:00.000Z", durationSeconds: 8 * HOUR }),
      mkSession({ id: 2, createdAt: "2026-07-05T10:00:00.000Z", durationSeconds: 7 * HOUR }),
    ];
    const cap = evaluatePracticeCap({ sessions, now: NOW, isDemoAccount: true });
    assert.equal(cap.bypassed, true);
    assert.equal(cap.blocked, false);
    assert.equal(cap.warning, false);
    assert.equal(cap.minutesRemaining, MONTHLY_CAP_MINUTES);
  });
});

describe("computeDurationSeconds", () => {
  test("computes whole seconds between start and end", () => {
    assert.equal(
      computeDurationSeconds("2026-07-05T10:00:00.000Z", "2026-07-05T10:30:00.000Z"),
      1800,
    );
  });

  test("never returns negative for out-of-order timestamps", () => {
    assert.equal(
      computeDurationSeconds("2026-07-05T10:30:00.000Z", "2026-07-05T10:00:00.000Z"),
      0,
    );
  });

  test("returns 0 for unparseable timestamps", () => {
    assert.equal(computeDurationSeconds("not-a-date", "2026-07-05T10:00:00.000Z"), 0);
  });
});

describe("blockedMessage", () => {
  test("names the human-readable reset date and has no em dash", () => {
    const msg = blockedMessage("2026-08-01T00:00:00.000Z");
    assert.match(msg, /August 1, 2026/);
    assert.ok(!msg.includes("\u2014"), "message must not contain an em dash");
  });
});
