import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_OFFICE_PERSONAS,
  buildCoachingMessages,
  buildTranscript,
  planSessionBackfill,
  transcriptNeedsBackfill,
} from "./seed-demo-roster";
import type { Scenario, Session } from "@shared/schema";

function scenario(): Scenario {
  return {
    id: 41,
    slug: "kitchen-remodel-outdated-layout-frustration",
    title: "Wants New Countertops, Needs a New Layout",
    vertical: "home_improvement",
    track: "consulting",
    transactionType: null,
    product: null,
    stallType: null,
    description: "A homeowner asks for countertops, but the real concern is a cramped kitchen that does not work for cooking and hosting.",
    customerPersona: "",
    personaCore: `You are Danielle, 42, a homeowner.\n\nYour opening stance: "I just want to swap out these old countertops for something nicer."\n\n- The countertops are not the real problem, the whole layout fights you when you cook and host.`,
    personalityVariants: "[]",
    motivationVariants: "[]",
    objectionPool: JSON.stringify(["I worry a bigger change will become more complicated than I can manage."]),
    gender: "female",
    difficulty: "beginner",
    briefing: "",
    active: true,
    version: 1,
  };
}

function session(score: number): Pick<Session, "id" | "userId" | "score" | "completedAt"> {
  return { id: 9, userId: 24, score, completedAt: "2026-08-10T18:00:00.000Z" };
}

describe("demo roster transcript and coaching backfill", () => {
  test("includes only the six fabricated Demo Office personas", () => {
    assert.equal(DEMO_OFFICE_PERSONAS.length, 6);
    assert.equal(
      DEMO_OFFICE_PERSONAS.reduce((count, persona) => count + persona.sessions.length, 0),
      54,
    );
  });

  test("creates valid alternating transcript turns with timestamps ending at completion", () => {
    const transcript = JSON.parse(buildTranscript(session(91), scenario(), 2)) as Array<Record<string, string>>;
    assert.equal(transcript.length, 10);
    assert.equal(transcript[0].role, "customer");
    assert.equal(transcript.at(-1)?.role, "consultant");
    assert.equal(transcript.at(-1)?.timestamp, "2026-08-10T18:00:00.000Z");
    for (let index = 0; index < transcript.length; index++) {
      assert.ok(["customer", "consultant"].includes(transcript[index].role));
      assert.ok(transcript[index].content.length > 20);
      assert.ok(!/[\u2013\u2014]/.test(transcript[index].content));
      assert.ok(!/\bprofit\b|\bcost\b/i.test(transcript[index].content));
      if (index > 0) assert.notEqual(transcript[index].role, transcript[index - 1].role);
    }
  });

  test("calibrates transcript length and coaching exchange depth to the fabricated score", () => {
    const low = JSON.parse(buildTranscript(session(62), scenario(), 0));
    const mid = JSON.parse(buildTranscript(session(79), scenario(), 1));
    const high = JSON.parse(buildTranscript(session(90), scenario(), 2));
    assert.equal(low.length, 6);
    assert.equal(mid.length, 8);
    assert.equal(high.length, 10);
    assert.equal(buildCoachingMessages(session(62), scenario(), 0).length, 2);
    assert.equal(buildCoachingMessages(session(79), scenario(), 1).length, 2);
    assert.equal(buildCoachingMessages(session(90), scenario(), 2).length, 4);
  });

  test("creates coaching rows with schema-required fields, allowed roles, and post-session timestamps", () => {
    const messages = buildCoachingMessages(session(90), scenario(), 2);
    for (const message of messages) {
      assert.equal(message.sessionId, 9);
      assert.equal(message.userId, 24);
      assert.ok(["trainee", "coach"].includes(message.role));
      assert.equal(message.cleared, false);
      assert.ok(message.content.length > 40);
      assert.ok(new Date(message.createdAt).getTime() > new Date("2026-08-10T18:00:00.000Z").getTime());
      assert.ok(!/[\u2013\u2014]/.test(message.content));
      assert.ok(!/great job|excellent work|amazing job|\bgood\.\s/i.test(message.content));
    }
  });

  test("keeps generated customer-facing content free of monetary figures and profitability language", () => {
    for (const score of [62, 79, 90]) {
      const transcript = buildTranscript(session(score), scenario(), score);
      const coaching = buildCoachingMessages(session(score), scenario(), score).map((message) => message.content).join(" ");
      assert.ok(!/\$\s*\d|\b\d{1,3}(?:,\d{3})+\b|\bprofit(?:ability)?\b/i.test(`${transcript} ${coaching}`));
    }
  });

  test("plans inserts only for empty histories and is idempotent on a second pass", () => {
    const first = planSessionBackfill([], 7);
    assert.deepEqual(first, { insertSessionCount: 7, transcriptSessionIds: [] });

    const afterFirstRun = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, transcript: buildTranscript(session(90), scenario(), index) }));
    const second = planSessionBackfill(afterFirstRun, 7);
    assert.deepEqual(second, { insertSessionCount: 0, transcriptSessionIds: [] });
  });

  test("backfills only empty or invalid existing transcript fields", () => {
    const plan = planSessionBackfill([
      { id: 1, transcript: "[]" },
      { id: 2, transcript: "not json" },
      { id: 3, transcript: JSON.stringify([{ role: "customer", content: "Placeholder transcript", timestamp: "2026-08-10T18:00:00.000Z" }]) },
      { id: 4, transcript: buildTranscript(session(86), scenario(), 0) },
    ], 3);
    assert.deepEqual(plan, { insertSessionCount: 0, transcriptSessionIds: [1, 2, 3] });
    assert.equal(transcriptNeedsBackfill("[]"), true);
    assert.equal(transcriptNeedsBackfill(JSON.stringify([{ content: "No transcript available" }])), true);
    assert.equal(transcriptNeedsBackfill('[{"role":"customer"}]'), false);
  });
});
