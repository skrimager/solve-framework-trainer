// Tests for the shared sentence-by-sentence reply stream.
//
// Two things are covered. First, the streaming core itself: sentences are
// emitted as they close rather than after the whole reply is generated, in
// order, with a per-sentence failure costing only that sentence. Second, and the
// reason the core exists as its own module, a byte-for-byte pin on what the real
// trainee session path derives and puts on the wire, so factoring the public
// demo onto the same streamer cannot quietly change real sessions.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { storage } from "./storage";
import { runTurnStream } from "./routes";
import { __setReplyStreamDepsForTests, historyForTurn } from "./turnStream";
import { sessionVariantSection } from "./persona";
import { getVoiceForScenario, getVoiceInstructionsForScenario } from "./voices";
import type { Scenario, Session, TranscriptMessage } from "@shared/schema";

type SentenceHandler = (sentence: string, index: number) => void;

// One `event: x\ndata: {...}` frame as written to the response.
type SseEvent = { event: string; data: any };

function parseSse(raw: string): SseEvent[] {
  return raw
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1] ?? "",
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}"),
    }));
}

// Minimal stand-in for the express Response the streamer writes to, recording
// headers and the raw SSE bytes in the order they were written.
function fakeResponse() {
  const headers: Record<string, string> = {};
  let body = "";
  let ended = false;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const notify = () => {
    const written = parseSse(body).length;
    for (const w of waiters.splice(0)) {
      if (written >= w.count) w.resolve();
      else waiters.push(w);
    }
  };
  return {
    headers,
    events: () => parseSse(body),
    // Resolves once `count` SSE frames have been written, so a test can observe
    // partial output without guessing how many microtasks that takes.
    waitForEvents: (count: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
        notify();
      }),
    res: {
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      flushHeaders: () => {},
      on: () => {},
      write: (chunk: string) => {
        body += chunk;
        notify();
        return true;
      },
      end: () => {
        ended = true;
      },
      get writableEnded() {
        return ended;
      },
    } as any,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SCENARIO = {
  id: 7,
  slug: "real-estate-first-time-buyer-anxious",
  title: "First-time buyer",
  difficulty: "beginner",
  active: true,
  briefing: "b",
  description: "d",
  customerPersona: "legacy persona",
  personaCore: "You are Priya, 27.",
  gender: "female",
  track: "consulting",
  vertical: "real_estate",
  transactionType: "re_buyer_agent",
} as unknown as Scenario;

const MSG_ID = "turn-stream-test-msg";

// A consultant turn followed by the empty placeholder the streamed turn fills in.
const TRANSCRIPT: TranscriptMessage[] = [
  { role: "customer", content: "What's the cheapest thing you've got?", timestamp: "t0" } as TranscriptMessage,
  { role: "consultant", content: "Tell me what you're hoping for.", timestamp: "t1" } as TranscriptMessage,
  {
    role: "customer",
    content: "",
    audioStatus: "pending",
    audioUrl: `/api/sessions/3/audio-stream/${MSG_ID}`,
    msgId: MSG_ID,
    timestamp: "t2",
  } as TranscriptMessage,
];

const SESSION = {
  id: 3,
  userId: 11,
  scenarioId: SCENARIO.id,
  status: "in_progress",
  transcript: JSON.stringify(TRANSCRIPT),
  personaVariant: null,
} as unknown as Session;

describe("historyForTurn", () => {
  test("drops the placeholder the turn is about to fill and keeps the rest in order", () => {
    assert.deepEqual(
      historyForTurn(TRANSCRIPT, MSG_ID).map((m) => m.content),
      ["What's the cheapest thing you've got?", "Tell me what you're hoping for."],
    );
  });
});

describe("real session turn stream", () => {
  let persisted: Array<{ content: string; status: string }>;
  let replyArgs: any[] | null;
  let synthesized: Array<{ text: string; voice: string; instructions?: string }>;

  // The real route's own call, reproduced exactly: same options, same voice
  // lookup, same persist target. Anything the route derives is derived inside
  // runTurnStream, which is the point of the pin.
  function runRealTurn(out = fakeResponse()) {
    return runTurnStream(out.res, {
      msgId: MSG_ID,
      session: SESSION,
      scenario: SCENARIO,
      voice: getVoiceForScenario(SCENARIO.slug, SCENARIO.gender),
      instructions: getVoiceInstructionsForScenario(SCENARIO.slug),
      persist: async (content, status) => {
        persisted.push({ content, status });
      },
    }).then(() => out);
  }

  beforeEach(() => {
    persisted = [];
    replyArgs = null;
    synthesized = [];
    // Escalation tier inputs: no completed sessions, so the tier stays at 0.
    (storage as any).listSessionsByUser = async () => [];
    (storage as any).listScenarios = async () => [SCENARIO];

    __setReplyStreamDepsForTests({
      streamReply: async (...args: any[]) => {
        replyArgs = args;
        const onSentence = args[5] as SentenceHandler;
        onSentence("Hi there.", 0);
        onSentence("I'm just looking.", 1);
        return "Hi there. I'm just looking.";
      },
      synthesize: async (text: string, voice: string, instructions?: string) => {
        synthesized.push({ text, voice, instructions });
        return Buffer.from("audio");
      },
    });
  });

  afterEach(() => __setReplyStreamDepsForTests(null));

  test("writes SSE headers with proxy buffering disabled", async () => {
    const out = await runRealTurn();
    assert.equal(out.headers["content-type"], "text/event-stream");
    assert.equal(out.headers["cache-control"], "no-cache, no-transform");
    assert.equal(out.headers["x-accel-buffering"], "no");
  });

  test("emits one ordered sentence event per sentence, then done", async () => {
    const out = await runRealTurn();
    assert.deepEqual(out.events(), [
      { event: "sentence", data: { index: 0, text: "Hi there.", audioUrl: `/api/audio/${MSG_ID}-0.mp3` } },
      { event: "sentence", data: { index: 1, text: "I'm just looking.", audioUrl: `/api/audio/${MSG_ID}-1.mp3` } },
      { event: "done", data: { msgId: MSG_ID, text: "Hi there. I'm just looking." } },
    ]);
  });

  test("passes the session's persona core, history, difficulty, tier and variant to the model", async () => {
    await runRealTurn();
    assert.ok(replyArgs);
    assert.equal(replyArgs![0], SCENARIO.personaCore);
    assert.deepEqual(replyArgs![1], historyForTurn(TRANSCRIPT, MSG_ID));
    assert.equal(replyArgs![2], "beginner");
    assert.equal(replyArgs![3], 0);
    assert.equal(replyArgs![4], sessionVariantSection(SCENARIO, SESSION));
  });

  test("synthesizes each sentence with the scenario's curated voice", async () => {
    await runRealTurn();
    assert.deepEqual(
      synthesized.map((s) => s.text),
      ["Hi there.", "I'm just looking."],
    );
    // real-estate-first-time-buyer-anxious is curated to "nova" (Priya, 27, f).
    assert.deepEqual([...new Set(synthesized.map((s) => s.voice))], ["nova"]);
  });

  test("persists the full reply once, marked ready", async () => {
    await runRealTurn();
    assert.deepEqual(persisted, [{ content: "Hi there. I'm just looking.", status: "ready" }]);
  });

  test("starts sending sentences before the reply has finished generating", async () => {
    const held = deferred();
    __setReplyStreamDepsForTests({
      streamReply: async (...args: any[]) => {
        const onSentence = args[5] as SentenceHandler;
        onSentence("First sentence.", 0);
        await held.promise;
        onSentence("Second sentence.", 1);
        return "First sentence. Second sentence.";
      },
      synthesize: async () => Buffer.from("audio"),
    });

    const out = fakeResponse();
    const done = runRealTurn(out);
    // Sentence one reaches the client while generation is still blocked on
    // `held`. A streamer that waited for the full reply would hang here.
    await out.waitForEvents(1);
    const early = out.events();
    assert.equal(early.length, 1);
    assert.equal(early[0].event, "sentence");
    assert.equal(early[0].data.text, "First sentence.");
    assert.equal(persisted.length, 0);

    held.resolve();
    await done;
    assert.deepEqual(
      out.events().map((e) => e.event),
      ["sentence", "sentence", "done"],
    );
  });

  test("a sentence whose audio fails still streams its text and does not kill the reply", async () => {
    __setReplyStreamDepsForTests({
      streamReply: async (...args: any[]) => {
        const onSentence = args[5] as SentenceHandler;
        onSentence("Good one.", 0);
        onSentence("Bad one.", 1);
        onSentence("Good again.", 2);
        return "Good one. Bad one. Good again.";
      },
      synthesize: async (text: string) => {
        if (text === "Bad one.") throw new Error("tts down");
        return Buffer.from("audio");
      },
    });

    const out = await runRealTurn();
    const events = out.events();
    assert.deepEqual(
      events.map((e) => e.event),
      ["sentence", "sentence", "sentence", "done"],
    );
    assert.equal(events[1].data.audioUrl, null);
    assert.equal(events[1].data.text, "Bad one.");
    assert.equal(events[2].data.audioUrl, `/api/audio/${MSG_ID}-2.mp3`);
    assert.equal(persisted[0].status, "ready");
  });

  test("a reply whose audio all fails is persisted as failed but still completes", async () => {
    __setReplyStreamDepsForTests({
      streamReply: async (...args: any[]) => {
        (args[5] as SentenceHandler)("Only one.", 0);
        return "Only one.";
      },
      synthesize: async () => {
        throw new Error("tts down");
      },
    });

    const out = await runRealTurn();
    assert.equal(out.events().at(-1)?.event, "done");
    assert.deepEqual(persisted, [{ content: "Only one.", status: "failed" }]);
  });

  test("a failed reply emits error and persists whatever text exists", async () => {
    __setReplyStreamDepsForTests({
      streamReply: async () => {
        throw new Error("model down");
      },
      synthesize: async () => Buffer.from("audio"),
    });

    const out = await runRealTurn();
    assert.deepEqual(out.events(), [{ event: "error", data: { message: "reply_failed" } }]);
    assert.deepEqual(persisted, [{ content: "", status: "failed" }]);
  });
});
