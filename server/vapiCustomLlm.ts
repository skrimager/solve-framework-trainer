// OpenAI-compatible custom-LLM endpoint for the Vapi voice pilot.
//
// SCOPE: this route exists ONLY for the "auto-sales-growing-family-suv" (Priya)
// scenario. It is an additive, feature-flagged pilot of Vapi as a replacement for
// the browser voice pipeline (client-side turn detection + Web Speech API STT +
// OpenAI TTS), which cuts reps off mid-sentence. Nothing here is reachable from
// any other scenario, and the existing voice path is untouched.
//
// HOW VAPI USES THIS
// With `model.provider = "custom-llm"`, Vapi treats `model.url` as an OpenAI
// `baseURL` and POSTs to `<url>/chat/completions` with an OpenAI
// chat-completions body ({ model, messages, stream, ... }). It expects an SSE
// response: `data: {<chunk>}\n\n` per delta, terminated by `data: [DONE]\n\n`.
// Vapi streams whatever text we emit straight into TTS, so emitting the reply in
// a few chunks (rather than one blob) is what lets Priya start speaking promptly.
//
// WHAT IT DOES NOT DO
// It does not reimplement any conversation logic. The reply comes from the
// existing getCustomerReply() in server/llm.ts, using the persona and difficulty
// already defined for this scenario in server/seed.ts. Prompt construction,
// realism rules, escalation and scoring all stay where they are.

import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { getCustomerReply } from "./llm";
import { scenarios } from "./seed";
import { vapiMessagesToTranscript, type VapiRoleMessage } from "@shared/vapiTranscript";

// The ONE scenario this pilot serves. Every request is checked against this, so a
// misconfigured assistant cannot quietly start driving a different persona.
export const VAPI_PILOT_SCENARIO_SLUG = "auto-sales-growing-family-suv";

// Mounted under this prefix. The Vapi assistant's `model.url` is
// `<public origin>/api/vapi/<slug>` and Vapi appends `/chat/completions`.
export const VAPI_PILOT_ROUTE = `/api/vapi/${VAPI_PILOT_SCENARIO_SLUG}/chat/completions`;

// Resolves the pilot persona from the seed definitions rather than the database.
//
// Two reasons: the pilot must be reproducible from the codebase (no dashboard,
// no hand-edited rows), and this route is called by Vapi's servers outside any
// user session, so there is no session row to resolve a per-session persona
// rendition from.
//
// `personaCore` is preferred over the legacy `customerPersona` field, matching
// the precedence personaCoreFor() uses on the normal path (server/persona.ts).
// server/seed.ts stamps personaCore onto each seed row at module load from
// personaVariantSeed, so this is the same persona text production uses.
export function pilotScenario() {
  const scenario = scenarios.find((s) => s.slug === VAPI_PILOT_SCENARIO_SLUG);
  if (!scenario) {
    throw new Error(`Vapi pilot scenario "${VAPI_PILOT_SCENARIO_SLUG}" is missing from server/seed.ts`);
  }
  const persona =
    scenario.personaCore && scenario.personaCore.trim().length > 0
      ? scenario.personaCore
      : scenario.customerPersona;
  return { persona, difficulty: scenario.difficulty };
}

// One OpenAI-shaped streaming chunk. Vapi only reads `choices[0].delta.content`
// and the terminal `finish_reason`, but the surrounding envelope has to be
// well-formed for its OpenAI client to parse it at all.
function chunk(id: string, model: string, created: number, delta: object, finishReason: string | null): string {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// Splits the finished reply into SSE-sized pieces.
//
// getCustomerReply() is non-streaming — it returns the whole line at once — so
// there is no token stream to forward. We still chunk it on whitespace instead of
// sending one giant delta because Vapi begins synthesizing on the first chunks it
// receives; a single blob makes it wait for the entire body before any audio
// starts. Word-group chunks are a deliberately simple way to get that benefit
// without duplicating the sentence-splitting logic in server/sentences.ts, which
// the existing streaming path owns.
const WORDS_PER_CHUNK = 6;

export function splitReplyIntoDeltas(reply: string, wordsPerChunk: number = WORDS_PER_CHUNK): string[] {
  const words = reply.split(/(\s+)/).filter((w) => w.length > 0);
  const deltas: string[] = [];
  let current = "";
  let wordCount = 0;
  for (const token of words) {
    current += token;
    if (/\S/.test(token)) wordCount++;
    if (wordCount >= wordsPerChunk) {
      deltas.push(current);
      current = "";
      wordCount = 0;
    }
  }
  if (current.length > 0) deltas.push(current);
  return deltas;
}

// The complete SSE body for one reply, in order: the role-only opening delta
// OpenAI always sends, one frame per content chunk, a terminal frame carrying
// finish_reason, then the literal [DONE] sentinel Vapi's OpenAI client waits for.
// Built as a pure list of strings so the exact wire format can be asserted in
// tests without a live socket.
export function buildSseFrames(id: string, model: string, created: number, reply: string): string[] {
  return [
    chunk(id, model, created, { role: "assistant" }, null),
    ...splitReplyIntoDeltas(reply).map((delta) => chunk(id, model, created, { content: delta }, null)),
    chunk(id, model, created, {}, "stop"),
    "data: [DONE]\n\n",
  ];
}

// Narrow the incoming body to the two fields we use. Anything else Vapi sends
// (temperature, maxTokens, tools, metadata) is ignored on purpose: the reply is
// produced by our own prompt builder, so honouring model knobs from the caller
// would let the assistant config drift away from what the trainer scores.
function parseMessages(body: unknown): VapiRoleMessage[] | null {
  if (!body || typeof body !== "object") return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  return messages.filter(
    (m): m is VapiRoleMessage => !!m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string",
  );
}

export async function handleVapiChatCompletion(req: Request, res: Response): Promise<void> {
  const messages = parseMessages(req.body);
  if (!messages) {
    res.status(400).json({ error: { message: "Expected an OpenAI chat-completions body with a `messages` array." } });
    return;
  }

  // Vapi's system prompt and any tool turns are dropped here; the adapter keeps
  // only the two spoken roles and maps them onto SOLVE's consultant/customer
  // labels (see shared/vapiTranscript.ts for why the mapping matters).
  const transcript = vapiMessagesToTranscript(messages);
  const { persona, difficulty } = pilotScenario();

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof (req.body as { model?: unknown })?.model === "string" ? (req.body as { model: string }).model : "solve-priya-suv";

  let reply: string;
  try {
    // The existing engine, called exactly as the normal path calls it.
    //
    // escalationTier is 0 and variantSection is "" deliberately: both are
    // per-session state resolved from a session row, and a Vapi call has none.
    // Fixing them keeps the pilot persona identical on every call, which is what
    // makes an A/B voice comparison meaningful — the only thing changing between
    // test calls is the voice, not how tough Priya is.
    reply = await getCustomerReply(persona, transcript, difficulty, 0, "");
  } catch (err) {
    // Headers are not sent yet, so a plain JSON error is still possible and is
    // far easier for Vapi (and us) to diagnose than a truncated stream.
    console.error("[vapi-pilot] getCustomerReply failed:", err);
    res.status(502).json({ error: { message: "Customer reply generation failed." } });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Defeats proxy buffering, which would otherwise hold the whole stream and
  // erase the point of chunking.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  for (const frame of buildSseFrames(id, model, created, reply)) {
    res.write(frame);
  }
  res.end();
}

// Additive registration. Mounts exactly one path, scoped to the pilot scenario
// slug, so no existing route or scenario changes behaviour.
export function registerVapiPilotRoutes(app: Express): void {
  app.post(VAPI_PILOT_ROUTE, handleVapiChatCompletion);
}
