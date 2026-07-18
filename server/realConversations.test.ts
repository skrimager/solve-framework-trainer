import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerRealConversationRoutes, withStalledStep } from "./routes";
import {
  parsePastedTranscript,
  parseAudioTranscript,
  deriveStalledStep,
  isValidSubmissionType,
  isAllowedAudioFile,
  REAL_CONVERSATION_CONSENT_TEXT,
  MAX_AUDIO_BYTES,
  type RealConversationScorer,
  type RealConversationTranscriber,
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
  test("text_chat, email, and audio are the valid submission types", () => {
    assert.equal(isValidSubmissionType("text_chat"), true);
    assert.equal(isValidSubmissionType("email"), true);
    assert.equal(isValidSubmissionType("audio"), true);
    assert.equal(isValidSubmissionType(""), false);
    assert.equal(isValidSubmissionType("phone"), false);
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
      "Me: Great, what brought you in today?",
      "Customer: We're outgrowing our current place.",
    ].join("\n");
    const parsed = parsePastedTranscript(raw, "text_chat");
    assert.deepEqual(
      parsed.map((m) => m.role),
      ["customer", "consultant", "customer"],
    );
    assert.equal(parsed[1].content, "Great, what brought you in today?");
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
    const raw = ["We're just browsing.", "Happy to help, what matters most to you?"].join("\n");
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
  test("a single clearly-worst dimension picks that step", () => {
    // Only needsDiscovery (40) is below the failure bar -> maps to "Listen".
    const rubric: RubricScores = {
      trustBuilding: 82,
      objectionPrevention: 78,
      needsDiscovery: 40,
      relationshipContinuity: 90,
      naturalClose: 75,
    };
    assert.equal(deriveStalledStep(rubric), "Listen");
  });

  test("multiple failing dimensions return the EARLIEST in SOLVE sequence, not the lowest-scoring", () => {
    // Situation (trustBuilding=2) and Engineer the Solution (naturalClose=1) are
    // both below the failure bar. Engineer scores lower, but the earliest failure
    // in the canonical SOLVE sequence is the root cause, so we return "Situation".
    const rubric: RubricScores = {
      trustBuilding: 2,
      objectionPrevention: 90,
      needsDiscovery: 88,
      relationshipContinuity: 85,
      naturalClose: 1,
    };
    assert.equal(deriveStalledStep(rubric), "Situation");
  });

  test("a mid-sequence breakdown is chosen over a lower-scoring downstream step", () => {
    // Open (objectionPrevention=55) and Engineer the Solution (naturalClose=20)
    // both fail; Open comes first in SOLVE sequence, so it is the stalled step.
    const rubric: RubricScores = {
      trustBuilding: 80,
      objectionPrevention: 55,
      needsDiscovery: 78,
      relationshipContinuity: 82,
      naturalClose: 20,
    };
    assert.equal(deriveStalledStep(rubric), "Open");
  });

  test("with no breakdown (all scores above threshold) it falls back to the single lowest step", () => {
    // Every dimension is comfortably above the failure bar, so nothing "failed".
    // The field is still populated with the lowest-scoring step for coaching:
    // objectionPrevention (70) is lowest -> "Open".
    const rubric: RubricScores = {
      trustBuilding: 88,
      objectionPrevention: 70,
      needsDiscovery: 82,
      relationshipContinuity: 95,
      naturalClose: 78,
    };
    assert.equal(deriveStalledStep(rubric), "Open");
  });

  test("SAMPLE_RUBRIC (needsDiscovery weakest) still stalls at Listen", () => {
    // Regression: needsDiscovery (40) and naturalClose (60) are both at/below the
    // bar; Listen precedes Engineer the Solution in SOLVE sequence.
    assert.equal(deriveStalledStep(SAMPLE_RUBRIC), "Listen");
  });

  test("returns null when there is no rubric", () => {
    assert.equal(deriveStalledStep(null), null);
    assert.equal(deriveStalledStep(undefined), null);
  });
});

// The GET /api/sessions/:id response attaches a derived, presentation-only
// "Where it stalled" step for the PRACTICE results page. It reuses the same
// SOLVE-sequence-earliest-failure logic as deriveStalledStep, so a practice
// session's returned value must reflect that logic, and it must be null for a
// leadership/conflict-management session (SOLVE steps do not apply there).
describe("withStalledStep (practice session response)", () => {
  function sessionWithRubric(rubric: unknown): any {
    return {
      id: 1,
      userId: 1,
      scenarioId: 5,
      status: "completed",
      transcript: "[]",
      score: 40,
      rubricScores: rubric === null ? null : JSON.stringify(rubric),
      feedback: "f",
      createdAt: "t",
      completedAt: "t",
      savedAt: null,
    };
  }

  test("returns the EARLIEST failing SOLVE step, not the lowest-scoring one", () => {
    // Situation (trustBuilding=2) and Engineer the Solution (naturalClose=1) both
    // fail; the earliest in SOLVE sequence is the root cause -> "Situation".
    const result = withStalledStep(
      sessionWithRubric({
        trustBuilding: 2,
        objectionPrevention: 90,
        needsDiscovery: 88,
        relationshipContinuity: 85,
        naturalClose: 1,
      }),
    );
    assert.equal(result.stalledStep, "Situation");
  });

  test("falls back to the single lowest step when nothing failed", () => {
    const result = withStalledStep(
      sessionWithRubric({
        trustBuilding: 88,
        objectionPrevention: 70,
        needsDiscovery: 82,
        relationshipContinuity: 95,
        naturalClose: 78,
      }),
    );
    assert.equal(result.stalledStep, "Open");
  });

  test("is null for a leadership/conflict-management rubric (no SOLVE steps)", () => {
    const result = withStalledStep(
      sessionWithRubric({
        activeListening: 10,
        empathyAcknowledgment: 20,
        rootCauseDiscovery: 30,
        solutionVisualization: 40,
        blamelessResolution: 50,
      }),
    );
    assert.equal(result.stalledStep, null);
  });

  test("is null when the session has not been scored yet", () => {
    assert.equal(withStalledStep(sessionWithRubric(null)).stalledStep, null);
  });
});

describe("audio file validation (Phase 2)", () => {
  test("accepts only mp3/m4a/wav by extension, case-insensitively", () => {
    assert.equal(isAllowedAudioFile("call.mp3"), true);
    assert.equal(isAllowedAudioFile("call.M4A"), true);
    assert.equal(isAllowedAudioFile("Recording.WAV"), true);
    assert.equal(isAllowedAudioFile("call.txt"), false);
    assert.equal(isAllowedAudioFile("call.mp4"), false);
    assert.equal(isAllowedAudioFile("call"), false);
    assert.equal(isAllowedAudioFile(undefined), false);
    assert.equal(isAllowedAudioFile(null), false);
  });
});

describe("parseAudioTranscript (Phase 2)", () => {
  test("alternates roles across Whisper segments, starting with the customer", () => {
    const parsed = parseAudioTranscript("ignored when segments present", [
      { text: "Hi, I'm just looking at options." },
      { text: "Great, what brought you in today?" },
      { text: "We're outgrowing our current place." },
    ]);
    assert.deepEqual(
      parsed.map((m) => m.role),
      ["customer", "consultant", "customer"],
    );
    assert.equal(parsed[1].content, "Great, what brought you in today?");
  });

  test("falls back to sentence splitting when no segments are provided", () => {
    const parsed = parseAudioTranscript(
      "We're just browsing. Happy to help, what matters most to you?",
    );
    assert.deepEqual(
      parsed.map((m) => m.role),
      ["customer", "consultant"],
    );
  });

  test("produces the TranscriptMessage fields the engine expects", () => {
    const parsed = parseAudioTranscript("A single sentence.");
    assert.equal(parsed.length, 1);
    for (const m of parsed) {
      assert.ok(typeof m.role === "string");
      assert.ok(typeof m.content === "string");
      assert.ok(typeof m.timestamp === "string");
    }
  });

  test("empty/blank transcripts yield no messages", () => {
    assert.equal(parseAudioTranscript("").length, 0);
    assert.equal(parseAudioTranscript("   \n  ").length, 0);
  });
});

// ===========================================================================
// Routes: bare express app, injected scorer, stubbed storage
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
    (storage as any).listRealConversationsBySubjectRep = async (repId: number) =>
      created.filter((r) => r.subjectRepUserId === repId).reverse();
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

  test("the JSON paste route rejects 'audio' (audio has its own upload route)", async () => {
    const { status } = await post({ ...VALID_BODY, submissionType: "audio" });
    assert.equal(status, 400);
    assert.equal(created.length, 0);
  });

  test("the JSON paste route rejects an unknown submission type", async () => {
    const { status } = await post({ ...VALID_BODY, submissionType: "phone" });
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

// ===========================================================================
// Audio upload route (Phase 2): multipart upload, injected transcriber (no
// network/Whisper), same scorer injection, stubbed storage. Verifies file-type
// and size validation, the consent gate, and output-shape parity with paste.
// ===========================================================================

// A deterministic stand-in for the Whisper call with the SAME signature/return
// shape, so route tests never hit OpenAI. Records what it was called with.
function makeFakeTranscriber(result: {
  text: string;
  duration?: number;
  segments?: { text: string }[];
}) {
  const calls: { buffer: Buffer; filename: string; mimetype: string }[] = [];
  const transcriber: RealConversationTranscriber = async (input) => {
    calls.push(input);
    return result;
  };
  return { transcriber, calls };
}

describe("real conversation audio route", () => {
  let server: Server;
  let baseUrl: string;
  let created: any[];
  let usersById: Record<number, any>;
  let officesById: Record<number, any>;
  let fakeScorer: ReturnType<typeof makeFakeScorer>;
  let fakeTranscriber: ReturnType<typeof makeFakeTranscriber>;

  before(async () => {
    const app = express();
    app.use(express.json());
    fakeScorer = makeFakeScorer(SAMPLE_RUBRIC, "Solid rapport, weak needs discovery.", 68);
    fakeTranscriber = makeFakeTranscriber({
      text: "Hi, just looking. Great, what brought you in today? We're outgrowing our place.",
      duration: 120,
      segments: [
        { text: "Hi, just looking." },
        { text: "Great, what brought you in today?" },
        { text: "We're outgrowing our place." },
      ],
    });
    registerRealConversationRoutes(app, {
      scorer: fakeScorer.scorer,
      transcriber: fakeTranscriber.transcriber,
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
    created = [];
    fakeScorer.calls.length = 0;
    fakeTranscriber.calls.length = 0;
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
    (storage as any).listRealConversationsBySubjectRep = async (repId: number) =>
      created.filter((r) => r.subjectRepUserId === repId).reverse();
  });

  async function postAudio(opts: {
    userId?: unknown;
    consentAccepted?: unknown;
    filename?: string;
    mimetype?: string;
    bytes?: Buffer;
    omitFile?: boolean;
  }) {
    const form = new FormData();
    if (opts.userId !== undefined) form.append("userId", String(opts.userId));
    if (opts.consentAccepted !== undefined)
      form.append("consentAccepted", String(opts.consentAccepted));
    if (!opts.omitFile) {
      const bytes = opts.bytes ?? Buffer.from("fake-audio-bytes");
      form.append(
        "audio",
        new Blob([bytes], { type: opts.mimetype ?? "audio/mpeg" }),
        opts.filename ?? "call.mp3",
      );
    }
    const res = await fetch(`${baseUrl}/api/real-conversations/audio`, {
      method: "POST",
      body: form,
    });
    return { status: res.status, body: await res.json() };
  }

  test("FILE TYPE: a non mp3/m4a/wav file is rejected and nothing is transcribed or stored", async () => {
    const { status } = await postAudio({
      userId: 1,
      consentAccepted: true,
      filename: "notes.txt",
      mimetype: "text/plain",
    });
    assert.equal(status, 400);
    assert.equal(created.length, 0);
    assert.equal(fakeTranscriber.calls.length, 0);
    assert.equal(fakeScorer.calls.length, 0);
  });

  test("FILE SIZE: a file over 25MB is rejected before transcription", async () => {
    const tooBig = Buffer.alloc(MAX_AUDIO_BYTES + 1024, 0);
    const { status } = await postAudio({
      userId: 1,
      consentAccepted: true,
      filename: "call.mp3",
      bytes: tooBig,
    });
    assert.equal(status, 400);
    assert.equal(created.length, 0);
    assert.equal(fakeTranscriber.calls.length, 0);
  });

  test("CONSENT GATE: an audio submission without consent is rejected, nothing transcribed or stored", async () => {
    const { status, body } = await postAudio({
      userId: 1,
      consentAccepted: false,
      filename: "call.mp3",
    });
    assert.equal(status, 400);
    assert.equal(body.message, REAL_CONVERSATION_CONSENT_TEXT);
    assert.equal(created.length, 0);
    assert.equal(fakeTranscriber.calls.length, 0, "the transcriber must not run without consent");
    assert.equal(fakeScorer.calls.length, 0, "the scorer must not run without consent");
  });

  test("SEAT GATE: an unpaid seat cannot submit audio (402)", async () => {
    const { status } = await postAudio({ userId: 2, consentAccepted: true, filename: "call.mp3" });
    assert.equal(status, 402);
    assert.equal(created.length, 0);
    assert.equal(fakeTranscriber.calls.length, 0);
  });

  test("SHAPE PARITY: a consented audio submission is transcribed, scored, and stored in the SAME shape as text/email", async () => {
    const { status, body } = await postAudio({
      userId: 1,
      consentAccepted: true,
      filename: "discovery-call.m4a",
      mimetype: "audio/x-m4a",
    });
    assert.equal(status, 200);

    // Same scoring fields a practice/paste submission persists.
    assert.equal(typeof body.overallScore, "number");
    assert.equal(body.overallScore, 68);
    assert.equal(typeof body.feedback, "string");

    // rubricScores is JSON text with the EXACT practice keys.
    const rubric = JSON.parse(body.rubricScores);
    assert.deepEqual(Object.keys(rubric).sort(), [...PRACTICE_RUBRIC_KEYS].sort());
    for (const key of PRACTICE_RUBRIC_KEYS) {
      assert.equal(typeof rubric[key], "number");
    }

    // Audio-specific persistence: submission type + original filename + transcript.
    assert.equal(body.submissionType, "audio");
    assert.equal(body.originalAudioFilename, "discovery-call.m4a");
    assert.ok(body.rawTranscript.length > 0);

    // Consent + subject are stored exactly as the paste route stores them.
    assert.equal(body.consentAccepted, true);
    assert.ok(body.consentAcceptedAt);
    assert.equal(body.submittedByUserId, 1);
    assert.equal(body.subjectRepUserId, 1);
    assert.equal(body.stalledStep, "Listen");

    // Transcriber ran once with the uploaded bytes; scorer received parsed turns.
    assert.equal(fakeTranscriber.calls.length, 1);
    assert.ok(Buffer.isBuffer(fakeTranscriber.calls[0].buffer));
    assert.equal(fakeScorer.calls.length, 1);
    assert.ok(fakeScorer.calls[0].every((m) => "role" in m && "content" in m));
  });

  test("DURATION CAP: audio longer than ~30 min (per the transcriber's reported duration) is rejected and not stored", async () => {
    const longTranscriber = makeFakeTranscriber({
      text: "A long conversation.",
      duration: 31 * 60,
    });
    const longApp = express();
    longApp.use(express.json());
    registerRealConversationRoutes(longApp, {
      scorer: fakeScorer.scorer,
      transcriber: longTranscriber.transcriber,
    });
    const longServer = longApp.listen(0);
    await new Promise<void>((resolve) => longServer.on("listening", () => resolve()));
    const addr = longServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const form = new FormData();
    form.append("userId", "1");
    form.append("consentAccepted", "true");
    form.append("audio", new Blob([Buffer.from("x")], { type: "audio/wav" }), "long.wav");
    const res = await fetch(`http://127.0.0.1:${port}/api/real-conversations/audio`, {
      method: "POST",
      body: form,
    });
    assert.equal(res.status, 400);
    assert.equal(created.length, 0);
    longServer.close();
  });

  test("TRANSCRIPTION FAILURE: a Whisper error returns an error and creates no row", async () => {
    const failingTranscriber: RealConversationTranscriber = async () => {
      throw new Error("whisper exploded");
    };
    const failApp = express();
    failApp.use(express.json());
    registerRealConversationRoutes(failApp, {
      scorer: fakeScorer.scorer,
      transcriber: failingTranscriber,
    });
    const failServer = failApp.listen(0);
    await new Promise<void>((resolve) => failServer.on("listening", () => resolve()));
    const addr = failServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const form = new FormData();
    form.append("userId", "1");
    form.append("consentAccepted", "true");
    form.append("audio", new Blob([Buffer.from("x")], { type: "audio/mpeg" }), "call.mp3");
    const res = await fetch(`http://127.0.0.1:${port}/api/real-conversations/audio`, {
      method: "POST",
      body: form,
    });
    assert.equal(res.status, 502);
    assert.equal(created.length, 0);
    assert.equal(fakeScorer.calls.length, 0);
    failServer.close();
  });
});
