import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  scenarioTrack,
  scoresForTrackAtLevel,
  computeLevelAdvancement,
  LEADERSHIP_VERTICALS,
  ADVANCE_THRESHOLD,
} from "./llm";
import { leadershipRubricScoresSchema, rubricScoresSchema } from "@shared/schema";

// ---------------------------------------------------------------------------
// Rubric schemas
// ---------------------------------------------------------------------------

describe("leadershipRubricScoresSchema", () => {
  test("accepts a full set of the five leadership dimensions", () => {
    const parsed = leadershipRubricScoresSchema.parse({
      activeListening: 80,
      empathyAcknowledgment: 75,
      rootCauseDiscovery: 60,
      solutionVisualization: 90,
      blamelessResolution: 85,
    });
    assert.equal(parsed.activeListening, 80);
    assert.equal(parsed.blamelessResolution, 85);
  });

  test("rejects a payload missing a leadership dimension", () => {
    assert.throws(() =>
      leadershipRubricScoresSchema.parse({
        activeListening: 80,
        empathyAcknowledgment: 75,
        rootCauseDiscovery: 60,
        solutionVisualization: 90,
        // blamelessResolution missing
      }),
    );
  });

  test("the leadership and consulting rubrics have disjoint dimension keys", () => {
    const consulting = Object.keys(rubricScoresSchema.shape);
    const leadership = Object.keys(leadershipRubricScoresSchema.shape);
    for (const k of leadership) {
      assert.equal(consulting.includes(k), false, `key ${k} should not be a consulting dimension`);
    }
  });
});

// ---------------------------------------------------------------------------
// Track normalization
// ---------------------------------------------------------------------------

describe("scenarioTrack", () => {
  test("normalizes null/undefined/legacy rows to consulting", () => {
    assert.equal(scenarioTrack(null), "consulting");
    assert.equal(scenarioTrack(undefined), "consulting");
    assert.equal(scenarioTrack(""), "consulting");
    assert.equal(scenarioTrack("consulting"), "consulting");
  });

  test("recognizes the leadership track", () => {
    assert.equal(scenarioTrack("leadership"), "leadership");
  });
});

// ---------------------------------------------------------------------------
// Track filtering (mirrors the /api/scenarios ?track= filter and the client
// picker): filtering by track returns only that track's verticals.
// ---------------------------------------------------------------------------

describe("track filtering returns only the right verticals", () => {
  const mixed = [
    { id: 1, vertical: "auto_sales", track: "consulting", difficulty: "beginner" },
    { id: 2, vertical: "hvac_service", track: "consulting", difficulty: "beginner" },
    { id: 3, vertical: "upset_customer_service", track: "leadership", difficulty: "beginner" },
    { id: 4, vertical: "employee_grievance", track: "leadership", difficulty: "intermediate" },
    { id: 5, vertical: "peer_conflict", track: "leadership", difficulty: "advanced" },
    { id: 6, vertical: "real_estate", track: null, difficulty: "beginner" }, // legacy row, no track
  ];

  function filterByTrack(track: string) {
    return mixed.filter((s) => scenarioTrack(s.track) === track);
  }

  test("leadership track yields only the three leadership verticals", () => {
    const verticals = filterByTrack("leadership").map((s) => s.vertical).sort();
    assert.deepEqual(verticals, [...LEADERSHIP_VERTICALS].sort());
  });

  test("consulting track yields only consulting verticals (incl. legacy null rows)", () => {
    const verticals = filterByTrack("consulting").map((s) => s.vertical).sort();
    assert.deepEqual(verticals, ["auto_sales", "hvac_service", "real_estate"]);
    // No leadership vertical leaks into the consulting list.
    for (const v of LEADERSHIP_VERTICALS) {
      assert.equal(verticals.includes(v), false);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-track level/certification independence — the core requirement:
// a user Advanced in Consulting must NOT be auto-advanced/certified in Leadership.
// ---------------------------------------------------------------------------

describe("per-track level independence", () => {
  // A user who is Advanced in consulting but still Beginner in leadership.
  const scenarios = [
    { id: 10, track: "consulting", difficulty: "advanced" },
    { id: 20, track: "leadership", difficulty: "beginner" },
    { id: 21, track: "leadership", difficulty: "beginner" },
  ];

  test("consulting scores never feed leadership advancement", () => {
    // High consulting scores at advanced, but the user has no leadership sessions.
    const sessions = [
      { scenarioId: 10, status: "completed", score: 95 },
      { scenarioId: 10, status: "completed", score: 90 },
    ];
    const leadershipScores = scoresForTrackAtLevel("leadership", "beginner", sessions, scenarios);
    assert.deepEqual(leadershipScores, []);
    assert.equal(computeLevelAdvancement("beginner", leadershipScores), null);
  });

  test("leadership scores drive leadership advancement without touching consulting", () => {
    // Five individually-qualifying (85+) leadership beginner sessions are required
    // to advance — an average is NOT enough. Give the user exactly five.
    const manyScenarios = [
      ...scenarios,
      { id: 22, track: "leadership", difficulty: "beginner" },
      { id: 23, track: "leadership", difficulty: "beginner" },
      { id: 24, track: "leadership", difficulty: "beginner" },
    ];
    const sessions = [
      { scenarioId: 10, status: "completed", score: 40 }, // poor consulting score
      { scenarioId: 20, status: "completed", score: 90 },
      { scenarioId: 21, status: "completed", score: 88 },
      { scenarioId: 22, status: "completed", score: 86 },
      { scenarioId: 23, status: "completed", score: 91 },
      { scenarioId: 24, status: "completed", score: 85 },
    ];
    const leadershipScores = scoresForTrackAtLevel("leadership", "beginner", sessions, manyScenarios);
    assert.deepEqual([...leadershipScores].sort((a, b) => a - b), [85, 86, 88, 90, 91]);
    // All five clear the bar, so leadership advances beginner -> intermediate.
    assert.ok(leadershipScores.every((s) => s >= ADVANCE_THRESHOLD));
    assert.equal(computeLevelAdvancement("beginner", leadershipScores), "intermediate");

    // The consulting side, meanwhile, sees only the poor consulting score and does not advance.
    const consultingScores = scoresForTrackAtLevel("consulting", "beginner", sessions, manyScenarios);
    assert.deepEqual(consultingScores, []); // no consulting beginner sessions
  });

  test("fewer than five qualifying sessions does not advance, even at a high average", () => {
    const sessions = [
      { scenarioId: 20, status: "completed", score: 99 },
      { scenarioId: 21, status: "completed", score: 98 },
    ];
    const leadershipScores = scoresForTrackAtLevel("leadership", "beginner", sessions, scenarios);
    // Two sessions averaging 98.5 — but only two, so no advancement under the
    // 5-qualifying rule (this is the behavior change from the old averaging logic).
    assert.equal(computeLevelAdvancement("beginner", leadershipScores), null);
  });

  test("only completed, scored sessions on the matching difficulty count", () => {
    const sessions = [
      { scenarioId: 20, status: "in_progress", score: null }, // not completed
      { scenarioId: 21, status: "completed", score: 92 },
      { scenarioId: 10, status: "completed", score: 99 }, // wrong track+difficulty
    ];
    const scores = scoresForTrackAtLevel("leadership", "beginner", sessions, scenarios);
    assert.deepEqual(scores, [92]);
  });

  test("advanced is the ceiling on the leadership track too", () => {
    assert.equal(computeLevelAdvancement("advanced", [100, 100]), null);
  });
});
