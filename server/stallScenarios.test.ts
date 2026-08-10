import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { pickNextStallScenario, type StallScenarioOption } from "./stallScenarios";

const POOL: StallScenarioOption[] = [
  { id: 41, slug: "stall-auto-think-it-over-1", stallType: "think_it_over" },
  { id: 11, slug: "stall-home-improvement-spouse-1", stallType: "unconsulted_stakeholder" },
  { id: 21, slug: "stall-solar-email-quote-1", stallType: "email_me_a_quote" },
  { id: 31, slug: "stall-roofing-red-herring-1", stallType: "red_herring" },
];

describe("pickNextStallScenario", () => {
  test("prefers an unseen stall scenario for the requested user", () => {
    const picked = pickNextStallScenario(7, [
      { userId: 7, scenarioId: 11 },
      { userId: 99, scenarioId: 41 },
    ], POOL);

    assert.equal(picked.id, 41);
  });

  test("after every scenario is seen, falls back to the least recently used eligible scenario", () => {
    // Oldest first. Red herring was used most recently, so it is excluded as the
    // immediate prior type; among the other types, spouse was seen furthest back.
    const picked = pickNextStallScenario(7, [
      { userId: 7, scenarioId: 11 },
      { userId: 7, scenarioId: 21 },
      { userId: 7, scenarioId: 41 },
      { userId: 7, scenarioId: 31 },
    ], POOL);

    assert.equal(picked.id, 11);
  });

  test("never repeats the immediately prior stall type", () => {
    const prior = POOL.find((scenario) => scenario.id === 11)!;
    const picked = pickNextStallScenario(7, [
      { userId: 7, scenarioId: 41 },
      { userId: 7, scenarioId: 21 },
      { userId: 7, scenarioId: 31 },
      { userId: 7, scenarioId: prior.id },
    ], POOL);

    assert.notEqual(picked.stallType, prior.stallType);
    assert.equal(picked.id, 41);
  });
});
