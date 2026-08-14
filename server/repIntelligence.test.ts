import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { InsertCoinAward, Scenario, Session, User } from "@shared/schema";
import {
  awardCoinForAdvancement,
  deriveStrengthsAndWeaknesses,
  rollingAverageScore,
} from "./repIntelligence";
import { getOfficeRankings } from "./routes";

function session(partial: Partial<Session> & { id: number; scenarioId: number }): Session {
  return {
    userId: 1,
    status: "completed",
    transcript: "[]",
    score: 50,
    rubricScores: null,
    feedback: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    savedAt: null,
    durationSeconds: null,
    ...partial,
  } as Session;
}

describe("rep intelligence rolling window", () => {
  test("rolling average uses the newest 20 completed scored sessions, not all 25", () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      session({
        id: index + 1,
        scenarioId: 1,
        // The five oldest sessions are low scores that must fall out.
        score: index < 5 ? 0 : 100,
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        completedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      }),
    );
    assert.equal(rollingAverageScore(sessions), 100);

    const rankings = getOfficeRankings(
      [{ id: 1, role: "consultant", displayName: "Rolling Rep" } as User],
      new Map([[1, sessions]]),
    );
    assert.equal(rankings[0].averageScore, 100);
    assert.equal(rankings[0].sampleSize, 20);
  });
});

describe("strength/weakness derivation", () => {
  test("selects max/min rubric dimension and reports the honest short sample", () => {
    const scenarios = [{ id: 1, track: "consulting" }] as Scenario[];
    const sessions = [
      session({
        id: 1,
        scenarioId: 1,
        score: 82,
        createdAt: "2026-02-01T00:00:00.000Z",
        rubricScores: JSON.stringify({
          needsDiscovery: 95,
          objectionPrevention: 80,
          trustBuilding: 70,
          naturalClose: 60,
          relationshipContinuity: 50,
        }),
      }),
      session({
        id: 2,
        scenarioId: 1,
        score: 84,
        createdAt: "2026-02-02T00:00:00.000Z",
        rubricScores: JSON.stringify({
          needsDiscovery: 85,
          objectionPrevention: 75,
          trustBuilding: 65,
          naturalClose: 55,
          relationshipContinuity: 45,
        }),
      }),
      session({
        id: 3,
        scenarioId: 1,
        score: 86,
        createdAt: "2026-02-03T00:00:00.000Z",
        rubricScores: JSON.stringify({
          needsDiscovery: 90,
          objectionPrevention: 70,
          trustBuilding: 60,
          naturalClose: 50,
          relationshipContinuity: 40,
        }),
      }),
    ];

    const intelligence = deriveStrengthsAndWeaknesses(sessions, scenarios, "consulting");
    assert.equal(intelligence.sampleSize, 3);
    assert.equal(intelligence.strength?.key, "needsDiscovery");
    assert.equal(intelligence.weakness?.key, "relationshipContinuity");
  });
});

describe("coin award idempotency", () => {
  test("awards once and ignores a re-check of the same user, track, and tier", async () => {
    const rows = new Map<string, InsertCoinAward>();
    const awards = {
      insertCoinAwardIfAbsent: async (award: InsertCoinAward) => {
        const key = `${award.userId}:${award.track}:${award.tier}`;
        if (rows.has(key)) return false;
        rows.set(key, award);
        return true;
      },
    };
    const input = {
      userId: 7,
      officeId: 4,
      track: "consulting" as const,
      levelCrossed: "beginner",
      earnedAt: "2026-03-01T00:00:00.000Z",
    };

    assert.equal(await awardCoinForAdvancement(awards, input), true);
    assert.equal(await awardCoinForAdvancement(awards, input), false);
    assert.equal(rows.size, 1);
    assert.equal(rows.get("7:consulting:bronze")?.tier, "bronze");
  });
});
