import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { TranscriptMessage } from "@shared/schema";
import {
  ACCEPTED_SOLUTION_RULES,
  GRACEFUL_RELEASE_RULES,
  SPEAKER_ATTRIBUTION_RULES,
  TIMING_FEEDBACK_RULES,
  TRANSCRIPT_FIDELITY_RULES,
  renderTranscriptForScoring,
  transcriptHeaderForScoring,
} from "./llm";
import { buildTimingGroundingBlock } from "./feedbackGrounding";

// Reuses the exact same OpenAI client setup as server/llm.ts: a default
// `new OpenAI()` that reads OPENAI_API_KEY from the environment (or, in the dev
// sandbox, the injected proxy credential). No new credential is introduced.
const client = new OpenAI();

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

// Mirrors llm.ts cacheKeyForPrefix — routes turns that share the same stable
// prefix (same session's feedback/transcript context) to the same cache.
function cacheKeyForPrefix(stablePrefix: string): string {
  return createHash("sha256").update(stablePrefix).digest("hex").slice(0, 32);
}

// One turn in the trainee <-> SOLVE Coach follow-up thread.
export type CoachingThreadMessage = { role: "trainee" | "coach"; content: string };

export type CoachingPromptParams = {
  track: string; // 'consulting' | 'leadership' — which rubric framing to coach from
  feedback: string; // the narrative rubric feedback already shown for this attempt
  rubricScoresJson: string | null; // per-dimension scores JSON (as stored on the session)
  overallScore: number | null; // 0-100 overall for this attempt
  transcript: TranscriptMessage[]; // the trainee's actual scenario transcript
  thread: CoachingThreadMessage[]; // prior Q&A turns for THIS attempt (oldest-first)
  question: string; // the trainee's new follow-up question / pushback
};

// The SOLVE Coach persona + rules. This is the byte-stable system block that
// leads every coaching prompt. It encodes the three product requirements that
// can't be left to the model's defaults:
//   1. Redundancy awareness — recognize when the trainee is re-asking the same
//      thing or the thread is going in circles, and redirect them to practice
//      live in another scenario rather than re-explaining endlessly.
//   2. Conditional transcript access — the Coach HAS the trainee's transcript
//      and should quote specific lines when the question calls for it, but should
//      answer general "why does this matter" questions from the framework without
//      forcing quotes in.
//   3. Discovery-training language only — never "sales" or "AI roleplay" framing.
export const COACHING_SYSTEM = `You are SOLVE Coach, a warm, encouraging discovery-training coach. A trainee has just finished a discovery-training scenario and read their rubric feedback. Now they can ask you follow-up questions or push back on the feedback, and you answer conversationally like a supportive human coach in a one-on-one debrief.

Ground rules (follow every turn):
- This is discovery-training / discovery-architecture practice. Coach uncovering real needs, building trust, and understanding — never persuasion or pressure tactics. NEVER use the words "sales", "selling", or "AI roleplay"; talk about discovery, conversations, and practice scenarios instead.
- Keep replies short and conversational — usually two to four sentences. This is a debrief chat, not an essay.
- Be specific and diagnostic. Tie your coaching to the discovery framework the trainee is being scored on (uncovering the real underlying need, preventing objections through early discovery, building trust independent of the outcome, natural next steps in the client's own words, and preserving the relationship).

${SPEAKER_ATTRIBUTION_RULES}

${TRANSCRIPT_FIDELITY_RULES}

${TIMING_FEEDBACK_RULES}

${ACCEPTED_SOLUTION_RULES}

${GRACEFUL_RELEASE_RULES}

Using the transcript (important, be judgment-based):
- You have the trainee's actual scenario transcript available below. Use it CONDITIONALLY. When the trainee's question is about what they actually said or how they could have phrased something ("what did I say", "how could I have asked that", "give me a better way to word X", before/after rewrites), quote or closely paraphrase the specific lines from their transcript and offer a concrete rewrite.
- When the question is general ("why does discovery matter", "what does trust-building mean"), answer from the framework and their feedback. Do NOT force transcript quotes in where they don't help.
- The rubric feedback above was written by the scorer, not by you, and it can contain a claim the transcript does not support. When the trainee pushes back on one ("I did ask about that, and early"), check the transcript and the timing pre-check before you answer. If they are right, say so plainly, drop the point, and coach them on something real instead of defending the feedback. Never restate a timing claim the pre-check contradicts, even to soften it.

Recognizing when to redirect (important — use your own judgment, no rigid counter):
- You are not limited in how many questions you'll answer, but watch for the conversation losing value. If the trainee is re-asking something you've already covered (even reworded), or the thread has run long without new substance, or they seem to be looking for reassurance rather than a new insight, gently say so and redirect: the fastest way to improve now is to run another practice scenario and apply this live, rather than keep talking it through. Suggest that warmly, in your own words — don't lecture, and don't refuse to answer, just steer them toward practicing.`;

// Builds the full coaching prompt. STABLE-PREFIX-FIRST like llm.ts: the system
// block + this attempt's feedback/scores/transcript (invariant across the
// thread's turns) lead, then the volatile Q&A thread + newest question last, so
// the stable prefix stays cacheable turn to turn.
export function buildCoachingStablePrefix(params: CoachingPromptParams): string {
  const { track, feedback, rubricScoresJson, overallScore, transcript } = params;
  const trackLabel =
    track === "leadership" ? "conflict-management / de-escalation" : "discovery-architecture";
  // Same numbered, explicitly-labeled rendering the rubric scorer uses, so the
  // Coach cannot mistake a customer line for something the trainee said.
  const rendered = renderTranscriptForScoring(transcript, {
    customer: "CUSTOMER",
    consultant: "TRAINEE",
  });
  const transcriptText = rendered
    ? `${transcriptHeaderForScoring(transcript)}\n${rendered}`
    : "(no transcript recorded)";
  const scoresLine =
    overallScore !== null ? `Overall score: ${overallScore}/100.` : "Overall score: (not scored).";
  const rubricLine = rubricScoresJson ? `Per-dimension scores (JSON): ${rubricScoresJson}` : "";

  // What the transcript actually contains on the topics the Coach gives timing
  // advice about, so a "you should have raised that earlier" answer cannot
  // contradict the trainee's own conversation. Empty for an empty transcript.
  const timingGrounding = buildTimingGroundingBlock(transcript, "TRAINEE");

  return [
    COACHING_SYSTEM,
    `This was a ${trackLabel} scenario.`,
    `${scoresLine}${rubricLine ? `\n${rubricLine}` : ""}`,
    `Rubric feedback the trainee already saw:\n${feedback || "(no narrative feedback recorded)"}`,
    `The trainee's scenario transcript (reference it only when the question calls for it):\n${transcriptText}`,
    timingGrounding,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function buildCoachingPrompt(params: CoachingPromptParams): string {
  const stablePrefix = buildCoachingStablePrefix(params);
  const threadText = params.thread
    .map((m) => `${m.role === "trainee" ? "Trainee" : "SOLVE Coach"}: ${m.content}`)
    .join("\n");
  const volatile = `Conversation so far:\n${threadText || "(this is the trainee's first follow-up)"}\n\nTrainee's new question:\n${params.question}\n\nRespond as SOLVE Coach with your next reply only — no labels, no narration.`;
  return `${stablePrefix}\n\n${volatile}`;
}

// Injectable responder so route tests can exercise the flow without hitting the
// network; production defaults to the shared OpenAI client (same call shape as
// llm.ts: client.responses.create -> output_text).
export type CoachingResponder = (input: string, cacheKey: string) => Promise<string>;

const defaultCoachingResponder: CoachingResponder = async (input, cacheKey) => {
  const response = await client.responses.create({
    model: CHAT_MODEL,
    input,
    prompt_cache_key: cacheKey,
  });
  return response.output_text || "";
};

export async function getCoachingReply(
  params: CoachingPromptParams,
  responder: CoachingResponder = defaultCoachingResponder
): Promise<string> {
  const input = buildCoachingPrompt(params);
  const cacheKey = cacheKeyForPrefix(buildCoachingStablePrefix(params));
  const raw = await responder(input, cacheKey);
  return (raw || "").trim();
}
