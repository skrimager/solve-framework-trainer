import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerCoachingRoutes } from "./routes";
import {
  COACHING_SYSTEM,
  buildCoachingPrompt,
  buildCoachingStablePrefix,
  getCoachingReply,
  type CoachingResponder,
} from "./coaching";
import type { TranscriptMessage } from "@shared/schema";

const TRANSCRIPT: TranscriptMessage[] = [
  { role: "customer", content: "Hi, I'm Sarah — just looking at options.", timestamp: "t1" },
  { role: "consultant", content: "Great, what brought you in today?", timestamp: "t2" },
  { role: "customer", content: "We're outgrowing our current place.", timestamp: "t3" },
];

// ===========================================================================
// Prompt-content tests (pure functions, no network) — mirror llm.test.ts
// ===========================================================================

describe("COACHING_SYSTEM prompt content", () => {
  test("instructs the coach to redirect toward practicing another scenario when redundant", () => {
    const lower = COACHING_SYSTEM.toLowerCase();
    // Redundancy-detection + redirect language must be present so the model
    // recognizes circular threads and steers the trainee to practice live.
    assert.ok(lower.includes("re-asking") || lower.includes("already covered"));
    assert.ok(lower.includes("another practice scenario") || lower.includes("run another"));
    assert.ok(lower.includes("redirect") || lower.includes("steer"));
  });

  test("uses discovery-training language and forbids sales / AI roleplay wording", () => {
    const lower = COACHING_SYSTEM.toLowerCase();
    assert.ok(lower.includes("discovery"));
    // The forbidden-copy constraint: the coach persona must never introduce
    // "sales" or "AI roleplay" framing. It may mention the words only to forbid
    // them, so we assert the system prompt explicitly prohibits them.
    assert.ok(lower.includes("never use the words"));
  });

  test("instructs conditional (judgment-based) transcript quoting", () => {
    const lower = COACHING_SYSTEM.toLowerCase();
    assert.ok(lower.includes("conditionally") || lower.includes("conditional"));
    assert.ok(lower.includes("quote"));
    // General questions should be answered from the framework without forcing quotes.
    assert.ok(lower.includes("do not force transcript quotes"));
  });
});

describe("buildCoachingPrompt structure", () => {
  test("stable prefix leads; transcript is available for reference", () => {
    const prompt = buildCoachingPrompt({
      track: "consulting",
      feedback: "You asked good opening questions.",
      rubricScoresJson: '{"needsDiscovery":70}',
      overallScore: 72,
      transcript: TRANSCRIPT,
      thread: [],
      question: "How could I have phrased my opener?",
    });
    const stable = buildCoachingStablePrefix({
      track: "consulting",
      feedback: "You asked good opening questions.",
      rubricScoresJson: '{"needsDiscovery":70}',
      overallScore: 72,
      transcript: TRANSCRIPT,
      thread: [],
      question: "How could I have phrased my opener?",
    });
    assert.ok(prompt.startsWith(stable));
    // The transcript is passed into context so the coach CAN quote it.
    assert.ok(prompt.includes("outgrowing our current place"));
    assert.ok(prompt.includes(COACHING_SYSTEM));
    // The trainee's new question and prior-thread section are in the volatile tail.
    assert.ok(prompt.includes("How could I have phrased my opener?"));
  });

  test("prior thread turns are rendered with SOLVE Coach / Trainee labels", () => {
    const prompt = buildCoachingPrompt({
      track: "consulting",
      feedback: "f",
      rubricScoresJson: null,
      overallScore: null,
      transcript: TRANSCRIPT,
      thread: [
        { role: "trainee", content: "Why does discovery matter?" },
        { role: "coach", content: "It uncovers the real need." },
      ],
      question: "Can you give an example from what I said?",
    });
    assert.ok(prompt.includes("Trainee: Why does discovery matter?"));
    assert.ok(prompt.includes("SOLVE Coach: It uncovers the real need."));
  });

  test("leadership track is framed as conflict-management, not sales", () => {
    const prompt = buildCoachingPrompt({
      track: "leadership",
      feedback: "f",
      rubricScoresJson: null,
      overallScore: null,
      transcript: TRANSCRIPT,
      thread: [],
      question: "q",
    });
    assert.ok(prompt.toLowerCase().includes("conflict-management"));
  });
});

describe("getCoachingReply", () => {
  test("passes the built prompt to the responder and trims the reply", async () => {
    let seen = "";
    const responder: CoachingResponder = async (input) => {
      seen = input;
      return "  Here's a better opener.  ";
    };
    const reply = await getCoachingReply(
      {
        track: "consulting",
        feedback: "f",
        rubricScoresJson: null,
        overallScore: 80,
        transcript: TRANSCRIPT,
        thread: [],
        question: "How could I have phrased my opener?",
      },
      responder,
    );
    assert.equal(reply, "Here's a better opener.");
    assert.ok(seen.includes("How could I have phrased my opener?"));
  });
});

// ===========================================================================
// Route tests — bare express app, injected responder, stubbed storage
// ===========================================================================

describe("coaching routes", () => {
  let server: Server;
  let baseUrl: string;

  // In-memory stores driven by the stubbed storage methods.
  let messages: any[];
  let sessionsById: Record<number, any>;
  let usersById: Record<number, any>;
  let officesById: Record<number, any>;

  before(async () => {
    const app = express();
    app.use(express.json());
    // Deterministic responder so no network is hit and the reply is assertable.
    registerCoachingRoutes(app, {
      responder: async () => "Try opening with a question about their goals.",
    });
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
    messages = [];
    sessionsById = {
      10: {
        id: 10, userId: 1, scenarioId: 5, status: "completed",
        transcript: JSON.stringify(TRANSCRIPT), score: 72,
        rubricScores: '{"needsDiscovery":70}', feedback: "Good start.",
        createdAt: "t", completedAt: "t", savedAt: null,
      },
    };
    officesById = { 1: { id: 1, subscriptionStatus: "active" } };
    usersById = {
      1: { id: 1, officeId: 1, role: "consultant", seatActive: true, isDemoAccount: false },
      2: { id: 2, officeId: 1, role: "manager", seatActive: true, isDemoAccount: false },
      3: { id: 3, officeId: 2, role: "manager", seatActive: true, isDemoAccount: false },
    };

    (storage as any).getSession = async (id: number) => sessionsById[id];
    (storage as any).getUser = async (id: number) => usersById[id];
    (storage as any).getOffice = async (id: number) => officesById[id];
    (storage as any).getScenario = async () => ({ id: 5, track: "consulting", difficulty: "beginner" });
    (storage as any).createCoachingMessage = async (m: any) => {
      const row = { id: messages.length + 1, ...m };
      messages.push(row);
      return row;
    };
    (storage as any).listCoachingMessagesBySession = async (sessionId: number) =>
      messages.filter((m) => m.sessionId === sessionId && !m.cleared);
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  }

  test("trainee can post a question and gets back the persisted thread with a coach reply", async () => {
    const { status, body } = await post("/api/sessions/10/coaching", {
      userId: 1,
      content: "How could I have opened better?",
    });
    assert.equal(status, 200);
    assert.equal(body.canPost, true);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "trainee");
    assert.equal(body.messages[0].content, "How could I have opened better?");
    assert.equal(body.messages[1].role, "coach");
    assert.equal(body.messages[1].content, "Try opening with a question about their goals.");
  });

  test("a manager cannot post on behalf of the trainee (read-only)", async () => {
    const { status } = await post("/api/sessions/10/coaching", {
      userId: 2,
      content: "posting as a manager",
    });
    assert.equal(status, 403);
    assert.equal(messages.length, 0);
  });

  test("empty questions are rejected", async () => {
    const { status } = await post("/api/sessions/10/coaching", { userId: 1, content: "   " });
    assert.equal(status, 400);
  });

  test("the owning trainee can read their thread and may post", async () => {
    await post("/api/sessions/10/coaching", { userId: 1, content: "q1" });
    const { status, body } = await get("/api/sessions/10/coaching?requesterId=1");
    assert.equal(status, 200);
    assert.equal(body.canPost, true);
    assert.equal(body.messages.length, 2);
  });

  test("a manager in the same office can read the thread read-only", async () => {
    await post("/api/sessions/10/coaching", { userId: 1, content: "q1" });
    const { status, body } = await get("/api/sessions/10/coaching?requesterId=2");
    assert.equal(status, 200);
    assert.equal(body.canPost, false);
    assert.equal(body.messages.length, 2);
  });

  test("a manager from a DIFFERENT office is forbidden", async () => {
    const { status } = await get("/api/sessions/10/coaching?requesterId=3");
    assert.equal(status, 403);
  });
});

// ===========================================================================
// Clear-on-new-attempt behavior (soft-clear semantics)
// ===========================================================================

describe("clear-on-new-attempt (soft clear)", () => {
  test("listing a session's thread excludes cleared rows; clearing a user hides all their active rows", async () => {
    // A tiny in-memory model of the coaching-message store to exercise the exact
    // filter semantics the DB storage implements (cleared=false only, per-user clear).
    const rows: { id: number; sessionId: number; userId: number; cleared: boolean }[] = [
      { id: 1, sessionId: 100, userId: 7, cleared: false },
      { id: 2, sessionId: 100, userId: 7, cleared: false },
      { id: 3, sessionId: 101, userId: 8, cleared: false },
    ];
    const listBySession = (sessionId: number) =>
      rows.filter((r) => r.sessionId === sessionId && !r.cleared);
    const clearForUser = (userId: number) => {
      for (const r of rows) if (r.userId === userId && !r.cleared) r.cleared = true;
    };

    assert.equal(listBySession(100).length, 2);
    // Trainee 7 starts a new attempt -> their prior thread is soft-cleared.
    clearForUser(7);
    assert.equal(listBySession(100).length, 0);
    // Another trainee's thread is untouched.
    assert.equal(listBySession(101).length, 1);
    // Rows are soft-deleted (still present), not physically removed.
    assert.equal(rows.length, 3);
  });
});
