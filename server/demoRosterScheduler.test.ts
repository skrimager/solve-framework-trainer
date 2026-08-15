import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_ROSTER_USERNAMES,
  ROLLING_WINDOW_DAYS,
  planDemoRefresh,
  type DemoRosterPlannerSession,
  type DemoRosterPlannerUser,
} from "./demoRosterScheduler";

const NOW = new Date("2026-08-14T19:23:00.000Z");

function rosterUser(overrides: Partial<DemoRosterPlannerUser> = {}): DemoRosterPlannerUser {
  return { id: 11, username: "marcus.bell", officeId: 1, ...overrides };
}

function asExisting(plans: ReturnType<typeof planDemoRefresh>): DemoRosterPlannerSession[] {
  return plans.map((plan) => ({ userId: plan.userId, completedAt: plan.completedAt }));
}

describe("planDemoRefresh", () => {
  test("is idempotent when a second scheduler tick runs on the same calendar day", () => {
    const first = planDemoRefresh([rosterUser()], [], NOW);
    assert.ok(first.length > 0, "fresh Demo Office roster receives recent and rolling-window plans");

    const second = planDemoRefresh([rosterUser()], asExisting(first), NOW);
    assert.deepEqual(second, []);
  });

  test("keeps the active history's oldest session near 180 days back as time advances", () => {
    const initialPlans = planDemoRefresh([rosterUser()], [], NOW);
    const tenDaysLater = new Date("2026-08-24T19:23:00.000Z");
    const refreshPlans = planDemoRefresh([rosterUser()], asExisting(initialPlans), tenDaysLater);
    const all = [...asExisting(initialPlans), ...asExisting(refreshPlans)];
    const earliestActive = all
      .map((session) => new Date(session.completedAt!))
      .filter((date) => date.getTime() >= Date.UTC(2026, 7, 24) - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    assert.ok(earliestActive, "the active rolling window has an oldest anchor");
    const ageDays = Math.round((Date.UTC(2026, 7, 24) - earliestActive.getTime()) / (24 * 60 * 60 * 1000));
    assert.ok(ageDays >= 179 && ageDays <= ROLLING_WINDOW_DAYS, `expected an approximately 180-day anchor, got ${ageDays}`);
    assert.ok(refreshPlans.some((plan) => plan.reason === "rolling_anchor"), "advancing time tops up the oldest active anchor");
  });

  test("only plans rows for allowlisted Demo Office personas, never office 8 or Consultant Demo", () => {
    const plans = planDemoRefresh(
      [
        rosterUser({ id: 11, username: "marcus.bell", officeId: 1 }),
        rosterUser({ id: 2, username: "Consultant Demo", officeId: 1 }),
        rosterUser({ id: 81, username: "marcus.bell", officeId: 8 }),
        rosterUser({ id: 12, username: "other.consultant", officeId: 1 }),
      ],
      [],
      NOW,
    );

    assert.ok(plans.length > 0);
    assert.ok(plans.every((plan) => plan.userId === 11));
    assert.ok(plans.every((plan) => DEMO_ROSTER_USERNAMES.has(plan.username)));
    assert.ok(!plans.some((plan) => plan.userId === 2 || plan.userId === 81));
  });
});
