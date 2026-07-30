// Vapi <-> SOLVE transcript adapter (Vapi voice pilot, one scenario only).
//
// WHY THIS FILE EXISTS
// Two systems label the two speakers differently and neither can be changed:
//
//   Vapi / OpenAI chat-completions          SOLVE (shared/schema.ts)
//   ------------------------------          -----------------------
//   "user"       = the human on the mic  -> "consultant" (the rep being trained)
//   "assistant"  = the bot that replies  -> "customer"   (the simulated buyer)
//   "system"     = prompt scaffolding    -> dropped (not a spoken turn)
//
// That mapping is the whole point of the adapter, and getting it backwards is
// not a cosmetic bug: scoreTranscript() grades the CONSULTANT-labeled turns and
// explicitly refuses to credit the consultant for words on a CUSTOMER turn (see
// SPEAKER_ATTRIBUTION_RULES in server/llm.ts). Inverting the roles would credit
// the rep for the simulated customer's questions and silently corrupt every
// score for the pilot scenario.
//
// Deliberately a pure function over plain data with no schema change, no DB
// access, and no dependency on the Vapi SDK, so it is usable from the server
// route, from the client hook, and from tests without any of them.

import type { TranscriptMessage } from "./schema";

// The subset of an OpenAI-shaped chat message the adapter needs. Vapi posts this
// shape to a custom-LLM endpoint, and the same shape comes back to the browser
// on `conversation-update` as `messagesOpenAIFormatted`.
export interface VapiRoleMessage {
  role: string;
  content?: unknown;
}

// Vapi's browser-side `transcript` client message (one per partial/final
// utterance). Only finals are durable enough to score against.
export interface VapiTranscriptEvent {
  role: "assistant" | "user" | string;
  transcriptType?: "partial" | "final" | string;
  transcript?: string;
}

// The two roles SOLVE stores. Anything Vapi sends that is not a spoken turn by
// one of these two participants has no SOLVE equivalent and is dropped.
type SolveRole = TranscriptMessage["role"];

// The single source of truth for the speaker mapping. Returns null for roles
// that are not a spoken turn ("system", "tool", "function", anything unknown) so
// callers drop them instead of guessing a speaker.
export function solveRoleForVapiRole(role: string): SolveRole | null {
  if (role === "user") return "consultant";
  if (role === "assistant") return "customer";
  return null;
}

// Vapi sends `content` as a string for plain text turns, but the OpenAI shape
// also permits an array of content parts. Flatten to the text we can score;
// anything non-textual (images, audio refs) contributes nothing.
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

// Maps an OpenAI/Vapi-shaped message list onto the TranscriptMessage[] that
// getCustomerReply() and scoreTranscript() already consume.
//
// `timestamp` is required by transcriptMessageSchema but Vapi's custom-LLM
// payload carries no per-message time, so callers pass one clock reading for the
// whole batch. Ordering — which is what the scoring prompt actually reads — is
// preserved from the input array.
//
// Empty/whitespace-only turns are dropped: Vapi emits them when a turn is
// interrupted before any words land, and a blank turn would read to the scoring
// model as the rep or customer having said nothing on purpose.
export function vapiMessagesToTranscript(
  messages: readonly VapiRoleMessage[],
  timestamp: string = new Date().toISOString(),
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const message of messages) {
    const role = solveRoleForVapiRole(message.role);
    if (!role) continue;
    const content = textFromContent(message.content).trim();
    if (!content) continue;
    out.push({ role, content, timestamp });
  }
  return out;
}

// Maps the browser's stream of Vapi `transcript` client messages onto the same
// TranscriptMessage[] shape.
//
// Partials are dropped on purpose. Vapi emits a growing partial for every few
// words while someone is still talking ("So the", "So the monthly", ...); each
// final supersedes all partials before it, so keeping partials would duplicate
// most of the conversation.
//
// Consecutive finals from the SAME speaker are merged into one turn. The
// transcriber splits a long sentence with a mid-sentence pause into several
// finals, and the pilot exists precisely to make reps able to pause mid-sentence
// — leaving those as separate turns would make one sentence look like three
// clipped rep turns to the scoring model.
export function vapiTranscriptEventsToTranscript(
  events: readonly VapiTranscriptEvent[],
  timestamp: string = new Date().toISOString(),
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const event of events) {
    if (event.transcriptType && event.transcriptType !== "final") continue;
    const role = solveRoleForVapiRole(event.role);
    if (!role) continue;
    const content = (event.transcript ?? "").trim();
    if (!content) continue;
    const previous = out[out.length - 1];
    if (previous && previous.role === role) {
      previous.content = `${previous.content} ${content}`;
      continue;
    }
    out.push({ role, content, timestamp });
  }
  return out;
}
