import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerRealConversationRoutes } from "./routes";
import {
  parsePastedTranscript,
  deriveStalledStep,
  isValidSubmissionType,
  REAL_CONVERSATION_CONSENT_TEXT,
  type RealConversationScorer,
} from "./realConversations";
import type { RubricScores, TranscriptMessage } from "@shared/schema";

// The rubric shape a PRACTICE session produces/stores. The Real Conversation
// feature must produce the identical shape (it reuses scoreTranscript), so tests
// assert against this exact key set.
const PRACTICE_RUBRIC_KEYS: (keyof RubricScores)[] = [
  "needsDiscovery",
  "objectionPrevention",
  "trustBuilding",
  "naturalClose",
  "relationshipContinuity",
];

// A deterministic stand-in for scoreTranscript with the SAME signature/return
// shape, so route tests never hit the network. It records what it was called with.
function makeFakeScorer(rubric: RubricScores, feedback: string, overall: number) {
  const calls: TranscriptMessage[][] = [];
  const scorer: RealConversationScorer = async (transcript) => {
    calls.push(transcript);
    return { rubric, feedback, overall };
  };
  return { scorer, calls };
}

const SAMPLE_RUBRIC: RubricScores = {
  needsDiscovery: 40,
  objectionPrevention: 82,
  trustBuilding: 75,
  naturalClose: 60,
  relationshipContinuity: 90,
};

// ===========================================================================
// Pure helpers (no DB, no network)
// ===========================================================================

describe("submission-type + consent constants", () => {
  test("only text_chat and email are valid submission types (audio is Phase 2)", () => {
    assert.equal(isValidSubmissionType("text_chat"), true);
    assert.equal(isValidSubmissionType("email"), true);
    assert.equal(isValidSubmissionType("audio"), false);
    assert.equal(isValidSubmissionType(""), false);
    assert.equal(isValidSubmissionType(undefined), false);
  });

  test("consent text is the exact required legal language", () => {
    assert.equal(
      REAL_CONVERSATION_CONSENT_TEXT,
      "I have the legal right to submit this conversation, including any required consent to its recording.",
    );
  });
});

describe("parsePastedTranscript", () => {
  test("labeled text/SMS chat maps 'Me' to consultant and the counterparty to customer", () => {
    const raw = [
      "Customer: Hi, just looking at options.",
      "Me: Great — what brought you in today?",
      "Customer: We're outgrowing our current place.",
    ].join("\n");
    const parsed = parsePastedTranscript(raw, "text_chat");
    assert.deepEqual(
      parsed.map((m) => m.role),
      ["customer", "consultant", "customer"],
    );
    assert.equal(parsed[1].content, "Great — what brought you in today?");
  });

  test("unlabeled lines are appended to the current speaker's message", () => {
    const raw = ["Me: Hello there.", "How can I help?", "Customer: I need a quote."].join("\n");
    const parsed = parsePastedTranscript(raw, "text_chat");
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].role, "consultant");
    assert.equal(parsed[0].content, "Hello there. How can I help?");
    assert.equal(parsed[1].role, "customer");
  });

  test("a bare unlabeled paste alternates starting with the customer", () => {
    const raw = ["We're just browsing.", "Happy to help — what matters most to you?"].join("\n");
    const parsed = parsePastedTranscript(raw, "text_chat");
    assert.deepEqual(
      parsed.map((m) => m.role),
      ["customer", "consultant"],
    );
  });

  test("email envelope/header lines are stripped from the conversation", () => {
    const raw = [
      "From: Jane <jane@example.com>",
      "Sent: Monday",
      "Subject: Quote request",
      "Customer: Can you send pricing?",
      "Me: Absolutely, here are the options.",
    ].join("\n");
    const parsed = parsePastedTranscript(raw, "email");
    assert.deepEqual(
      parsed.map((m) => m.role),
      ["customer", "consultant"],
    );
    assert.equal(parsed[0].content, "Can you send pricing?");
  });

  test("every parsed message carries the TranscriptMessage fields the engine expects", () => {
    const parsed = parsePastedTranscript("Customer: hi\nMe: hello", "text_chat");
    for (const m of parsed) {
      assert.ok(typeof m.role === "string");
      assert.ok(typeof m.content === "string");
      assert.ok(typeof m.timestamp === "string");
    }
  });
});

describe("deriveStalledStep", () => {
  test("returns the SOLVE step for the lowest-scoring rubric dimension", () => {
    // needsDiscovery (40) is the lowest -> maps to "Listen".
    assert.equal(deriveStalledStep(SAMPLE_RUBRIC), "Listen");
  });

  test("returns null when there is no rubric", () => {
    assert.equal(deriveStalledStep(null), null);
    assert.equal(deriveStalledStep(undefined), null);
  });
});

// ===========================================================================
// Routes — bare express app, injected scorer, stubbed storage
// ===========================================================================

describe("real conversation routes", () => {
  let server: Server;
  let baseUrl: string;
  let created: any[];
  let usersById: Record<number, any>;
  let officesById: Record<number, any>;
  let fake: ReturnType<typeof makeFakeScorer>;

  before(async () => {
    const app = express();
    app.use(express.json());
    fake = makeFakeScorer(SAMPLE_RUBRIC, "Solid rapport, weak needs discovery.", 68);
    registerRealConversationRoutes(app, { scorer: fake.scorer });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.close();
  });

  beforeEach(() => {
    created = [];
    fake.calls.length = 0;
    officesById = { 1: { id: 1, subscriptionStatus: "active" } };
    usersById = {
      1: { id: 1, officeId: 1, role: "consultant", seatActive: true, isDemoAccount: false },
      2: { id: 2, officeId: 1, role: "consultant", seatActive: false, isDemoAccount: false },
    };
    (storage as any).getUser = async (id: number) => usersById[id];
    (storage as any).getOffice = async (id: number) => officesById[id];
    (storage as any).createRealConversation = async (rc: any) => {
      const row = { id: created.length + 1, ...rc };
      created.push(row);
      return row;
    };
    (storage as any).listRealConversationsByUser = async (userId: number) =>
      created.filter((r) => r.submittedByUserId === userId).reverse();
  });

  async function post(body: unknown) {
    const res = await fetch(`${baseUrl}/api/real-conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const VALID_BODY = {
    userId: 1,
    submissionType: "text_chat",
    rawTranscript: "Customer: hi\nMe: hello, what brought you in?",
    consentAccepted: true,
  };

  test("CONSENT GATE: a submission without consent is rejected and nothing is stored or scored", async () => {
    const { status, body } = await post({ ...VALID_BODY, consentAccepted: false });
    assert.equal(status, 400);
    assert.equal(body.message, REAL_CONVERSATION_CONSENT_TEXT);
    assert.equal(created.length, 0);
    assert.equal(fake.calls.length, 0, "the scorer must not run without consent");
  });

  test("CONSENT GATE: a missing consent field is treated as no consent", async () => {
    const { userId, submissionType, rawTranscript } = VALID_BODY;
    const { status } = await post({ userId, submissionType, rawTranscript });
    assert.equal(status, 400);
    assert.equal(created.length, 0);
  });

  test("SCORING SHAPE: a consented submission is scored and stored with the SAME shape as a practice session", async () => {
    const { status, body } = await post(VALID_BODY);
    assert.equal(status, 200);

    // Same overall/feedback fields a practice session persists.
    assert.equal(typeof body.overallScore, "number");
    assert.equal(body.overallScore, 68);
    assert.equal(typeof body.feedback, "string");

    // rubricScores is JSON text (as practice stores it) with the EXACT practice keys.
    const rubric = JSON.parse(body.rubricScores);
    assert.deepEqual(Object.keys(rubric).sort(), [...PRACTICE_RUBRIC_KEYS].sort());
    for (const key of PRACTICE_RUBRIC_KEYS) {
      assert.equal(typeof rubric[key], "number");
    }

    // Consent record is persisted (submitter id + timestamp).
    assert.equal(body.consentAccepted, true);
    assert.ok(body.consentAcceptedAt, "consent timestamp must be stored");
    assert.equal(body.submittedByUserId, 1);
    // Phase 1: submitter scores their own conversation.
    assert.equal(body.subjectRepUserId, 1);
    // Stalled step is derived from the weakest dimension (needsDiscovery -> Listen).
    assert.equal(body.stalledStep, "Listen");

    // The scorer received a parsed TranscriptMessage[] (the same engine input).
    assert.equal(fake.calls.length, 1);
    assert.ok(Array.isArray(fake.calls[0]));
    assert.ok(fake.calls[0].every((m) => "role" in m && "content" in m));
  });

  test("SEAT GATE: an unpaid seat cannot submit (402)", async () => {
    const { status } = await post({ ...VALID_BODY, userId: 2 });
    assert.equal(status, 402);
    assert.equal(created.length, 0);
  });

  test("invalid submission types are rejected (audio is not accepted in Phase 1)", async () => {
    const { status } = await post({ ...VALID_BODY, submissionType: "audio" });
    assert.equal(status, 400);
    assert.equal(created.length, 0);
  });

  test("an empty transcript is rejected", async () => {
    const { status } = await post({ ...VALID_BODY, rawTranscript: "   " });
    assert.equal(status, 400);
  });

  test("GET returns only the caller's own submissions, newest first", async () => {
    await post(VALID_BODY);
    await post(VALID_BODY);
    const res = await fetch(`${baseUrl}/api/real-conversations?userId=1`);
    const rows = await res.json();
    assert.equal(res.status, 200);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r: any) => r.submittedByUserId === 1));
  });
});
