import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  VAPI_PILOT_SCENARIO_SLUG,
  VAPI_PILOT_ROUTE,
  splitReplyIntoDeltas,
  buildSseFrames,
  pilotScenario,
} from "./vapiCustomLlm";
import {
  solveRoleForVapiRole,
  vapiMessagesToTranscript,
  vapiTranscriptEventsToTranscript,
} from "@shared/vapiTranscript";
import { scenarios } from "./seed";

// Parses the SSE body back into the chunk objects Vapi's OpenAI client sees, so
// assertions are about the decoded stream rather than string shapes.
function parseFrames(frames: string[]) {
  return frames.map((frame) => {
    assert.ok(frame.startsWith("data: "), `frame is not an SSE data line: ${frame}`);
    assert.ok(frame.endsWith("\n\n"), `frame is not terminated by a blank line: ${frame}`);
    const payload = frame.slice("data: ".length, -2);
    return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
  });
}

describe("Vapi pilot scope", () => {
  test("serves exactly one scenario, and that scenario exists in the seed", () => {
    assert.equal(VAPI_PILOT_SCENARIO_SLUG, "auto-sales-growing-family-suv");
    const seeded = scenarios.find((s) => s.slug === VAPI_PILOT_SCENARIO_SLUG);
    assert.ok(seeded, "pilot scenario is missing from server/seed.ts");
  });

  test("route is scoped by slug and ends in the /chat/completions path Vapi appends", () => {
    assert.equal(VAPI_PILOT_ROUTE, `/api/vapi/${VAPI_PILOT_SCENARIO_SLUG}/chat/completions`);
  });

  // The pilot must drive the same Priya the rest of the app drives, not a
  // hand-written copy of her, and must take her difficulty from the seed rather
  // than hardcoding one.
  test("persona and difficulty resolve from the seed definition", () => {
    const seeded = scenarios.find((s) => s.slug === VAPI_PILOT_SCENARIO_SLUG)!;
    const { persona, difficulty } = pilotScenario();
    assert.equal(difficulty, seeded.difficulty);
    assert.ok(persona.length > 0);
    // personaCore takes precedence over the legacy customerPersona field, matching
    // personaCoreFor() on the normal path.
    const expected =
      seeded.personaCore && seeded.personaCore.trim().length > 0 ? seeded.personaCore : seeded.customerPersona;
    assert.equal(persona, expected);
  });
});

describe("splitReplyIntoDeltas", () => {
  test("reassembles to the original reply exactly", () => {
    const reply = "I'm seven months pregnant, so the third row matters more than the price.";
    assert.equal(splitReplyIntoDeltas(reply).join(""), reply);
  });

  test("emits more than one chunk for a reply long enough to stream", () => {
    const reply = "one two three four five six seven eight nine ten eleven twelve";
    assert.ok(splitReplyIntoDeltas(reply).length > 1);
  });

  test("a short reply is a single chunk", () => {
    assert.deepEqual(splitReplyIntoDeltas("Sure."), ["Sure."]);
  });

  test("an empty reply produces no chunks", () => {
    assert.deepEqual(splitReplyIntoDeltas(""), []);
  });

  test("whitespace and punctuation survive chunking", () => {
    const reply = "Well...  hold on.\nLet me think — about four hundred?";
    assert.equal(splitReplyIntoDeltas(reply, 2).join(""), reply);
  });
});

describe("buildSseFrames", () => {
  const frames = buildSseFrames("chatcmpl-test", "solve-priya-suv", 1700000000, "one two three four five six seven");
  const parsed = parseFrames(frames);

  test("opens with a role-only delta", () => {
    assert.equal(parsed[0].choices[0].delta.role, "assistant");
    assert.equal(parsed[0].choices[0].delta.content, undefined);
  });

  test("terminates with a stop frame followed by [DONE]", () => {
    assert.equal(parsed[parsed.length - 1], "[DONE]");
    assert.equal(parsed[parsed.length - 2].choices[0].finish_reason, "stop");
  });

  test("only the terminal frame carries finish_reason", () => {
    for (const frame of parsed.slice(0, -2)) {
      assert.equal(frame.choices[0].finish_reason, null);
    }
  });

  test("content frames concatenate back to the reply", () => {
    const content = parsed
      .slice(1, -2)
      .map((frame: { choices: { delta: { content?: string } }[] }) => frame.choices[0].delta.content ?? "")
      .join("");
    assert.equal(content, "one two three four five six seven");
  });

  test("every frame is a well-formed chat.completion.chunk with a stable id", () => {
    for (const frame of parsed.slice(0, -1)) {
      assert.equal(frame.object, "chat.completion.chunk");
      assert.equal(frame.id, "chatcmpl-test");
      assert.equal(frame.model, "solve-priya-suv");
      assert.equal(frame.created, 1700000000);
      assert.equal(frame.choices[0].index, 0);
    }
  });
});

// Getting this mapping backwards would credit the rep for the simulated
// customer's words, which SPEAKER_ATTRIBUTION_RULES in server/llm.ts exists to
// prevent. These assertions are the guard.
describe("Vapi -> SOLVE role mapping", () => {
  test("Vapi's user is SOLVE's consultant and Vapi's assistant is SOLVE's customer", () => {
    assert.equal(solveRoleForVapiRole("user"), "consultant");
    assert.equal(solveRoleForVapiRole("assistant"), "customer");
  });

  test("non-spoken roles have no SOLVE equivalent", () => {
    assert.equal(solveRoleForVapiRole("system"), null);
    assert.equal(solveRoleForVapiRole("tool"), null);
    assert.equal(solveRoleForVapiRole("function"), null);
    assert.equal(solveRoleForVapiRole("bot"), null);
  });
});

describe("vapiMessagesToTranscript", () => {
  test("drops the system prompt and preserves order", () => {
    const transcript = vapiMessagesToTranscript([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi Priya, what brings you in today?" },
      { role: "assistant", content: "We need more room — baby number two." },
      { role: "user", content: "Congratulations! Tell me about your current car." },
    ]);
    assert.deepEqual(
      transcript.map((m) => m.role),
      ["consultant", "customer", "consultant"],
    );
    assert.equal(transcript[0].content, "Hi Priya, what brings you in today?");
  });

  test("flattens array content parts and ignores non-text parts", () => {
    const transcript = vapiMessagesToTranscript([
      { role: "user", content: [{ type: "text", text: "So the payment" }, { type: "image_url" }, "would be"] },
    ]);
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0].content, "So the payment would be");
  });

  test("blank turns are dropped rather than stored as empty messages", () => {
    const transcript = vapiMessagesToTranscript([
      { role: "user", content: "   " },
      { role: "assistant", content: "" },
      { role: "user" },
      { role: "user", content: "Still there?" },
    ]);
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0].content, "Still there?");
  });

  test("every message carries the timestamp required by transcriptMessageSchema", () => {
    const transcript = vapiMessagesToTranscript([{ role: "user", content: "Hello" }], "2026-01-01T00:00:00.000Z");
    assert.equal(transcript[0].timestamp, "2026-01-01T00:00:00.000Z");
  });
});

describe("vapiTranscriptEventsToTranscript", () => {
  test("partials are dropped so the conversation is not duplicated", () => {
    const transcript = vapiTranscriptEventsToTranscript([
      { role: "user", transcriptType: "partial", transcript: "So the" },
      { role: "user", transcriptType: "partial", transcript: "So the monthly" },
      { role: "user", transcriptType: "final", transcript: "So the monthly payment." },
    ]);
    assert.deepEqual(transcript.map((m) => m.content), ["So the monthly payment."]);
  });

  // This is the pilot's whole reason for existing: a rep pausing mid-sentence
  // produces several finals, and they must read as ONE rep turn, not three
  // clipped ones.
  test("consecutive finals from the same speaker merge into one turn", () => {
    const transcript = vapiTranscriptEventsToTranscript([
      { role: "user", transcriptType: "final", transcript: "So the monthly payment would be" },
      { role: "user", transcriptType: "final", transcript: "let me pull up the exact number" },
      { role: "user", transcriptType: "final", transcript: "around four hundred and twenty dollars." },
      { role: "assistant", transcriptType: "final", transcript: "That's higher than we hoped." },
    ]);
    assert.equal(transcript.length, 2);
    assert.equal(
      transcript[0].content,
      "So the monthly payment would be let me pull up the exact number around four hundred and twenty dollars.",
    );
    assert.equal(transcript[0].role, "consultant");
    assert.equal(transcript[1].role, "customer");
  });

  test("alternating speakers stay as separate turns", () => {
    const transcript = vapiTranscriptEventsToTranscript([
      { role: "user", transcriptType: "final", transcript: "What matters most?" },
      { role: "assistant", transcriptType: "final", transcript: "Space." },
      { role: "user", transcriptType: "final", transcript: "Tell me more." },
    ]);
    assert.deepEqual(transcript.map((m) => m.role), ["consultant", "customer", "consultant"]);
  });

  test("events with no transcriptType are treated as final", () => {
    const transcript = vapiTranscriptEventsToTranscript([{ role: "user", transcript: "Hello there." }]);
    assert.equal(transcript.length, 1);
  });

  test("empty finals are dropped and do not break the merge chain", () => {
    const transcript = vapiTranscriptEventsToTranscript([
      { role: "user", transcriptType: "final", transcript: "First part" },
      { role: "user", transcriptType: "final", transcript: "   " },
      { role: "user", transcriptType: "final", transcript: "second part." },
    ]);
    assert.deepEqual(transcript.map((m) => m.content), ["First part second part."]);
  });
});
