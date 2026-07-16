import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  scoresForVerticalAtLevel,
  scoresForTrackAtLevel,
  computeLevelAdvancement,
  isExamEligible,
  REQUIRED_QUALIFYING_SESSIONS,
} from "./llm";

// Per-industry certification progress must advance each (track, vertical)
// independently: practicing Real Estate must never move Manufactured Housing.

const scenarios = [
  { id: 1, track: "consulting", difficulty: "advanced", vertical: "real_estate" },
  { id: 2, track: "consulting", difficulty: "advanced", vertical: "manufactured_housing" },
  { id: 3, track: "leadership", difficulty: "advanced", vertical: "peer_conflict" },
  { id: 4, track: "consulting", difficulty: "beginner", vertical: "real_estate" },
];

function completed(scenarioId: number, score: number) {
  return { scenarioId, status: "completed", score };
}

describe("scoresForVerticalAtLevel independence", () => {
  test("only collects scores for the matching track + vertical + level", () => {
    const sessions = [
      completed(1, 90), // real_estate advanced consulting
      completed(1, 88),
      completed(2, 95), // manufactured_housing advanced consulting
      completed(3, 99), // leadership peer_conflict advanced
      completed(4, 91), // real_estate BEGINNER (wrong level)
    ];
    assert.deepEqual(scoresForVerticalAtLevel("consulting", "real_estate", "advanced", sessions, scenarios), [90, 88]);
    assert.deepEqual(scoresForVerticalAtLevel("consulting", "manufactured_housing", "advanced", sessions, scenarios), [95]);
    assert.deepEqual(scoresForVerticalAtLevel("leadership", "peer_conflict", "advanced", sessions, scenarios), [99]);
  });

  test("advancing one vertical does not advance another", () => {
    // Five qualifying advanced sessions in real_estate -> eligible in real_estate;
    // manufactured_housing has none -> not eligible.
    const sessions = [
      completed(1, 90),
      completed(1, 90),
      completed(1, 90),
      completed(1, 90),
      completed(1, 90),
    ];
    const reScores = scoresForVerticalAtLevel("consulting", "real_estate", "advanced", sessions, scenarios);
    const mhScores = scoresForVerticalAtLevel("consulting", "manufactured_housing", "advanced", sessions, scenarios);
    assert.equal(isExamEligible("advanced", reScores), true);
    assert.equal(isExamEligible("advanced", mhScores), false);
    assert.equal(reScores.length, REQUIRED_QUALIFYING_SESSIONS);
  });

  test("a vertical's advancement uses only that vertical's sessions", () => {
    // 5 beginner real_estate sessions -> advances real_estate beginner->intermediate,
    // but manufactured_housing (no beginner sessions) does not advance.
    const sessions = [
      completed(4, 90),
      completed(4, 90),
      completed(4, 90),
      completed(4, 90),
      completed(4, 90),
    ];
    const reBeginner = scoresForVerticalAtLevel("consulting", "real_estate", "beginner", sessions, scenarios);
    const mhBeginner = scoresForVerticalAtLevel("consulting", "manufactured_housing", "beginner", sessions, scenarios);
    assert.equal(computeLevelAdvancement("beginner", reBeginner), "intermediate");
    assert.equal(computeLevelAdvancement("beginner", mhBeginner), null);
  });

  test("per-vertical scores are a strict subset of the track-level scores", () => {
    const sessions = [completed(1, 90), completed(2, 80)];
    const track = scoresForTrackAtLevel("consulting", "advanced", sessions, scenarios);
    const re = scoresForVerticalAtLevel("consulting", "real_estate", "advanced", sessions, scenarios);
    assert.deepEqual(track.sort(), [80, 90]);
    assert.deepEqual(re, [90]);
  });
});
