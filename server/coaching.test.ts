import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { storage } from "./storage";
import { registerCoachingRoutes } from "./routes";
import {
  COACHING_SYSTEM,
  buildCoachingPrompt,
  buildCoachingStablePrefix,
  buildStallChallengeAdjudicationPrompt,
  getCoachingReply,
  STALL_CHALLENGE_ADJUDICATION_INSTRUCTION,
  type CoachingResponder,
} from "./coaching";
import {
  ACCEPTED_SOLUTION_RULES,
  GRACEFUL_RELEASE_RULES,
  SPEAKER_ATTRIBUTION_RULES,
  STALL_DIAGNOSIS_RULES,
  TIMING_FEEDBACK_RULES,
  TRANSCRIPT_FIDELITY_RULES,
} from "./llm";
import type { TranscriptMessage } from "@shared/schema";

const TRANSCRIPT: TranscriptMessage[] = [
  { role: "customer", content: "Hi, I'm Sarah — just looking at options.", timestamp: "t1" },
  { role: "consultant", content: "Great, what brought you in today?", timestamp: "t2" },
  { role: "customer", content: "We're outgrowing our current place.", timestamp: "t3" },
];

type ProductionStallSession = { sessionId: number; transcript: string };
const PRODUCTION_STALL_SESSIONS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/wade-stall-sessions-528-530.json", import.meta.url)), "utf8"),
) as ProductionStallSession[];

function productionStallTranscript(sessionId: number): TranscriptMessage[] {
  const session = PRODUCTION_STALL_SESSIONS.find((candidate) => candidate.sessionId === sessionId);
  assert.ok(session, `missing production stall session ${sessionId}`);
  return JSON.parse(session.transcript) as TranscriptMessage[];
}

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

  // Part B. The Coach reads the same transcript the rubric scorer does, so it
  // inherits the same attribution and accepted-solution discipline; otherwise the
  // rubric could get it right and the follow-up chat could still tell the trainee
  // they asked a question the customer asked.
  test("inherits the shared speaker-attribution, fidelity, and accepted-solution rules", () => {
    assert.ok(COACHING_SYSTEM.includes(SPEAKER_ATTRIBUTION_RULES));
    assert.ok(COACHING_SYSTEM.includes(TRANSCRIPT_FIDELITY_RULES));
    assert.ok(COACHING_SYSTEM.includes(ACCEPTED_SOLUTION_RULES));
  });

  // Rule F. The rubric score and the follow-up chat have to agree. If the rubric
  // credits a graceful release but the Coach then tells the trainee they should
  // have pushed harder for a close, the trainee is coached back into the exact
  // behavior the rubric penalizes.
  test("inherits the graceful-release recognition so the Coach agrees with the rubric", () => {
    assert.ok(COACHING_SYSTEM.includes(GRACEFUL_RELEASE_RULES));
    assert.match(COACHING_SYSTEM, /DECLINING TO PROMISE THE IMPOSSIBLE IS A CORRECT ANSWER/);
    assert.match(COACHING_SYSTEM, /REFERRING A GENUINELY OUT-OF-SCOPE TECHNICAL QUESTION/);
  });

  test("inherits stall and objection diagnosis guidance for every SOLVE moment", () => {
    assert.ok(COACHING_SYSTEM.includes(STALL_DIAGNOSIS_RULES));
    assert.match(COACHING_SYSTEM, /STALL AND OBJECTION DEBRIEFS/);
    assert.match(COACHING_SYSTEM, /whether that was during discovery or near an ending/);
    assert.match(COACHING_SYSTEM, /make the customer a better decision-maker, not simply push for agreement/);
  });
});

// Rule 11. The live failure was in the Coach's voice: it told a trainee they
// needed to talk about financing earlier on a transcript where they had asked
// about budget, cash-versus-financing, and a trade-in three turns in. The Coach
// needs both halves of the fix: the rule that timing claims must be checked, and
// the per-attempt pre-check that says what this transcript actually contains.
describe("COACHING_SYSTEM - transcript-grounded timing feedback (Rule 11)", () => {
  test("inherits the shared timing-feedback rules", () => {
    assert.ok(COACHING_SYSTEM.includes(TIMING_FEEDBACK_RULES));
  });

  test("is told the rubric feedback it inherits can be wrong, and not to defend it", () => {
    assert.match(COACHING_SYSTEM, /timing pre-check/);
    assert.match(COACHING_SYSTEM, /Never restate a timing claim the pre-check contradicts/);
  });
});

describe("buildCoachingStablePrefix - the timing pre-check (Rule 11)", () => {
  // The reported scenario: comfort remark, then budget / cash-vs-financing /
  // trade-in on the very next turn.
  const COMFORT_THEN_BUDGET: TranscriptMessage[] = [
    { role: "consultant", content: "What brings you in today?", timestamp: "t1" },
    { role: "customer", content: "I want something with more comfort for my commute.", timestamp: "t2" },
    {
      role: "consultant",
      content: "What does your budget look like, and are you paying cash or financing? Any trade-in?",
      timestamp: "t3",
    },
    { role: "customer", content: "Financing, around twenty five thousand, and yes a trade-in.", timestamp: "t4" },
  ];

  function prefix(transcript: TranscriptMessage[], feedback: string) {
    return buildCoachingStablePrefix({
      track: "consulting",
      feedback,
      rubricScoresJson: null,
      overallScore: 84,
      transcript,
      thread: [],
      question: "I did ask about financing though, right at the start?",
    });
  }

  test("an early budget ask is stated as covered, so the Coach cannot say it came too late", () => {
    // The wrong feedback the trainee actually received is passed in, because the
    // Coach reads it as context and must not repeat it.
    const built = prefix(
      COMFORT_THEN_BUDGET,
      "You needed to talk about financing earlier in the conversation.",
    );
    assert.match(built, /TIMING PRE-CHECK/);
    assert.match(built, /ALREADY COVERED, and covered early/);
    assert.match(built, /The TRAINEE raised it themselves at turn 3 of 4/);
  });

  test("the pre-check sits after the transcript it was derived from", () => {
    const built = prefix(COMFORT_THEN_BUDGET, "Good start.");
    assert.ok(built.indexOf("[3] TRAINEE:") < built.indexOf("TIMING PRE-CHECK"));
  });

  test("a session with no transcript gets no pre-check block", () => {
    const built = prefix([], "Good start.");
    assert.ok(!built.includes("TIMING PRE-CHECK"));
  });
});

describe("coaching transcript rendering (Rule 9)", () => {
  test("turns are numbered and explicitly labeled CUSTOMER / TRAINEE", () => {
    const prefix = buildCoachingStablePrefix({
      track: "consulting",
      feedback: "f",
      rubricScoresJson: null,
      overallScore: null,
      transcript: [
        { role: "customer", content: "How do I know this will hold up?", timestamp: "t1" },
        { role: "consultant", content: "That's a fair thing to want.", timestamp: "t2" },
      ],
      thread: [],
      question: "q",
    });
    assert.ok(prefix.includes("[1] CUSTOMER: How do I know this will hold up?"));
    assert.ok(prefix.includes("[2] TRAINEE: That's a fair thing to want."));
  });

  test("an empty transcript still reads as an empty transcript, not as a phantom turn", () => {
    const prefix = buildCoachingStablePrefix({
      track: "consulting",
      feedback: "f",
      rubricScoresJson: null,
      overallScore: null,
      transcript: [],
      thread: [],
      question: "q",
    });
    assert.ok(prefix.includes("(no transcript recorded)"));
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

  test("includes stall and objection diagnosis guidance in the assembled coaching prompt", () => {
    const prompt = buildCoachingPrompt({
      track: "consulting",
      feedback: "The customer said they needed to talk to their partner.",
      rubricScoresJson: '{"objectionPrevention":60}',
      overallScore: 70,
      transcript: [
        { role: "consultant", content: "What are you comparing us against?", timestamp: "t1" },
        { role: "customer", content: "I need to talk to my partner.", timestamp: "t2" },
      ],
      thread: [],
      question: "How should I have handled that?",
    });
    assert.ok(prompt.includes(STALL_DIAGNOSIS_RULES));
    assert.match(prompt, /Do not argue with either one. Diagnose the decision behind it/);
    assert.match(prompt, /Ground the advice in the actual transcript and the exact SOLVE moment/);
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

describe("stall coaching challenge adjudication", () => {
  function stallParams(
    transcript: TranscriptMessage[],
    feedback: string,
    question: string,
    thread: Array<{ role: "trainee" | "coach"; content: string }> = [],
  ) {
    return {
      track: "consulting",
      feedback,
      rubricScoresJson: null,
      overallScore: 70,
      transcript,
      thread,
      question,
      stallType: "think_it_over",
    };
  }

  test("accepts a true session-528 challenge and explicitly concedes with the confirming turn", async () => {
    const params = stallParams(
      productionStallTranscript(528),
      "You should have asked what was making the customer uncertain about getting the roof fixed.",
      "I already asked that in turn 24.",
    );
    let seen = "";
    const responder: CoachingResponder = async (input) => {
      seen = input;
      return JSON.stringify({
        outcome: "accepted",
        coveredTraineeTurns: [24],
        laterCustomerEvidenceTurn: null,
        evidenceTerms: [],
        narrowerGap: null,
        ambiguity: null,
        noLaterEvidenceSupportsNarrower: true,
      });
    };

    const reply = await getCoachingReply(params, responder);
    assert.match(reply, /You(?:'re| are) right/i);
    assert.match(reply, /turn 24/i);
    assert.match(seen, /STALL COACHING STRUCTURED CHALLENGE DECISION/);
    assert.match(seen, /Turn 24: diagnostic question.*ALREADY COVERED by the TRAINEE/);
  });

  test("holds defensible session-529 advice only after acknowledging the covered question and narrower transcript gap", async () => {
    const params = stallParams(
      productionStallTranscript(529),
      'You asked about savings at turn 10, then could have followed up on the customer’s typical usage at turn 11.',
      "I already asked what savings he meant in turn 10, so why are you still recommending a question?",
    );
    let calls = 0;
    const responder: CoachingResponder = async (input) => {
      calls += 1;
      if (input.includes("NEUTRAL STALL CHALLENGE VERIFICATION")) {
        return JSON.stringify({
          outcome: "defensible",
          coveredTraineeTurns: [10],
          laterCustomerEvidenceTurn: 11,
          evidenceTerms: ["typical", "usage"],
          narrowerGap: "whether the estimate reflects typical usage",
          ambiguity: null,
          noLaterEvidenceSupportsNarrower: false,
        });
      }
      // The neutral verifier must override this overly-conceding first read
      // because the customer later supplied the distinct typical-usage issue.
      return JSON.stringify({
        outcome: "accepted",
        coveredTraineeTurns: [10],
        laterCustomerEvidenceTurn: null,
        evidenceTerms: [],
        narrowerGap: null,
        ambiguity: null,
        noLaterEvidenceSupportsNarrower: null,
      });
    };

    const reply = await getCoachingReply(params, responder);
    assert.match(reply, /turn 10/i);
    assert.match(reply, /turn 11/i);
    assert.match(reply, /still hold the narrower focus/i);
    assert.match(reply, /typical usage/i);
    assert.equal(calls, 2);
  });

  test("normalizes a contradictory accepted session-529 verifier result into constrained usage-pattern coaching", async () => {
    const params = stallParams(
      productionStallTranscript(529),
      "You asked about savings at turn 10, then could have followed up on the customer’s typical usage at turn 11.",
      "I already asked what savings he meant in turn 10, so why are you still recommending a question?",
    );
    let calls = 0;
    const responder: CoachingResponder = async (input) => {
      calls += 1;
      if (input.includes("NEUTRAL STALL CHALLENGE VERIFICATION")) {
        return JSON.stringify({
          outcome: "accepted",
          coveredTraineeTurns: [10],
          laterCustomerEvidenceTurn: 11,
          evidenceTerms: ["typical usage", "estimates"],
          narrowerGap: null,
          ambiguity: null,
          noLaterEvidenceSupportsNarrower: null,
        });
      }
      if (input.includes("prior decision failed validation")) {
        // The bounded correction repeats the contradictory shape. The
        // application must conservatively render the evidence-backed focus.
        return JSON.stringify({
          outcome: "accepted",
          coveredTraineeTurns: [10],
          laterCustomerEvidenceTurn: 11,
          evidenceTerms: ["typical usage", "estimates"],
          narrowerGap: null,
          ambiguity: null,
          noLaterEvidenceSupportsNarrower: null,
        });
      }
      return JSON.stringify({
        outcome: "accepted",
        coveredTraineeTurns: [10],
        laterCustomerEvidenceTurn: null,
        evidenceTerms: [],
        narrowerGap: null,
        ambiguity: null,
        noLaterEvidenceSupportsNarrower: null,
      });
    };

    const reply = await getCoachingReply(params, responder);
    assert.equal(calls, 3);
    assert.match(reply, /turn 10/i);
    assert.match(reply, /turn 11/i);
    assert.match(reply, /typical usage/i);
    assert.match(reply, /still hold the narrower focus/i);
  });

  test("handles an ambiguous challenge without overclaiming and asks only for the needed clarification", async () => {
    const ambiguousTranscript: TranscriptMessage[] = [
      { role: "customer", content: "I need more time to look at this.", timestamp: "t1" },
      { role: "consultant", content: "I can help with that.", timestamp: "t2" },
    ];
    const params = stallParams(
      ambiguousTranscript,
      "You may have moved past the request for more time too quickly.",
      "I already addressed that concern, didn't I?",
    );
    const responder: CoachingResponder = async () =>
      JSON.stringify({
        outcome: "ambiguous",
        coveredTraineeTurns: [2],
        laterCustomerEvidenceTurn: null,
        evidenceTerms: [],
        narrowerGap: null,
        ambiguity: "the transcript does not show what concern or information was explored",
        noLaterEvidenceSupportsNarrower: null,
      });

    const reply = await getCoachingReply(params, responder);
    assert.match(reply, /turn 2/i);
    assert.match(reply, /does not show/i);
    assert.match(reply, /avoid drawing a firmer conclusion/i);
  });

  test("keeps an accepted correction in the next stall-coaching prompt through the persisted thread context", () => {
    const correction =
      'You are right — turn 30 asked how to make the numbers solid, so I withdraw the generic data question.';
    const prompt = buildStallChallengeAdjudicationPrompt(
      stallParams(
        productionStallTranscript(530),
        "Ask what data would help alleviate the concern.",
        "What should I improve next?",
        [
          { role: "trainee", content: "I already asked that in turn 30." },
          { role: "coach", content: correction },
        ],
      ),
    );

    assert.ok(prompt.includes(correction));
    assert.ok(prompt.includes(STALL_CHALLENGE_ADJUDICATION_INSTRUCTION));
    assert.match(prompt, /Do NOT provide a narrower gap, later evidence, or a replacement critique/i);
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
  let scenarioForTest: any;
  let responderInputs: string[];

  before(async () => {
    const app = express();
    app.use(express.json());
    // Deterministic responder so no network is hit and the reply is assertable.
    registerCoachingRoutes(app, {
      responder: async (input) => {
        responderInputs.push(input);
        if (input.includes("STALL COACHING STRUCTURED CHALLENGE DECISION")) {
          if (input.includes("Trainee's new question:\nI already asked that in turn 30")) {
            return JSON.stringify({
              outcome: "accepted",
              coveredTraineeTurns: [30],
              laterCustomerEvidenceTurn: null,
              evidenceTerms: [],
              narrowerGap: null,
              ambiguity: null,
              noLaterEvidenceSupportsNarrower: true,
            });
          }
          return JSON.stringify({
            outcome: "not_a_challenge",
            coveredTraineeTurns: [30],
            laterCustomerEvidenceTurn: null,
            evidenceTerms: [],
            narrowerGap: null,
            ambiguity: null,
            noLaterEvidenceSupportsNarrower: null,
          });
        }
        return "Try opening with a question about their goals.";
      },
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
    responderInputs = [];
    scenarioForTest = { id: 5, track: "consulting", difficulty: "beginner", stallType: null };
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
    (storage as any).getScenario = async () => scenarioForTest;
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

  test("a true stall challenge is persisted as a correction and supplied to the next coaching turn", async () => {
    scenarioForTest = { id: 5, track: "consulting", difficulty: "beginner", stallType: "email_me_a_quote" };
    sessionsById[10].transcript = JSON.stringify(productionStallTranscript(530));
    sessionsById[10].feedback = "Ask what data would help alleviate the concern.";

    const first = await post("/api/sessions/10/coaching", {
      userId: 1,
      content: "I already asked that in turn 30.",
    });
    assert.equal(first.status, 200);
    assert.match(first.body.messages[1].content, /You(?:'re| are) right/i);
    assert.match(first.body.messages[1].content, /turn 30/i);

    const second = await post("/api/sessions/10/coaching", {
      userId: 1,
      content: "What should I improve next?",
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.messages.length, 4);
    assert.match(second.body.messages[3].content, /At turn 30/i);
    assert.ok(
      responderInputs.some((input) => input.includes("I withdraw that recommendation")),
      "the persisted accepted correction must be part of the next model context",
    );
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
