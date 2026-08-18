import test from "node:test";
import assert from "node:assert/strict";
import { pickScenarioForLevel } from "../pages/scenarios";
import type { Scenario } from "@shared/schema";

// Minimal fixture builder — only the fields pickScenarioForLevel reads.
function scenario(id: number, difficulty: string): Scenario {
  return { id, difficulty } as unknown as Scenario;
}

test("pickScenarioForLevel restricts the random draw to the active level", () => {
  const pool = [
    scenario(1, "beginner"),
    scenario(2, "beginner"),
    scenario(3, "intermediate"),
    scenario(4, "advanced"),
  ];
  for (let i = 0; i < 25; i++) {
    const picked = pickScenarioForLevel(pool, "beginner");
    assert.ok(picked, "expected a scenario to be picked");
    assert.equal(picked!.difficulty, "beginner");
  }
});

test("pickScenarioForLevel never returns an advanced scenario to a beginner", () => {
  // This is the exact bug: a fresh Beginner user must never be handed the
  // Advanced cross-shopper opening (or any other Advanced scenario) purely by
  // chance of an unrestricted random draw across the whole vertical pool.
  const pool = [scenario(1, "advanced"), scenario(2, "advanced"), scenario(3, "beginner")];
  for (let i = 0; i < 25; i++) {
    const picked = pickScenarioForLevel(pool, "beginner");
    assert.equal(picked!.difficulty, "beginner");
  }
});

test("pickScenarioForLevel falls back to the full pool when nothing matches the exact level", () => {
  const pool = [scenario(1, "intermediate"), scenario(2, "advanced")];
  const picked = pickScenarioForLevel(pool, "beginner");
  assert.ok(picked, "expected a fallback pick rather than nothing");
});

test("pickScenarioForLevel falls back to the full pool when activeLevel is undefined (certified)", () => {
  const pool = [scenario(1, "beginner"), scenario(2, "advanced")];
  const picked = pickScenarioForLevel(pool, undefined);
  assert.ok(picked, "expected a pick for certified consultants with no active level");
});

test("pickScenarioForLevel returns undefined for an empty pool", () => {
  assert.equal(pickScenarioForLevel([], "beginner"), undefined);
});
