import OpenAI from "openai";
import type { TranscriptMessage, RubricScores } from "@shared/schema";

const client = new OpenAI();
// Uses a real OpenAI model name for production (Render). In the Perplexity
// sandbox dev environment, the proxy also accepts this and routes it through
// the injected llm-api:website credential.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

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
