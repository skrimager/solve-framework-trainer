import OpenAI from "openai";
import type { TranscriptMessage, RubricScores, LeadershipRubricScores } from "@shared/schema";

const client = new OpenAI();
// Uses a real OpenAI model name for production (Render). In the Perplexity
// sandbox dev environment, the proxy also accepts this and routes it through
// the injected llm-api:website credential.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
// Slightly faster than OpenAI's default (1.0) so the customer voice sounds
// natural rather than sluggish. Configurable via OPENAI_TTS_SPEED (0.25–4.0).
const TTS_SPEED = Number(process.env.OPENAI_TTS_SPEED) || 1.12;

// Generates speech audio for a simulated customer's line using OpenAI TTS.
// Runs directly in Node so it works identically in the dev sandbox and on
// Render production — no external sidecar process required.
export async function synthesizeSpeech(text: string, voice: string): Promise<Buffer> {
  const response = await client.audio.speech.create({
    model: TTS_MODEL,
    voice: voice as any,
    input: text,
    response_format: "mp3",
    speed: TTS_SPEED,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Generates the customer's OPENING line: a natural greeting that introduces
// themselves by first name, used to start a session so the consultant walks in
// cold (no pre-roleplay briefing) and must uncover the situation through
// discovery. The persona's underlying needs/concerns must NOT be revealed here.
export async function getCustomerOpening(customerPersona: string, track: string = "consulting"): Promise<string> {
  // Consulting (discovery) counterparts open cold and hide their real need. In
  // a Leadership/Conflict-Management scenario the counterpart is already upset
  // or in conflict, so they open by surfacing that frustration (but not the
  // underlying root cause, which the consultant must still uncover).
  const openingInstruction =
    track === "leadership"
      ? `You are starting the conversation already frustrated, upset, or in conflict about something. Open with a short, natural line that introduces yourself by first name and makes your annoyance/complaint clear in one or two sentences (for example: "I'm Dana, and honestly I'm pretty frustrated right now — this is the second time this has happened"). Do NOT calmly explain the full root cause or what would satisfy you; the consultant has to draw that out. Output ONLY the spoken line, no labels or narration.`
      : `You are starting the conversation — the consultant has just arrived / greeted you is imminent. Open with a short, natural greeting and introduce yourself by your first name in one or two sentences (for example: "Hi, I'm Sarah — thanks for coming out today"). Do NOT reveal your underlying needs, concerns, budget, or the reason you're really here; those are for the consultant to uncover through questions. Output ONLY the spoken line, no labels or narration.`;
  const input = `${customerPersona}\n\n${openingInstruction}`;

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input,
  });

  return (response.output_text || "").trim();
}

// Per-difficulty behavioral calibration layered on top of each persona so the
// same scenario feels harder at higher levels: an advanced customer guards their
// real needs, objects more, and pushes back harder on price/value, forcing the
// consultant to use more skilled discovery to get anywhere.
const DIFFICULTY_BEHAVIOR: Record<string, string> = {
  beginner:
    "Difficulty calibration (BEGINNER): Be relatively cooperative and warm. Volunteer some context with modest prompting, raise only mild objections, and open up fairly readily once the consultant shows basic curiosity.",
  intermediate:
    "Difficulty calibration (INTERMEDIATE): Be realistically guarded. Reveal your real needs only in response to genuinely good, open questions, and raise reasonable objections if the consultant jumps ahead or stays surface-level.",
  advanced:
    "Difficulty calibration (ADVANCED): Be markedly more skeptical and less immediately cooperative. Keep your real needs and priorities well hidden behind your stated request, and reveal them only when the consultant earns it with layered, insightful discovery questions. Push back hard on price and value, surface multiple objections, test whether the consultant is really listening, and stay non-committal until they clearly demonstrate they understand your underlying situation. Do not make it easy.",
};

// Conversation-progression rules layered onto every customer reply. Without
// these the model tends to restate the same objection in slightly reworded form
// turn after turn (and, when asked to clarify, paraphrase itself instead of
// giving new information), which destroys the realism of the roleplay. These
// rules make the simulated customer track what they've already said, add NEW
// detail when pressed, and move on once a concern has actually been addressed.
// Correctness/realism is deliberately prioritized over token economy here.
export const CONVERSATION_REALISM_RULES = `Conversation realism (follow on EVERY turn — this is critical):
- You are a real person in a live, moving conversation, not a script on a loop. Keep the conversation moving FORWARD.
- Keep a running mental note of every concern, objection, question, or need you have ALREADY raised earlier in this conversation. Do NOT bring up a concern you have already voiced a second time — not even reworded, rephrased, or from a slightly different angle — UNLESS the consultant's most recent reply genuinely failed to address it. Restating the same point over and over makes you sound like a broken record and is never how a real person talks.
- When the consultant asks you to clarify, explain, or say more about something, respond with GENUINELY NEW, specific information: a concrete number, a dollar amount, a timeframe, a name, a specific past experience, or a fresh reason. NEVER just paraphrase or restate the same sentence you already said. Real people add detail and context when asked; they do not repeat themselves.
- The moment the consultant has adequately addressed, answered, or eased a concern, briefly acknowledge it in your own words (e.g. "Okay, that actually makes sense" or "Alright, that helps") and MOVE ON — raise your next underlying concern, ask a question of your own, or let the conversation advance to a new topic. Do not keep relitigating a point that has already been handled.
- It is realistic to hold firm on a concern the consultant has NOT actually resolved — but express that by adding a new angle, a new detail, or a pointed follow-up question, not by repeating the same statement.
- Keep each reply short and conversational — usually one to three sentences, the way people actually speak out loud.`;

// Builds the full prompt sent to the model for the customer's next reply. Kept
// as a separate pure function (like buildWrittenGradingPrompt) so the prompt —
// especially the anti-looping realism rules — can be unit-tested without
// hitting the network.
export function buildCustomerReplyPrompt(
  customerPersona: string,
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate"
): string {
  const history = transcript
    .map((m) => `${m.role === "customer" ? "Customer (you)" : "Consultant"}: ${m.content}`)
    .join("\n");

  const behavior = DIFFICULTY_BEHAVIOR[difficulty] ?? DIFFICULTY_BEHAVIOR.intermediate;
  return `${customerPersona}\n\n${behavior}\n\n${CONVERSATION_REALISM_RULES}\n\nConversation so far:\n${history || "(The consultant is about to greet you.)"}\n\nRespond with your next line as the customer, in character, following the conversation realism rules above. Output ONLY the spoken line, no labels or narration.`;
}

// Generates the simulated customer's next reply in a discovery-training role-play.
export async function getCustomerReply(
  customerPersona: string,
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate"
): Promise<string> {
  const input = buildCustomerReplyPrompt(customerPersona, transcript, difficulty);

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

"feedback" should be 3-5 sentences of specific, constructive narrative feedback in a coaching tone, using discovery-training language (never "sales" or "closing techniques" language). Briefly acknowledge what the consultant did well or attempted, then give at least one concrete example of a specific question or phrase they could have used at a particular point in the conversation to score higher on the dimension(s) where they lost points — quote or closely paraphrase the moment in the transcript this applies to. This is discovery-skills coaching, not just a list of what was missing.`;

// Per-difficulty scoring strictness so a higher-level scenario demands more
// precision and completeness to earn the same score.
const RUBRIC_DIFFICULTY_CALIBRATION: Record<string, string> = {
  beginner:
    "Scoring calibration (BEGINNER): Reward solid fundamentals. Give credit for a clear, genuine attempt at open discovery and trust-building even when coverage isn't exhaustive.",
  intermediate:
    "Scoring calibration (INTERMEDIATE): Hold a professional bar. Expect multiple layers of discovery and mostly complete needs-matching before awarding high marks.",
  advanced:
    "Scoring calibration (ADVANCED): Grade strictly. Award high scores (85+) ONLY when discovery is thorough and multi-layered, the real underlying need is explicitly uncovered and reflected back in the customer's own words, objections are anticipated and handled rather than merely reacted to, and any close/next step is precisely tied to what the customer said. Penalize shallow questioning, missed objections, and incomplete needs-matching more heavily than at lower levels.",
};

// Leadership / Conflict-Management scoring rubric. Parallel to RUBRIC_SYSTEM but
// evaluates de-escalation skill (listening, empathy, root-cause discovery,
// co-created solutions, blameless resolution) instead of sales discovery.
const LEADERSHIP_RUBRIC_SYSTEM = `You are scoring a conflict-management / de-escalation role-play transcript. The consultant is a manager or service professional handling an upset customer, an aggrieved employee, or a peer conflict. This is NOT sales training — evaluate their ability to de-escalate, understand the other person, and reach a resolution nobody is blamed for.

Score each dimension 0-100:
- activeListening: Did the consultant let the person fully vent and feel heard before responding — no interrupting, defending, or jumping to solutions?
- empathyAcknowledgment: Did the consultant name and validate the person's feeling ("I can hear how frustrating this is") before problem-solving?
- rootCauseDiscovery: Did the consultant ask questions to uncover the real underlying issue rather than reacting only to the surface complaint?
- solutionVisualization: Did the consultant co-create what a good outcome looks like WITH the other party, rather than imposing a fix unilaterally?
- blamelessResolution: Was the resolution offered without blaming the customer/employee/peer OR scapegoating the company/coworker?

Return ONLY valid JSON matching this shape, no other text:
{"activeListening": number, "empathyAcknowledgment": number, "rootCauseDiscovery": number, "solutionVisualization": number, "blamelessResolution": number, "feedback": string}

"feedback" should be 3-5 sentences of specific, constructive narrative feedback in a coaching tone, using conflict-management / de-escalation language (never "sales" or "closing" language). Briefly acknowledge what the consultant did well or attempted, then give at least one concrete example of a specific phrase or response they could have used at a particular point in the conversation to de-escalate or resolve more effectively — quote or closely paraphrase the moment in the transcript this applies to. This is conflict-resolution coaching, not just a list of what was missing.`;

const LEADERSHIP_RUBRIC_DIFFICULTY_CALIBRATION: Record<string, string> = {
  beginner:
    "Scoring calibration (BEGINNER): Reward solid fundamentals. Give credit for a genuine attempt to listen, acknowledge the feeling, and reach a fair resolution even when not every step is polished.",
  intermediate:
    "Scoring calibration (INTERMEDIATE): Hold a professional bar. Expect the consultant to let the person vent, explicitly acknowledge emotion, uncover the real issue, and land a mutually-agreed resolution before awarding high marks.",
  advanced:
    "Scoring calibration (ADVANCED): Grade strictly. Award high scores (85+) ONLY when the consultant fully de-escalates a hostile counterpart, names the emotion precisely, uncovers the true root cause behind the stated complaint, co-creates the resolution rather than dictating it, and assigns blame to no one. Penalize interrupting, defensiveness, premature solutions, and blame-shifting more heavily than at lower levels.",
};

const CONSULTING_RUBRIC_KEYS = [
  "needsDiscovery",
  "objectionPrevention",
  "trustBuilding",
  "naturalClose",
  "relationshipContinuity",
] as const;

const LEADERSHIP_RUBRIC_KEYS = [
  "activeListening",
  "empathyAcknowledgment",
  "rootCauseDiscovery",
  "solutionVisualization",
  "blamelessResolution",
] as const;

// Scores a completed session. Branches on the scenario's `track`: consulting
// sessions use the discovery rubric (RubricScores); leadership sessions use the
// conflict-management rubric (LeadershipRubricScores). Both are stored the same
// way (JSON text in sessions.rubricScores) and disambiguated by track on read.
export async function scoreTranscript(
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  track: string = "consulting"
): Promise<{ rubric: RubricScores | LeadershipRubricScores; feedback: string; overall: number }> {
  const transcriptText = transcript
    .map((m) => `${m.role === "customer" ? "Customer" : "Consultant"}: ${m.content}`)
    .join("\n");

  const isLeadership = track === "leadership";
  const system = isLeadership ? LEADERSHIP_RUBRIC_SYSTEM : RUBRIC_SYSTEM;
  const calibrationMap = isLeadership ? LEADERSHIP_RUBRIC_DIFFICULTY_CALIBRATION : RUBRIC_DIFFICULTY_CALIBRATION;
  const calibration = calibrationMap[difficulty] ?? calibrationMap.intermediate;
  const keys = isLeadership ? LEADERSHIP_RUBRIC_KEYS : CONSULTING_RUBRIC_KEYS;

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input: `${system}\n\n${calibration}\n\nTranscript:\n${transcriptText}`,
  });

  const raw = (response.output_text || "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Scoring model did not return valid JSON");
  }
  const parsed = JSON.parse(jsonMatch[0]);

  const rubric = Object.fromEntries(keys.map((k) => [k, parsed[k] ?? 0])) as unknown as
    | RubricScores
    | LeadershipRubricScores;

  const overall = Math.round(
    keys.reduce((sum, k) => sum + (parsed[k] ?? 0), 0) / keys.length
  );

  return { rubric, feedback: parsed.feedback ?? "", overall };
}

// Grades a single free-text ("written") certification answer against a rubric,
// using the SAME client.responses.create shape as scoreTranscript. Returns a
// deterministic boolean (correct / not correct) so the written test can be
// scored exactly out of 30. `responder` is injectable purely so tests can
// exercise the prompt-building + parsing without hitting the real API; in
// production it defaults to the shared OpenAI client.
export type WrittenGradeResponder = (input: string) => Promise<string>;

const defaultWrittenGradeResponder: WrittenGradeResponder = async (input) => {
  const response = await client.responses.create({
    model: CHAT_MODEL,
    input,
  });
  return response.output_text || "";
};

export function buildWrittenGradingPrompt(prompt: string, rubric: string, answer: string): string {
  return `You are grading a single free-text answer on a professional certification exam. Decide whether the candidate's answer satisfies the rubric.

Question: ${prompt}

Rubric for a correct answer: ${rubric}

Candidate's answer: ${answer || "(no answer provided)"}

Respond with ONLY valid JSON, no other text: {"correct": boolean, "reason": string}. Mark "correct" true only if the answer substantively meets the rubric.`;
}

// Retries a flaky async call a few times with a short backoff before giving
// up. Written-exam grading calls the LLM once per free-text question; a
// single transient failure (rate limit, timeout, brief outage) shouldn't
// force the candidate to redo the whole 30-question exam.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 400): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// Thrown when the LLM grader itself fails after retries (auth, rate limit,
// outage) — distinct from a normal "the answer didn't meet the rubric"
// result so callers can tell a real service failure apart from a fair grade.
export class WrittenGradingUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Written-answer grading is temporarily unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WrittenGradingUnavailableError";
  }
}

export async function gradeWrittenAnswer(
  prompt: string,
  rubric: string,
  answer: string,
  responder: WrittenGradeResponder = defaultWrittenGradeResponder
): Promise<boolean> {
  const input = buildWrittenGradingPrompt(prompt, rubric, answer);
  let raw: string;
  try {
    raw = (await withRetry(() => responder(input))).trim();
  } catch (err) {
    // The LLM call itself failed (not a grading judgment) — surface this
    // distinctly so the exam route can fail the whole submission cleanly
    // instead of silently marking a valid answer wrong.
    throw new WrittenGradingUnavailableError(err);
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return false;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.correct === true;
  } catch {
    return false;
  }
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

// Level progression order and the score threshold to auto-advance. Advanced is
// the ceiling — there is no auto-advance beyond it.
export const LEVEL_ORDER = ["beginner", "intermediate", "advanced"] as const;
export type Level = (typeof LEVEL_ORDER)[number];
// A session "qualifies" at a level only if it INDIVIDUALLY scores at or above
// this bar. This is not an average — one great session cannot carry a weak one.
export const ADVANCE_THRESHOLD = 85;
// A level (and, at Advanced, exam eligibility) is gated behind this many
// individually-qualifying sessions at that level. Identical at every level and
// on both tracks.
export const REQUIRED_QUALIFYING_SESSIONS = 5;

// Counts how many of the given completed scores individually clear the
// qualifying bar (>= ADVANCE_THRESHOLD). A sub-85 session simply doesn't count
// toward the total — it does NOT erase already-earned qualifying sessions, so
// progress never resets. This is the single source of truth for both level
// advancement and Advanced-level exam eligibility.
export function countQualifyingSessions(scoresAtCurrentLevel: number[]): number {
  return scoresAtCurrentLevel.filter((s) => s >= ADVANCE_THRESHOLD).length;
}

// Given a consultant's current level and their completed scores at that level's
// difficulty, returns the next level to advance to once they have accumulated
// REQUIRED_QUALIFYING_SESSIONS individually-qualifying (85+) sessions, or null
// if they should stay put. Advanced is the ceiling: there is no auto-advance
// beyond it (a user at Advanced becomes exam-ELIGIBLE instead — see
// isExamEligible — but does not auto-certify).
export function computeLevelAdvancement(
  currentLevel: string,
  scoresAtCurrentLevel: number[]
): Level | null {
  const idx = LEVEL_ORDER.indexOf(currentLevel as Level);
  if (idx === -1 || idx === LEVEL_ORDER.length - 1) return null; // already at the ceiling (advanced) or unknown
  if (countQualifyingSessions(scoresAtCurrentLevel) >= REQUIRED_QUALIFYING_SESSIONS) {
    return LEVEL_ORDER[idx + 1];
  }
  return null;
}

// True once a user at the Advanced ceiling has accumulated the required number
// of individually-qualifying Advanced sessions. This is the gate that unlocks
// the certification exam — reaching Advanced alone is NOT enough. Applies per
// track (the caller passes that track's Advanced scores).
export function isExamEligible(
  currentLevel: string,
  scoresAtCurrentLevel: number[]
): boolean {
  return (
    currentLevel === "advanced" &&
    countQualifyingSessions(scoresAtCurrentLevel) >= REQUIRED_QUALIFYING_SESSIONS
  );
}

// The verticals that belong to the Leadership / Conflict-Management track.
export const LEADERSHIP_VERTICALS = [
  "upset_customer_service",
  "employee_grievance",
  "peer_conflict",
] as const;

// Normalizes a scenario's track. Rows created before the track column existed
// have no track and are treated as consulting.
export function scenarioTrack(track: string | null | undefined): string {
  return track === "leadership" ? "leadership" : "consulting";
}

type ScoredSession = { scenarioId: number; status: string; score: number | null };
type LeveledScenario = { id: number; track?: string | null; difficulty: string };

// Collects a user's completed scores that count toward advancement on ONE track
// at ONE difficulty level. This is what keeps the two tracks independent: a
// consulting session never contributes to leadership progress and vice versa,
// so being Advanced in Consulting can never auto-certify someone in Leadership.
export function scoresForTrackAtLevel(
  track: string,
  level: string,
  sessions: ScoredSession[],
  scenarios: LeveledScenario[]
): number[] {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  return sessions
    .filter((s) => s.status === "completed" && s.score !== null)
    .filter((s) => {
      const scenario = byId.get(s.scenarioId);
      if (!scenario) return false;
      return scenarioTrack(scenario.track) === track && scenario.difficulty === level;
    })
    .map((s) => s.score as number);
}
