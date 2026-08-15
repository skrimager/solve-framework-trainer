import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_ROSTER_USERNAMES,
  ROLLING_WINDOW_DAYS,
  PRUNE_AFTER_DAYS,
  planDemoRefresh,
  type DemoRosterPlannerSession,
  type DemoRosterPlannerUser,
} from "./demoRosterScheduler";

const NOW = new Date("2026-08-14T19:23:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function rosterUser(overrides: Partial<DemoRosterPlannerUser> = {}): DemoRosterPlannerUser {
  return { id: 11, username: "marcus.bell", officeId: 1, ...overrides };
}

// Simulates applying a plan's inserts and prunes against an in-memory
// "existing sessions" list, exactly as the real DB wrapper would (delete
// pruned ids, then append new inserts). Auto-increments ids for inserts so
// repeated ticks behave like a real auto-increment primary key.
let nextId = 1000;
function applyPlan(
  existing: DemoRosterPlannerSession[],
  plan: ReturnType<typeof planDemoRefresh>,
): DemoRosterPlannerSession[] {
  const pruned = new Set(plan.pruneSessionIds);
  const survivors = existing.filter((session) => !pruned.has(session.id));
  const inserted = plan.inserts.map((p) => ({ id: nextId++, userId: p.userId, completedAt: p.completedAt }));
  return [...survivors, ...inserted];
}

describe("planDemoRefresh", () => {
  test("is idempotent when a second scheduler tick runs on the same calendar day", () => {
    const first = planDemoRefresh([rosterUser()], [], NOW);
    assert.ok(first.inserts.length > 0, "fresh Demo Office roster receives recent and rolling-window plans");
    assert.deepEqual(first.pruneSessionIds, [], "nothing to prune on a fresh roster");

    const existing = applyPlan([], first);
    const second = planDemoRefresh([rosterUser()], existing, NOW);
    assert.deepEqual(second.inserts, []);
    assert.deepEqual(second.pruneSessionIds, []);
  });

  test("keeps the active history's oldest session near 180 days back as time advances", () => {
    const initial = planDemoRefresh([rosterUser()], [], NOW);
    let existing = applyPlan([], initial);

    const tenDaysLater = new Date("2026-08-24T19:23:00.000Z");
    const refresh = planDemoRefresh([rosterUser()], existing, tenDaysLater);
    existing = applyPlan(existing, refresh);

    // Assert against the FULL surviving history, not a pre-filtered subset —
    // this is what the previous version of this test got wrong. It filtered
    // down to only sessions already inside the window before checking the
    // oldest one, which trivially always passes even if ancient rows exist
    // outside the filter. Asserting on `existing` directly (already pruned
    // by planDemoRefresh/applyPlan) is the real check.
    const earliestActive = existing
      .map((session) => new Date(session.completedAt!))
      .sort((a, b) => a.getTime() - b.getTime())[0];

    assert.ok(earliestActive, "history has an oldest session");
    const ageDays = Math.round((tenDaysLater.getTime() - earliestActive.getTime()) / DAY_MS);
    assert.ok(
      ageDays <= PRUNE_AFTER_DAYS,
      `oldest surviving session must never exceed the prune cutoff (${PRUNE_AFTER_DAYS} days), got ${ageDays}`,
    );
    assert.ok(refresh.inserts.some((plan) => plan.reason === "rolling_anchor"), "advancing time tops up the oldest active anchor");
  });

  test("total history stays bounded over a long simulated run instead of growing forever", () => {
    // This is the regression test for the real bug: run ~900 simulated days
    // (well over two years) of weekly scheduler ticks and confirm the total
    // row count converges to a stable ceiling instead of growing without
    // bound. The old code had no pruning at all, so this would fail
    // (unbounded growth) prior to the fix.
    let existing: DemoRosterPlannerSession[] = [];
    const user = rosterUser();
    const counts: number[] = [];

    for (let day = 0; day <= 900; day += 7) {
      const simulatedNow = new Date(NOW.getTime() + day * DAY_MS);
      const plan = planDemoRefresh([user], existing, simulatedNow);
      existing = applyPlan(existing, plan);
      counts.push(existing.length);
    }

    // Skip the first ~30 weeks (day 210) to let the roster finish its
    // initial bootstrap ramp (6 milestone anchors + rolling anchor all
    // populating for the first time). After that the count must plateau —
    // comparing two later windows, not the bootstrap ramp against the tail,
    // is what actually catches unbounded growth.
    const midpoint = Math.floor(counts.length / 2);
    const midCeiling = Math.max(...counts.slice(midpoint - 5, midpoint + 5));
    const lateCeiling = Math.max(...counts.slice(-10));
    assert.ok(
      lateCeiling <= midCeiling + 3,
      `expected history count to plateau after bootstrap, but it kept growing: mid-run ceiling ${midCeiling}, late ceiling ${lateCeiling}`,
    );

    // And directly re-confirm no session in the final state is older than
    // the prune cutoff relative to the final simulated "now".
    const finalNow = NOW.getTime() + 900 * DAY_MS;
    const oldestAgeDays = Math.max(
      ...existing.map((session) => Math.round((finalNow - new Date(session.completedAt!).getTime()) / DAY_MS)),
    );
    assert.ok(oldestAgeDays <= PRUNE_AFTER_DAYS, `oldest session age ${oldestAgeDays} days exceeds prune cutoff ${PRUNE_AFTER_DAYS}`);
  });

  test("only plans rows for allowlisted Demo Office personas, never office 8 or Consultant Demo", () => {
    const plan = planDemoRefresh(
      [
        rosterUser({ id: 11, username: "marcus.bell", officeId: 1 }),
        rosterUser({ id: 2, username: "Consultant Demo", officeId: 1 }),
        rosterUser({ id: 81, username: "marcus.bell", officeId: 8 }),
        rosterUser({ id: 12, username: "other.consultant", officeId: 1 }),
      ],
      [],
      NOW,
    );

    assert.ok(plan.inserts.length > 0);
    assert.ok(plan.inserts.every((p) => p.userId === 11));
    assert.ok(plan.inserts.every((p) => DEMO_ROSTER_USERNAMES.has(p.username)));
    assert.ok(!plan.inserts.some((p) => p.userId === 2 || p.userId === 81));
  });

  test("prune list only ever contains ids belonging to allowlisted personas passed in", () => {
    const oldTimestamp = new Date(NOW.getTime() - (PRUNE_AFTER_DAYS + 30) * DAY_MS).toISOString();
    const existing: DemoRosterPlannerSession[] = [
      { id: 501, userId: 11, completedAt: oldTimestamp }, // allowlisted marcus.bell, office 1 -> eligible
      { id: 502, userId: 2, completedAt: oldTimestamp }, // Consultant Demo, not in personas list passed below
    ];

    const plan = planDemoRefresh([rosterUser({ id: 11, username: "marcus.bell", officeId: 1 })], existing, NOW);

    assert.ok(plan.pruneSessionIds.includes(501), "old session for an allowlisted persona should be pruned");
    assert.ok(!plan.pruneSessionIds.includes(502), "session for a user not in the personas list must never be pruned");
  });

  test("does not prune a session that is still within the safety margin", () => {
    const recentEnough = new Date(NOW.getTime() - (PRUNE_AFTER_DAYS - 10) * DAY_MS).toISOString();
    const existing: DemoRosterPlannerSession[] = [{ id: 601, userId: 11, completedAt: recentEnough }];

    const plan = planDemoRefresh([rosterUser()], existing, NOW);
    assert.ok(!plan.pruneSessionIds.includes(601), "session inside the prune cutoff must survive");
  });
});
