import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildProgressionPath,
  currentStageIndex,
  STAGE_ORDER,
  REQUIRED_QUALIFYING,
  QUALIFYING_SCORE,
  type StageKey,
} from "./progression";

// Helper: pull one stage out of a built path by key.
function stage(path: ReturnType<typeof buildProgressionPath>, key: StageKey) {
  const s = path.find((p) => p.key === key);
  assert.ok(s, `expected stage ${key} to be present`);
  return s!;
}

describe("progression thresholds", () => {
  test("mirror the practice dashboard numbers (5 qualifying sessions at 85+)", () => {
    // These MUST match REQUIRED_QUALIFYING / QUALIFYING_SCORE in scenarios.tsx.
    // The academy path only surfaces these numbers, it does not invent new ones.
    assert.equal(REQUIRED_QUALIFYING, 5);
    assert.equal(QUALIFYING_SCORE, 85);
  });
});

describe("progression path shape", () => {
  test("always shows all four stages, in order, from day one at Beginner", () => {
    const path = buildProgressionPath("beginner", false);
    assert.deepEqual(
      path.map((s) => s.key),
      ["beginner", "intermediate", "advanced", "certified"],
    );
    // The path is never gated: a brand-new Beginner still sees every stage.
    assert.equal(path.length, 4);
    assert.deepEqual(STAGE_ORDER, ["beginner", "intermediate", "advanced", "certified"]);
  });
});

describe("current position is highlighted for every level", () => {
  test("a Beginner is marked current at Beginner, with later stages locked", () => {
    const path = buildProgressionPath("beginner", false);
    assert.equal(stage(path, "beginner").state, "current");
    assert.equal(stage(path, "intermediate").state, "locked");
    assert.equal(stage(path, "advanced").state, "locked");
    assert.equal(stage(path, "certified").state, "locked");
  });

  test("an Intermediate is current at Intermediate, Beginner complete", () => {
    const path = buildProgressionPath("intermediate", false);
    assert.equal(stage(path, "beginner").state, "complete");
    assert.equal(stage(path, "intermediate").state, "current");
    assert.equal(stage(path, "advanced").state, "locked");
    assert.equal(stage(path, "certified").state, "locked");
  });

  test("an Advanced consultant is current at Advanced, exam stage still locked", () => {
    const path = buildProgressionPath("advanced", false);
    assert.equal(stage(path, "beginner").state, "complete");
    assert.equal(stage(path, "intermediate").state, "complete");
    assert.equal(stage(path, "advanced").state, "current");
    assert.equal(stage(path, "certified").state, "locked");
  });

  test("a certified consultant is current at Certified, everything before complete", () => {
    const path = buildProgressionPath("advanced", true);
    assert.equal(stage(path, "beginner").state, "complete");
    assert.equal(stage(path, "intermediate").state, "complete");
    assert.equal(stage(path, "advanced").state, "complete");
    assert.equal(stage(path, "certified").state, "current");
  });

  test("exactly one stage is current at any level", () => {
    for (const lvl of ["beginner", "intermediate", "advanced"] as const) {
      const current = buildProgressionPath(lvl, false).filter((s) => s.state === "current");
      assert.equal(current.length, 1);
      assert.equal(current[0].key, lvl);
    }
  });
});

describe("currentStageIndex", () => {
  test("maps levels to their index and certified to the final stage", () => {
    assert.equal(currentStageIndex("beginner", false), 0);
    assert.equal(currentStageIndex("intermediate", false), 1);
    assert.equal(currentStageIndex("advanced", false), 2);
    assert.equal(currentStageIndex("advanced", true), 3);
    // Certified always wins, even if level somehow reads below advanced.
    assert.equal(currentStageIndex("beginner", true), 3);
  });
});

describe("locked stages state their real unlock criteria", () => {
  const path = buildProgressionPath("beginner", false);

  test("Intermediate unlock uses the real 5-session / 85+ Beginner threshold", () => {
    const text = stage(path, "intermediate").unlockCriteria;
    assert.ok(text);
    assert.match(text!, /Intermediate/);
    assert.match(text!, /5 qualifying Beginner sessions/);
    assert.match(text!, /85 or higher/);
  });

  test("Advanced unlock uses the real 5-session / 85+ Intermediate threshold", () => {
    const text = stage(path, "advanced").unlockCriteria;
    assert.ok(text);
    assert.match(text!, /Advanced/);
    assert.match(text!, /5 qualifying Intermediate sessions/);
    assert.match(text!, /85 or higher/);
  });

  test("Certified unlock states the exam requirement up front, verbatim", () => {
    const text = stage(path, "certified").unlockCriteria;
    assert.ok(text);
    assert.match(text!, /Complete 5 Advanced sessions scoring 85 or higher/);
    assert.match(text!, /pass the certification exam/);
  });

  test("stages already reached carry no unlock criteria", () => {
    assert.equal(stage(path, "beginner").unlockCriteria, undefined);
    const advancedPath = buildProgressionPath("advanced", false);
    assert.equal(stage(advancedPath, "beginner").unlockCriteria, undefined);
    assert.equal(stage(advancedPath, "intermediate").unlockCriteria, undefined);
    assert.equal(stage(advancedPath, "advanced").unlockCriteria, undefined);
  });
});

describe("copy style", () => {
  test("no unlock criteria contains an em dash (site-wide style rule)", () => {
    for (const lvl of ["beginner", "intermediate", "advanced"] as const) {
      for (const cert of [false, true]) {
        for (const s of buildProgressionPath(lvl, cert)) {
          if (s.unlockCriteria) assert.doesNotMatch(s.unlockCriteria, /—/);
        }
      }
    }
  });
});
