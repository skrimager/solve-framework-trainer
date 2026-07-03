import OpenAI from "openai";
import type { TranscriptMessage, RubricScores } from "@shared/schema";

const client = new OpenAI();
// Uses a real OpenAI model name for production (Render). In the Perplexity
// sandbox dev environment, the proxy also accepts this and routes it through
// the injected llm-api:website credential.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";

// Generates speech audio for a simulated customer's line using OpenAI TTS.
// Runs directly in Node so it works identically in the dev sandbox and on
// Render production — no external sidecar process required.
export async function synthesizeSpeech(text: string, voice: string): Promise<Buffer> {
  const response = await client.audio.speech.create({
    model: TTS_MODEL,
    voice: voice as any,
    input: text,
    response_format: "mp3",
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Generates the simulated customer's next reply in a discovery-training role-play.
export async function getCustomerReply(
  customerPersona: string,
  transcript: TranscriptMessage[]
): Promise<string> {
  const history = transcript
    .map((m) => `${m.role === "customer" ? "Customer (you)" : "Consultant"}: ${m.content}`)
    .join("\n");

  const input = `${customerPersona}\n\nConversation so far:\n${history || "(The consultant is about to greet you.)"}\n\nRespond with your next line as the customer, in character. Output ONLY the spoken line, no labels or narration.`;

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input,
  });

  return (response.output_text || "").trim();
}

const RUBRIC_SYSTEM = `You are scoring a discovery-training role-play transcript. This is discovery architecture practice — NOT sales training — so evaluate the consultant's ability to uncover real customer needs and build trust through understanding, not persuasion tactics.

Score each dimension 0-100:
- needsDiscovery: Did the consultant uncover the customer's real underlying need ("the hole"), not just react to the stated request ("the drill")?
- objectionPrevention: Did early, deep discovery questions prevent objections from arising, rather than the consultant only reacting to objections after they came up?
- trustBuilding: Did the consultant build trust as a signal independent of whether/how the conversation closed — through genuine curiosity, active listening, and patience?
- naturalClose: If the conversation reached a close or next step, did it feel like a natural next step that referenced the customer's own words/needs, rather than a pressure-based push?
- relationshipContinuity: Did the consultant establish a clear, low-pressure follow-up or next step that preserves the relationship regardless of outcome?

Return ONLY valid JSON matching this shape, no other text:
{"needsDiscovery": number, "objectionPrevention": number, "trustBuilding": number, "naturalClose": number, "relationshipContinuity": number, "feedback": string}

"feedback" should be 2-4 sentences of specific, constructive narrative feedback in a coaching tone, using discovery-training language (never "sales" or "closing techniques" language).`;

export async function scoreTranscript(
  transcript: TranscriptMessage[]
): Promise<{ rubric: RubricScores; feedback: string; overall: number }> {
  const transcriptText = transcript
    .map((m) => `${m.role === "customer" ? "Customer" : "Consultant"}: ${m.content}`)
    .join("\n");

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input: `${RUBRIC_SYSTEM}\n\nTranscript:\n${transcriptText}`,
  });

  const raw = (response.output_text || "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Scoring model did not return valid JSON");
  }
  const parsed = JSON.parse(jsonMatch[0]);

  const rubric: RubricScores = {
    needsDiscovery: parsed.needsDiscovery ?? 0,
    objectionPrevention: parsed.objectionPrevention ?? 0,
    trustBuilding: parsed.trustBuilding ?? 0,
    naturalClose: parsed.naturalClose ?? 0,
    relationshipContinuity: parsed.relationshipContinuity ?? 0,
  };

  const overall = Math.round(
    (rubric.needsDiscovery +
      rubric.objectionPrevention +
      rubric.trustBuilding +
      rubric.naturalClose +
      rubric.relationshipContinuity) /
      5
  );

  return { rubric, feedback: parsed.feedback ?? "", overall };
}

// Checks whether the consultant has proposed any recommendation, solution, or
// next step/close yet in the conversation. Used to gate "End & score this
// session" — a consultation that never reaches a recommendation is incomplete
// and shouldn't be scored yet.
export async function hasProposedRecommendation(transcript: TranscriptMessage[]): Promise<boolean> {
  const consultantLines = transcript.filter((m) => m.role === "consultant");
  if (consultantLines.length === 0) return false;

  const transcriptText = transcript
    .map((m) => `${m.role === "customer" ? "Customer" : "Consultant"}: ${m.content}`)
    .join("\n");

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input: `Read this discovery-training role-play transcript. Has the consultant proposed ANY recommendation, solution, product/option, or next step/close to the customer yet — even a tentative or partial one? Answer with ONLY the single word "yes" or "no".\n\nTranscript:\n${transcriptText}`,
  });

  const raw = (response.output_text || "").trim().toLowerCase();
  return raw.startsWith("yes");
}

// Level progression order and the score threshold to auto-advance.
export const LEVEL_ORDER = ["beginner", "intermediate", "advanced", "certified"] as const;
export type Level = (typeof LEVEL_ORDER)[number];
export const ADVANCE_THRESHOLD = 85;

// Given a consultant's current level and their completed scores at that level's
// difficulty, returns the next level to advance to if their average score meets
// the threshold, or null if they should stay put.
export function computeLevelAdvancement(
  currentLevel: string,
  scoresAtCurrentLevel: number[]
): Level | null {
  const idx = LEVEL_ORDER.indexOf(currentLevel as Level);
  if (idx === -1 || idx === LEVEL_ORDER.length - 1) return null; // already certified or unknown
  if (scoresAtCurrentLevel.length === 0) return null;
  const avg = scoresAtCurrentLevel.reduce((sum, s) => sum + s, 0) / scoresAtCurrentLevel.length;
  if (avg >= ADVANCE_THRESHOLD) return LEVEL_ORDER[idx + 1];
  return null;
}
