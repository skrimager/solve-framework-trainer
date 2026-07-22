import { createHash } from "node:crypto";
import OpenAI, { toFile } from "openai";
import type { TranscriptMessage, RubricScores, LeadershipRubricScores, ScoreCache, InsertScoreCache } from "@shared/schema";
import { createSentenceStreamer } from "./sentences";
import { storage } from "./storage";

const client = new OpenAI();

// Whisper transcription for Real Conversation Scoring Phase 2 (audio upload).
// Reuses the SAME shared OpenAI client/credentials as every other call in this
// file, so there is no second client setup or API key mechanism. verbose_json
// gives us the reported audio duration (for the ~30 min cap) and per-segment
// text (natural turn boundaries the audio parser alternates roles across).
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

export async function transcribeAudio(input: {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}): Promise<{ text: string; duration?: number; segments?: { text: string }[] }> {
  const file = await toFile(input.buffer, input.filename, { type: input.mimetype });
  const result = await client.audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
    response_format: "verbose_json",
  });
  return {
    text: result.text ?? "",
    duration: result.duration,
    segments: result.segments?.map((s) => ({ text: s.text })),
  };
}

// Temporary instrumentation for verifying OpenAI automatic prompt caching in a
// live session. OpenAI serves an identical request PREFIX from cache once it
// exceeds ~1024 tokens; the response surfaces how many input tokens were a cache
// hit. On the Responses API that lives at usage.input_tokens_details.cached_tokens
// (the Chat Completions API uses usage.prompt_tokens_details.cached_tokens); we
// read whichever is present. A rising cached_tokens across turns 2, 3, 4 ... of a
// session confirms the stable persona/rubric prefix is being reused. Remove once
// caching has been verified in production.
function logCachedTokens(label: string, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as {
    input_tokens?: number;
    prompt_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const inputTokens = u.input_tokens ?? u.prompt_tokens ?? 0;
  console.log(`[prompt-cache] ${label}: cached_tokens=${cached} input_tokens=${inputTokens}`);
}

// Derives a stable `prompt_cache_key` from the unchanging prefix of a prompt.
// OpenAI's Responses API caches prompts >=1024 tokens automatically by hashing
// the request prefix; `prompt_cache_key` is an optional routing hint that keeps
// requests sharing the same stable prefix on the same cache, improving hit
// rates. Keying on a hash of the stable prefix means every turn of the same
// session (same persona/difficulty, same rubric) routes together while distinct
// prefixes stay isolated. It never affects model output — purely cache routing.
function cacheKeyForPrefix(stablePrefix: string): string {
  return createHash("sha256").update(stablePrefix).digest("hex").slice(0, 32);
}
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
export async function synthesizeSpeech(text: string, voice: string, instructions?: string): Promise<Buffer> {
  const response = await client.audio.speech.create({
    model: TTS_MODEL,
    voice: voice as any,
    input: text,
    response_format: "mp3",
    speed: TTS_SPEED,
    // gpt-4o-mini-tts-only: steers delivery (pitch/pacing/register) so a young
    // persona's voice ID doesn't default to reading as a mature adult.
    ...(instructions ? { instructions } : {}),
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Streaming variant of synthesizeSpeech. Returns the raw audio byte stream so
// the caller can forward chunks to the client (and tee them to disk) as they
// arrive from OpenAI, instead of waiting for the whole file to be rendered.
// This is what lets playback start within about a second of the reply instead
// of after a full buffer plus a poll cycle. `stream_format: "audio"` asks the
// API to stream raw audio bytes rather than one buffered response.
export async function synthesizeSpeechStream(
  text: string,
  voice: string,
  instructions?: string,
): Promise<ReadableStream<Uint8Array>> {
  const response = await client.audio.speech.create({
    model: TTS_MODEL,
    voice: voice as any,
    input: text,
    response_format: "mp3",
    speed: TTS_SPEED,
    stream_format: "audio",
    ...(instructions ? { instructions } : {}),
  });
  const body = response.body;
  if (!body) throw new Error("TTS stream response had no body");
  return body as ReadableStream<Uint8Array>;
}

// Generates the customer's OPENING line: a natural greeting that introduces
// themselves by first name, used to start a session so the consultant walks in
// cold (no pre-roleplay briefing) and must uncover the situation through
// discovery. The persona's underlying needs/concerns must NOT be revealed here.
export async function getCustomerOpening(
  customerPersona: string,
  track: string = "consulting",
  // The per-session persona rendition block (personality, motivation, objections).
  // Empty string keeps the prompt byte-identical to the pre-variation behavior.
  variantSection: string = ""
): Promise<string> {
  // Consulting (discovery) counterparts open cold and hide their real need. In
  // a Leadership/Conflict-Management scenario the counterpart is already upset
  // or in conflict, so they open by surfacing that frustration (but not the
  // underlying root cause, which the consultant must still uncover).
  const openingInstruction =
    track === "leadership"
      ? `You are starting the conversation already frustrated, upset, or in conflict about something. Open with a short, natural line that introduces yourself by first name and makes your annoyance/complaint clear in one or two sentences (for example: "I'm Dana, and honestly I'm pretty frustrated right now — this is the second time this has happened"). Do NOT calmly explain the full root cause or what would satisfy you; the consultant has to draw that out. Output ONLY the spoken line, no labels or narration.`
      : `You are starting the conversation — the consultant has just arrived / greeted you is imminent. Open with a short, natural greeting and introduce yourself by your first name in one or two sentences (for example: "Hi, I'm Sarah — thanks for coming out today"). Do NOT reveal your underlying needs, concerns, budget, or the reason you're really here; those are for the consultant to uncover through questions. Output ONLY the spoken line, no labels or narration.`;
  // Fixed persona core + per-track opening instruction lead (both stable per
  // scenario, so they cache), then the per-session variant rendition comes LAST.
  // Keying the cache on the fixed prefix keeps sessions of the same scenario
  // routed together even though their variant tails differ.
  const fixedPrefix = `${customerPersona}\n\n${openingInstruction}`;
  const input = variantSection ? `${fixedPrefix}\n\n${variantSection}` : fixedPrefix;

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input,
    prompt_cache_key: cacheKeyForPrefix(customerPersona),
  });

  logCachedTokens("customer-opening", response.usage);
  return (response.output_text || "").trim();
}

// Per-difficulty behavioral calibration layered on top of each persona so the
// same scenario feels harder at higher levels: an advanced customer guards their
// real needs, objects more, and pushes back harder on price/value, forcing the
// consultant to use more skilled discovery to get anywhere.
const DIFFICULTY_BEHAVIOR: Record<string, string> = {
  beginner:
    "Difficulty calibration (BEGINNER): Be warm, cooperative, and fairly forthcoming. Volunteer relevant context with only light prompting, raise only mild objections, and open up readily once the consultant shows basic curiosity. Don't hide your real motivation for long — a beginner should be able to uncover it without expert questioning.",
  intermediate:
    "Difficulty calibration (INTERMEDIATE): Be realistically guarded and a little more closed off. Reveal your real needs only in response to genuinely good, open questions, make the consultant build some rapport before you open up, and raise reasonable objections if the consultant jumps ahead or stays surface-level.",
  advanced:
    "Difficulty calibration (ADVANCED): Be markedly more skeptical and less immediately cooperative. Keep your real needs and priorities well hidden behind your stated request, and reveal them only when the consultant earns it with layered, insightful discovery questions. Push back hard on price and value, surface multiple objections, test whether the consultant is really listening, and stay non-committal until they clearly demonstrate they understand your underlying situation. Do not make it easy.",
};

// Within-level difficulty escalation ("dangle the carrot"). Once a trainee is
// consistently clearing the qualifying bar at their current level, the next
// scenario at that SAME level should get incrementally — not drastically —
// harder, so mastery keeps requiring a little more before they advance a tier.
// This is expressed as a small integer tier (0 = base) that layers a light
// behavioral add-on onto the persona, leaving the base difficulty band intact.
export const MAX_ESCALATION_TIER = 2;

// Maps a trainee's count of qualifying (85+) sessions at the current level to an
// escalation tier. The founder's guidance: start nudging harder once they've
// strung together "a couple" of 85s, and keep it gradual (one notch at a time),
// never a tier jump. Deliberately gentle so it motivates without discouraging.
export function computeEscalationTier(qualifyingSessionCount: number): number {
  if (qualifyingSessionCount >= 4) return 2;
  if (qualifyingSessionCount >= 2) return 1;
  return 0;
}

// The behavioral add-on for each escalation tier, appended to the persona's
// difficulty calibration. Kept as gentle, incremental toughening that stays
// within the current level's spirit rather than pushing it toward the next tier.
const ESCALATION_ADDON: Record<number, string> = {
  0: "",
  1: "Escalation (the trainee has been performing well, so make this rendition slightly harder): be a touch slower to volunteer your real motivation, and raise one additional, less-obvious objection before you fully open up. Stay fair for this level — this is a small step up, not a jump.",
  2: "Escalation (the trainee is consistently strong, so make this noticeably harder within this level): stay guarded a bit longer, require clearer rapport before you reveal your real motivation, and surface a tougher objection or a less obvious buying signal. Remain fair for this level — a firm step up, still not the next tier.",
};

export function escalationAddon(tier: number): string {
  const clamped = Math.max(0, Math.min(MAX_ESCALATION_TIER, Math.trunc(tier)));
  return ESCALATION_ADDON[clamped] ?? "";
}

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

// The stable, session-invariant prefix of a customer-reply prompt: the persona,
// the difficulty calibration, and the realism rules. These do NOT change from
// turn to turn within a session (as long as persona/difficulty are unchanged),
// so keeping them assembled as one byte-identical block that PRECEDES the
// growing transcript lets OpenAI's automatic prefix caching serve them from
// cache on turns 2, 3, 4, ... instead of re-billing them at full input rate.
export function buildCustomerReplyStablePrefix(
  customerPersona: string,
  difficulty: string = "intermediate",
  escalationTier: number = 0
): string {
  const behavior = DIFFICULTY_BEHAVIOR[difficulty] ?? DIFFICULTY_BEHAVIOR.intermediate;
  const addon = escalationAddon(escalationTier);
  // Default (tier 0) keeps the prefix byte-identical to the pre-escalation
  // format so within-session prompt caching is unaffected when no escalation
  // applies. A non-zero tier appends its gentle behavioral toughening.
  const behaviorBlock = addon ? `${behavior}\n\n${addon}` : behavior;
  return `${customerPersona}\n\n${behaviorBlock}\n\n${CONVERSATION_REALISM_RULES}`;
}

// Builds the full prompt sent to the model for the customer's next reply. Kept
// as a separate pure function (like buildWrittenGradingPrompt) so the prompt —
// especially the anti-looping realism rules — can be unit-tested without
// hitting the network. Structure is STABLE-PREFIX-FIRST: the invariant
// persona/difficulty/rules block, then the volatile transcript and per-turn
// output instruction, so the prefix stays cacheable across turns.
export function buildCustomerReplyPrompt(
  customerPersona: string,
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  escalationTier: number = 0,
  // The per-session persona rendition block. Sits AFTER the cacheable stable
  // prefix (so the fixed portion still caches across sessions) but BEFORE the
  // volatile transcript. Empty string reproduces the pre-variation prompt byte
  // for byte, so scenarios without variant pools are unaffected.
  variantSection: string = ""
): string {
  const stablePrefix = buildCustomerReplyStablePrefix(customerPersona, difficulty, escalationTier);

  const history = transcript
    .map((m) => `${m.role === "customer" ? "Customer (you)" : "Consultant"}: ${m.content}`)
    .join("\n");
  const volatile = `Conversation so far:\n${history || "(The consultant is about to greet you.)"}\n\nRespond with your next line as the customer, in character, following the conversation realism rules above. Output ONLY the spoken line, no labels or narration.`;

  const variantBlock = variantSection ? `${variantSection}\n\n` : "";
  return `${stablePrefix}\n\n${variantBlock}${volatile}`;
}

// Generates the simulated customer's next reply in a discovery-training role-play.
export async function getCustomerReply(
  customerPersona: string,
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  escalationTier: number = 0,
  variantSection: string = ""
): Promise<string> {
  const input = buildCustomerReplyPrompt(customerPersona, transcript, difficulty, escalationTier, variantSection);

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input,
    prompt_cache_key: cacheKeyForPrefix(buildCustomerReplyStablePrefix(customerPersona, difficulty, escalationTier)),
  });

  logCachedTokens("customer-reply", response.usage);
  return (response.output_text || "").trim();
}

// Streaming variant of getCustomerReply. Requests the model reply with
// stream:true and, as tokens arrive, splits them into whole sentences with the
// shared boundary detector. Each COMPLETED sentence is handed to `onSentence`
// immediately (so the caller can start synthesizing/sending its audio) while the
// rest of the reply keeps streaming in. Returns the full trimmed reply text once
// the stream ends. Uses the identical prompt + prompt_cache_key as the
// non-streaming path, so prompt caching behaves the same. `onSentence` is called
// in order and is NOT awaited here; the caller owns any per-sentence work
// (TTS) so it can overlap with continued text generation.
export async function streamCustomerReply(
  customerPersona: string,
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  escalationTier: number = 0,
  variantSection: string = "",
  onSentence: (sentence: string, index: number) => void = () => {},
): Promise<string> {
  const input = buildCustomerReplyPrompt(customerPersona, transcript, difficulty, escalationTier, variantSection);
  const stablePrefix = buildCustomerReplyStablePrefix(customerPersona, difficulty, escalationTier);

  const stream = await client.responses.create({
    model: CHAT_MODEL,
    input,
    prompt_cache_key: cacheKeyForPrefix(stablePrefix),
    stream: true,
  });

  const streamer = createSentenceStreamer();
  let fullText = "";
  let index = 0;

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      const delta = event.delta ?? "";
      if (!delta) continue;
      fullText += delta;
      for (const sentence of streamer.push(delta)) onSentence(sentence, index++);
    } else if (event.type === "response.completed") {
      logCachedTokens("customer-reply(stream)", event.response?.usage);
    }
  }
  for (const sentence of streamer.flush()) onSentence(sentence, index++);

  return fullText.trim();
}

const RUBRIC_SYSTEM = `You are scoring a discovery-training role-play transcript. This is discovery architecture practice — NOT sales training — so evaluate the consultant's ability to uncover real customer needs and build trust through understanding, not persuasion tactics.

THE CORE STANDARD: every conversation should leave the other person better than you found them. You are evaluating whether the consultant made an honest effort to understand the customer's situation well enough to actually help them in some real way — solving a problem, making an introduction, sharing an idea, connecting them to a resource, or simply listening until the real issue surfaced. If the conversation ended without the consultant learning enough to help, discovery was not complete, and the score should reflect that no matter how pleasant the conversation was.

POLITENESS IS NOT DISCOVERY: a warm, cordial, well-mannered conversation is not automatically a high-scoring one. Do not reward a conversation just because it was friendly, relationship-preserving, or nicely executed — pleasant is the floor, not the achievement. Relationship-building is not a separate category exempt from discovery; the relationship is the REASON to dig deeper, never a substitute for it. A consultant who builds warmth and then stops — who never uses that warmth to actually understand and help — has not finished the job. Grade the effort to understand and help, not the friendliness.

THE VOLUNTEERED PROBLEM SIGNAL: when the customer volunteers a difficulty ("it's been slow," "nobody qualifies," "traffic is down," "our advertising isn't working"), that is the single most important moment in the conversation — an invitation, not just information. Heavily reward a consultant who leans into that opening with genuine curiosity ("Tell me about that, what's changed?" / "What's driving that?"). Heavily mark down a consultant who acknowledges the difficulty and then changes the subject, pivots to their own product/category, or lets the customer off the hook without exploring it further. Missing a volunteered problem is one of the most important things to catch, and should visibly cost points in needsDiscovery and objectionPrevention.

Score each dimension 0-100:
- needsDiscovery: Did the consultant uncover the customer's real underlying need ("the hole"), not just react to the stated request ("the drill")? Did they follow up on any problem the customer volunteered, rather than skimming past it?
- objectionPrevention: Did early, deep discovery questions prevent objections from arising, rather than the consultant only reacting to objections after they came up?
- trustBuilding: Did the consultant build trust as a signal independent of whether/how the conversation closed — through genuine curiosity, active listening, and patience? Warmth alone does not satisfy this dimension; the warmth must be in service of understanding the customer, not a substitute for it.
- naturalClose: If the conversation reached a close or next step, did it feel like a natural next step that referenced the customer's own words/needs, rather than a pressure-based push?
- relationshipContinuity: Did the consultant establish a clear, low-pressure follow-up or next step that preserves the relationship regardless of outcome?

Also classify how the consultation actually ended, from the CUSTOMER's perspective, into exactly one "closeOutcome" value:
- "none": the consultant never proposed any recommendation, solution, product/option, or concrete next step.
- "handoff_no_commitment": the consultant tried to wrap up with a soft handoff — handing over a business card, "call me when you're ready", "here's my info", "thanks, goodbye" — WITHOUT the customer agreeing to any concrete next step. Ending this way is an incomplete close, not a real one.
- "recommendation_made": the consultant did propose a specific recommendation/solution, but the customer gave no clear buy-in signal (didn't ask about next steps and didn't explicitly agree).
- "client_asked_next_steps": the customer themselves asked something like "what are the next steps?" / "where do we go from here?" — a strong signal the consultant earned enough trust to prompt forward motion.
- "client_agreed": the customer explicitly agreed to / accepted the proposed recommendation or solution. This is the strongest "moving forward together" outcome.
- "graceful_referral": the consultant, AFTER a genuine, competent discovery effort (real open questions, real rapport-building, adequate time invested), recognized that the customer cannot or will not articulate a clear vision, goal, or motivation — so there is no real basis to engineer a solution — and gracefully referred them elsewhere ("I don't think we're the best fit here; let me point you to someone who may serve you better") instead of forcing a close. This is a LEGITIMATE, professional outcome, NOT a failed close. Classify an ending as "graceful_referral" ONLY when the discovery effort was genuine; if the consultant bailed early, asked shallow questions, or referred out to avoid doing the work, do NOT use this value — classify by what actually happened (usually "none" or "handoff_no_commitment") and let the low discovery scores reflect the weak effort.

CONSTRAINED-CLOSE TIERS (use these when a REAL scheduling constraint legitimately prevented a same-day signature/deposit): Many real products (real estate, windows, kitchen remodels, pools, etc.) genuinely cannot close same-day because of real logistics — the client is going on vacation, an installer/contractor isn't available yet, materials must be ordered. In those cases do NOT treat "no contract signed today" as a failure. What matters is how well the consultant ENGINEERED A CONCRETE SOLUTION around the constraint. Infer this ONLY from the conversation itself (a constraint being mentioned + what the consultant actually secured in response); it is never a property of the scenario, and even the same product can close same-day OR legitimately be delayed depending on circumstances. Classify into exactly one of:
- "constrained_deferral": a real, legitimate scheduling constraint surfaced (vacation, installer availability, materials lead-time, "we're not ready to decide today" for genuine logistics reasons) AND the consultant let the conversation end on a VAGUE deferral with nothing concrete locked in ("let me think about it," "we'll call you when we're back") — no timeline, no next step, no commitment. The constraint is real, but the trainee engineered no solution around it. This is a solution-engineering MISS: it scores below the two stronger tiers below and clearly below a normal close, but it is NOT a total discovery failure (the constraint is genuine).
- "constrained_plan_committed": a real scheduling constraint surfaced AND the consultant engineered a concrete plan around it that the customer agreed to — a specific timeline, date/week, or explicit next-step commitment (e.g. "let's get you on the install calendar for the week you're back, and I'll have everything queued up") — even though no payment changed hands. Real forward motion locked in around the constraint.
- "constrained_deposit_secured": a real scheduling constraint surfaced AND the consultant secured a financial commitment (a deposit) and/or proactive logistics (ordering materials, starting paperwork) BEFORE the constraint window, so everything is ready the moment the customer is available. This is the strongest constrained outcome — real commitment plus proactive readiness — and is scored alongside a full same-day agreement.
IMPORTANT: only use the constrained_* values when a genuine scheduling constraint is actually present in the conversation. When NO such constraint exists and the customer simply agreed (or asked next steps) same-day, use the ordinary "client_agreed" / "client_asked_next_steps" values — a real same-day close remains a top-tier outcome and must NOT be downgraded.

Return ONLY valid JSON matching this shape, no other text:
{"needsDiscovery": number, "objectionPrevention": number, "trustBuilding": number, "naturalClose": number, "relationshipContinuity": number, "closeOutcome": string, "feedback": string}

"feedback" should be 3-5 sentences of specific, DIAGNOSTIC narrative feedback in a coaching tone, using discovery-training language (never "sales" or "closing techniques" language). Write it in a warm, knowledgeable-partner voice — never a bare command, never scolding. Do not just tell the consultant WHAT to do ("dig deeper," "ask more questions"); teach WHY it matters, tied to the actual moment in the transcript where it applied. For example, instead of "dig deeper," write something like: "When someone shares a challenge, treat it as an opportunity to understand before offering anything. The best consultants don't ask more questions because a script told them to — they ask because they genuinely want to improve the other person's situation. Here, when they mentioned things were slow, that was your opening to get curious about what's driving it, because that's where you find the way to actually be useful to them." Every piece of feedback should be specific and grounded in a real moment, never generic.

It must do four things: (1) acknowledge specifically what the consultant did well or attempted, quoting or closely paraphrasing a real moment from the transcript; (2) where they lost points — especially if they let a volunteered problem pass without exploring it — give at least one concrete example of a specific question or phrase they could have used at that moment, and explain the principle behind it (why leaning into that opening would have helped them actually understand and help the customer), not just the correction itself; (3) when a topic (for example budget/financing) was handled well but raised LATER rather than earlier, do NOT treat that as a failure — acknowledge that they handled it competently when it came up, and explain WHY raising it earlier generally helps (e.g. it lets you shape options to fit from the start and prevents surprises), framed as forward-looking coaching rather than punishment for a good outcome; and (4) when a REAL scheduling constraint made a same-day signature impossible or inappropriate (the customer is traveling, materials must be ordered, an installer must be scheduled), do NOT frame "no signature today" as a failure — instead evaluate how well they engineered a concrete solution around the constraint: praise locking in a specific timeline/next step, or securing a deposit and proactive logistics before the constraint window; and if they let it end on a vague "we'll call you," coach them on the specific commitment or timeline they could have proposed to keep momentum. It's not about the close — it's about finding out what the client truly needs and engineering a solution they feel good enough about to move forward and refer their friends and family, even if they can't sign or pay in the room that day. This is diagnostic discovery-skills coaching that teaches the principle behind every correction, not just a list of what was missing.`;

// Per-difficulty scoring strictness so a higher-level scenario demands more
// precision and completeness to earn the same score.
const RUBRIC_DIFFICULTY_CALIBRATION: Record<string, string> = {
  beginner:
    "Scoring calibration (BEGINNER): Reward solid fundamentals and grade leniently. Give full credit for a clear, genuine attempt at open discovery and trust-building even when coverage isn't exhaustive. Financing/budget is still a real, scored factor — the consultant should address it before wrapping up — BUT at this level the TIMING of when it was raised should barely matter: do NOT dock objectionPrevention or any dimension simply because budget/financing came up later in the conversation rather than up front, as long as it was covered and handled competently before the close. Reward handling a topic well whenever it naturally arose. A strong beginner performance with good discovery, rapport, and a natural close should land in the low-to-mid 80s even if one topic was raised a little late.",
  intermediate:
    "Scoring calibration (INTERMEDIATE): Hold a professional bar and toughen up relative to beginner. Expect multiple layers of discovery and mostly complete needs-matching before awarding high marks. Timing now matters more: raising budget/financing and other key topics proactively (rather than only reacting when the customer brings them up) is part of good objection prevention and should be reflected in the score.",
  advanced:
    "Scoring calibration (ADVANCED): Grade strictly. Award high scores (85+) ONLY when discovery is thorough and multi-layered, the real underlying need is explicitly uncovered and reflected back in the customer's own words, objections are anticipated and handled rather than merely reacted to, and any close/next step is precisely tied to what the customer said. Penalize shallow questioning, missed objections, and incomplete needs-matching more heavily than at lower levels. IMPORTANT — the referral path: some advanced customers genuinely cannot or will not articulate a clear vision/goal/motivation even under skilled questioning. When that happens AND the consultant has made a genuine, competent discovery effort, a graceful referral out ('I don't think we're the best fit; let me point you to someone who can serve you better') is a HIGH-scoring, professional outcome — score it on the QUALITY of the discovery effort and the gracefulness of the handoff, and do NOT penalize it for not closing. Do NOT reward a referral that skipped real discovery or gave up early — that is a weak effort and should score low.",
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

// How a consulting consultation actually ended, from the customer's side. This
// is the "client buy-in" signal the closing/outcome score is anchored to — a
// recommendation being present is necessary but NOT sufficient (see
// computeConsultingOverall).
export type CloseOutcome =
  | "none" // no recommendation/solution/next step ever proposed
  | "handoff_no_commitment" // soft close (business card, "call me later") with no agreed next step
  | "recommendation_made" // a recommendation was proposed, but the client gave no buy-in signal
  | "client_asked_next_steps" // the client proactively asked "what are the next steps?"
  | "client_agreed" // the client explicitly agreed to the proposed recommendation
  | "graceful_referral" // the consultant, after genuine discovery, judged the customer a poor fit and gracefully referred them elsewhere instead of forcing a close
  // Constrained-close tiers. A REAL scheduling constraint (vacation, installer
  // availability, materials lead-time, etc.) legitimately prevented a same-day
  // signature — so what matters is how well the consultant engineered a concrete
  // solution AROUND the constraint, not whether a contract was physically signed.
  // These are inferred from the conversation, never tagged on the scenario.
  | "constrained_deferral" // Tier A: real constraint, but the consultant let it end on a vague "we'll call you" — no plan engineered
  | "constrained_plan_committed" // Tier B: real constraint, concrete timeline/next-step locked in around it (no payment yet)
  | "constrained_deposit_secured"; // Tier C: real constraint, deposit and/or proactive logistics secured before the constraint window

export const CLOSE_OUTCOMES: readonly CloseOutcome[] = [
  "none",
  "handoff_no_commitment",
  "recommendation_made",
  "client_asked_next_steps",
  "client_agreed",
  "graceful_referral",
  "constrained_deferral",
  "constrained_plan_committed",
  "constrained_deposit_secured",
] as const;

// The outcome/closing anchor each close tier contributes to the overall score.
// Per the SOLVE product rubric: no-recommendation and handoff-without-commitment
// closes are LOW; a client asking "what's next" anchors ~80; a client explicitly
// agreeing anchors ~85. A bare recommendation with no buy-in signal sits in the
// middle — proposed, but not yet landed.
const CLOSE_OUTCOME_ANCHOR: Record<CloseOutcome, number> = {
  none: 25,
  handoff_no_commitment: 40,
  recommendation_made: 65,
  client_asked_next_steps: 80,
  client_agreed: 85,
  // A graceful referral, when EARNED by genuine discovery, is a legitimate
  // successful outcome — not a failed close — so it anchors alongside client
  // agreement. This anchor only applies once the good-faith effort gate is met
  // (see computeConsultingOverall); a premature/lazy referral is capped low.
  graceful_referral: 85,
  // Constrained-close tiers. A real scheduling constraint prevented a same-day
  // signature, so these are scored on how well the consultant engineered around
  // it — NOT penalized for the lack of a contract. Tier A (vague deferral) is a
  // solution-engineering miss and anchors low (but above a bare soft close — the
  // constraint is real and discovery surfaced it). Tier B (a concrete timeline
  // the client committed to) anchors alongside a client asking "what's next?".
  // Tier C (deposit / proactive logistics secured before the constraint window)
  // anchors alongside a full same-day agreement — the strongest outcome.
  constrained_deferral: 50,
  constrained_plan_committed: 80,
  constrained_deposit_secured: 85,
};

export function closeOutcomeAnchor(outcome: CloseOutcome): number {
  return CLOSE_OUTCOME_ANCHOR[outcome] ?? CLOSE_OUTCOME_ANCHOR.recommendation_made;
}

// The internal-only real-estate transaction type a scenario belongs to. This is
// NEVER shown to the trainee (see scenarios.transactionType in shared/schema.ts)
// — it is inferred from the scenario's own persona/situation and read here only
// to pick the right close-expectation baseline. "Real estate" as a vertical
// spans meaningfully different deal shapes with different realistic close
// timelines, so the rubric must not hold them all to the same same-day bar.
export type TransactionType =
  | "manufactured_community" // on-site inventory in a community: same-day close/deposit realistic
  | "manufactured_dealer" // broader model selection + land/site variables: longer cycle realistic
  | "re_listing_agent" // seller's side: signing a listing agreement same-day is realistic
  | "re_buyer_agent"; // buyer's side: showing homes over multiple visits — a same-day contract is NOT expected

// How realistic a same-day close/agreement is for a given transaction type. This
// is the single knob transaction type turns:
//   - "same_day": a same-day close/agreement IS achievable and expected, so it
//     scores at the top tier when reached (manufactured-community salesperson
//     selling on-site inventory; real-estate LISTING agent signing a listing
//     agreement). Behaves exactly like the pre-existing default scoring.
//   - "multi_step": a same-day signature is NOT a realistic first-conversation
//     outcome (a real-estate BUYER'S agent showing homes across locations; a
//     manufactured-housing DEALER with site-prep/land/permitting variables), so
//     the ABSENCE of a same-day close must not be penalized as a failure. What
//     matters is guiding the client through a logical decision progression
//     (narrowing preferences, scheduling next showings, committing to a concrete
//     next step), so those forward-motion outcomes are re-anchored to the top
//     tier rather than treated as merely "partway there".
export type CloseExpectation = "same_day" | "multi_step";

// Manufactured-dealer and real-estate buyer's-agent deals legitimately run a
// longer cycle; every other (known or unknown) transaction type keeps the
// same-day baseline. Defaulting unknown/undefined to "same_day" means every
// non-real-estate scenario is scored exactly as it was before this change.
export function closeExpectationForTransactionType(t: string | null | undefined): CloseExpectation {
  return t === "manufactured_dealer" || t === "re_buyer_agent" ? "multi_step" : "same_day";
}

// For a "multi_step" transaction type, locking in an agreed, concrete next step
// in a logical decision progression (the client asking where to go from here, or
// a committed plan/scheduled next showing) IS the strongest outcome achievable
// on a first conversation — you cannot do better than that today when a same-day
// signature isn't on the table. So these two forward-motion outcomes are
// re-anchored up to the top tier (85) for multi_step deals, matching a full
// same-day agreement. All other anchors (and all "same_day" scoring) are left
// unchanged. This composes with — and never double-counts against — the PR #25
// constrained-close tiers: those are triggered by an in-conversation scheduling
// constraint, whereas this bump is driven purely by the transaction type, and
// both simply resolve to a single anchor value that is blended once.
const MULTI_STEP_ANCHOR_OVERRIDES: Partial<Record<CloseOutcome, number>> = {
  client_asked_next_steps: 85,
  constrained_plan_committed: 85,
};

// The anchor a close outcome contributes, given the transaction type's
// close-expectation profile. "same_day" is the identity (base anchors);
// "multi_step" raises the committed-next-step outcomes to the top tier.
export function anchorForExpectation(outcome: CloseOutcome, expectation: CloseExpectation): number {
  if (expectation === "multi_step" && MULTI_STEP_ANCHOR_OVERRIDES[outcome] !== undefined) {
    return MULTI_STEP_ANCHOR_OVERRIDES[outcome] as number;
  }
  return closeOutcomeAnchor(outcome);
}

// Transaction-type guidance injected into the CONSULTING scoring prompt so the
// model classifies the close outcome against the RIGHT close-expectation for the
// deal — without ever telling the trainee which type they got. Each block only
// shapes how "moving forward together" is recognized; it never changes the
// discovery dimensions, which are scored identically across every type. The
// founder's core principle drives all four: the goal is a comfortable, informed
// AGREEMENT to a logical next step the client feels good about — not necessarily
// a signature today.
const TRANSACTION_TYPE_RUBRIC_CALIBRATION: Record<TransactionType, string> = {
  manufactured_community:
    "Transaction context (manufactured-housing COMMUNITY salesperson): the homes are already on-site, so a same-day decision — a deposit or a signed agreement to move forward on a specific unit/lot — IS realistic and is the top outcome when the client is comfortable with it (classify as client_agreed or, if a deposit/paperwork was secured, constrained_deposit_secured). Because the units from the manufacturer are largely similar (minor cosmetic differences only), weight discovery on COMMUNITY and LIFESTYLE fit — lot, neighbors, amenities, day-to-day life here — at least as much as on the specific unit; you're selling the community more than the box.",
  manufactured_dealer:
    "Transaction context (manufactured-housing DEALER): the buyer chooses among many models/manufacturers and must place the home somewhere — on land they own or in a pre-selected community — so there are real added variables (site prep, permitting, financing tied to land). A moderately longer cycle is realistic: do NOT penalize the absence of a same-day signature. Score on how well the consultant advanced a logical decision progression and locked in a concrete, agreed next step (a committed plan/timeline is a top outcome here — classify as constrained_plan_committed or client_agreed). A same-day deposit is welcome when it happens but is NOT expected the way it is in a community.",
  re_listing_agent:
    "Transaction context (real-estate LISTING agent, seller's side): you are helping a homeowner list their OWN home. This is a fundamentally faster-cycle scenario — a same-day agreement (e.g. signing a listing agreement, agreeing to the listing plan/price strategy) IS realistic and should score at/near the top tier when the seller is genuinely comfortable with it (classify as client_agreed). Do not treat a same-day listing commitment as high-pressure; for a ready seller it is the natural, logical next step.",
  re_buyer_agent:
    "Transaction context (real-estate BUYER'S agent, buyer's side): you are showing a buyer multiple homes across different locations. A same-day contract on a FIRST conversation is unrealistic and its absence must NOT be scored as a failure. Score instead on whether the consultant guided the client through a logical decision progression — narrowing preferences, scheduling the next showings, building toward a decision the client is comfortable with. Agreeing on and scheduling concrete next steps IS strong forward motion and the top realistic outcome here — classify it as client_agreed or constrained_plan_committed, NOT as a vague handoff. Reserve none/handoff_no_commitment for a genuinely aimless ending where no next step and no progression were established at all.",
};

export function normalizeCloseOutcome(raw: unknown): CloseOutcome {
  const value = String(raw ?? "").trim().toLowerCase();
  return (CLOSE_OUTCOMES as readonly string[]).includes(value)
    ? (value as CloseOutcome)
    : "recommendation_made";
}

// Discovery/rapport quality below this bar means the consultant didn't do enough
// real discovery, so the attempt cannot pass no matter how the close looked.
export const WEAK_PROCESS_THRESHOLD = 60;
// Cap applied when discovery/rapport is weak: a recommendation (even one the
// client agreed to) can't rescue an attempt with too-shallow discovery. Sits
// safely below the 85 qualifying bar so such attempts clearly fail.
export const WEAK_PROCESS_CAP = 64;
// Cap applied to a soft close (no recommendation at all, or a handoff with no
// committed next step) — this closing behavior specifically scores LOW.
export const SOFT_CLOSE_CAP = 55;

// Beginner-tier leniency. The founder's guidance: beginner should be a "nice
// blend" — easier, but the trainee still has to demonstrate the fundamentals.
// A strong-but-imperfect beginner performance (good discovery + rapport + a
// natural close, with one topic like financing raised a little late) should
// land in the low 80s rather than the high 70s. This is a modest, bounded
// additive nudge applied ONLY at beginner and ONLY after the hard caps below,
// so it lifts genuine borderline performances without rescuing weak-process or
// soft-close attempts (those stay capped). It is further bounded so it can never
// reach the 85 qualifying bar (see computeConsultingOverall): a single lenient
// bump must not manufacture advancement — that still has to be earned outright.
export const BEGINNER_LENIENCY_BONUS = 3;

// Graceful-referral scoring. A referral only counts as a legitimate successful
// outcome when it follows a genuine, competent discovery effort — the persona
// was given a real chance to reveal a vision/motivation and still couldn't or
// wouldn't. Process quality (discovery + objection-prevention + trust) is the
// deterministic proxy for that good-faith effort. Below this bar, a referral
// reads as "gave up early / bad questions / bailed" and is capped low so lazy
// or premature referrals never score well.
export const REFERRAL_MIN_EFFORT_THRESHOLD = 70;
// Cap applied to a premature/lazy referral (referred out without the good-faith
// discovery effort above). Same low band as a soft close: not an acceptable way
// to end the conversation.
export const PREMATURE_REFERRAL_CAP = 55;

// Constrained-close (Tier A) cap. When a real scheduling constraint was present
// but the consultant let the conversation end on a vague deferral ("we'll call
// you when we're back") with nothing concrete locked in, that is a
// solution-engineering MISS: the trainee didn't engineer around a real, workable
// constraint. It is scored notably below the two stronger constrained tiers and
// cannot reach the qualifying bar — but the cap sits ABOVE the soft-close cap
// because the constraint is legitimate and discovery genuinely surfaced it, so
// this is not as bad as a bare walk-away with no reason at all.
export const CONSTRAINED_DEFERRAL_CAP = 72;

// Combines the discovery rubric sub-scores with the close/buy-in outcome into a
// single overall score for a CONSULTING session. This is a genuine weighted
// blend, not a binary "was a recommendation stated" gate:
//   - process quality (discovery + objection-prevention + trust) is the heaviest weight,
//   - the close/buy-in outcome anchors the closing dimension,
//   - the close-execution sub-scores (naturalClose + relationshipContinuity) fine-tune.
// Two hard rules encode "necessary but not sufficient": weak discovery/rapport
// caps the score below passing, and a soft/no-commitment close caps it low.
export function computeConsultingOverall(
  rubric: RubricScores,
  closeOutcome: CloseOutcome,
  difficulty: string = "intermediate",
  // Transaction-type close-expectation baseline. Defaults to "same_day" so every
  // existing (non-real-estate) caller is scored exactly as before. A "multi_step"
  // deal (buyer's agent, manufactured dealer) re-anchors committed-next-step
  // outcomes to the top tier and never penalizes the absence of a same-day close.
  closeExpectation: CloseExpectation = "same_day"
): number {
  const process = (rubric.needsDiscovery + rubric.objectionPrevention + rubric.trustBuilding) / 3;
  const closeExecution = (rubric.naturalClose + rubric.relationshipContinuity) / 2;
  const anchor = anchorForExpectation(closeOutcome, closeExpectation);

  // A graceful referral is scored as a legitimate SUCCESSFUL outcome, but only
  // when it was earned. When the good-faith discovery effort gate is met, it
  // blends exactly like a strong close (its high anchor + the gracefulness of
  // the handoff, captured by naturalClose/relationshipContinuity). When it is
  // NOT met, the referral was premature/lazy and is capped low regardless of a
  // high anchor.
  const isEarnedReferral =
    closeOutcome === "graceful_referral" && process >= REFERRAL_MIN_EFFORT_THRESHOLD;

  let overall = 0.5 * process + 0.3 * anchor + 0.2 * closeExecution;

  // Track whether a hard cap fired so beginner leniency below can never rescue a
  // genuinely failing attempt (weak process, soft close, or premature referral).
  let capped = false;

  // Recommendation is necessary but not sufficient: too little discovery/rapport
  // fails the attempt even when a recommendation (or agreement) was reached.
  if (process < WEAK_PROCESS_THRESHOLD) {
    overall = Math.min(overall, WEAK_PROCESS_CAP);
    capped = true;
  }
  // A soft close is not an acceptable outcome — score it low for the closing dimension.
  if (closeOutcome === "none" || closeOutcome === "handoff_no_commitment") {
    overall = Math.min(overall, SOFT_CLOSE_CAP);
    capped = true;
  }
  // A referral that was NOT preceded by a genuine discovery effort reads as
  // giving up — cap it low so lazy/premature referrals never score well.
  if (closeOutcome === "graceful_referral" && !isEarnedReferral) {
    overall = Math.min(overall, PREMATURE_REFERRAL_CAP);
    capped = true;
  }
  // Tier A of the constrained-close ladder: a real scheduling constraint was
  // present but the consultant let it end on a vague deferral with nothing
  // concrete secured. This is a solution-engineering miss — capped notably below
  // the stronger constrained tiers (and below the qualifying bar) so it can't
  // pass, but deliberately NOT nuked to the soft-close floor: the constraint is
  // real and discovery surfaced it, so it outranks a bare no-reason walk-away.
  // Tiers B/C (plan committed, deposit secured) are legitimate strong outcomes
  // and are intentionally NOT capped here — they blend like any earned close.
  if (closeOutcome === "constrained_deferral") {
    overall = Math.min(overall, CONSTRAINED_DEFERRAL_CAP);
    capped = true;
  }

  // Beginner leniency: a modest, bounded nudge applied only to non-capped
  // performances, so it lifts a genuine borderline beginner attempt into the low
  // 80s the founder wants (e.g. a 79 becomes an 82) without rescuing a failing
  // one. Two safeguards keep it honest: it only ever RAISES a score (never
  // lowers), and it can never lift a score to the 85 qualifying bar — a single
  // lenient bump must not manufacture advancement, so leniency alone tops out at
  // one point below the bar. A genuinely excellent beginner performance that
  // already computes to 85+ on its own merits is untouched and still qualifies.
  // Skipped for an (already full-credit) earned referral.
  if (difficulty === "beginner" && !capped && !isEarnedReferral && overall < ADVANCE_THRESHOLD) {
    const bonused = Math.min(overall + BEGINNER_LENIENCY_BONUS, ADVANCE_THRESHOLD - 1);
    overall = Math.max(overall, bonused);
  }

  return Math.round(Math.max(0, Math.min(100, overall)));
}

// Deterministic detection of a consultant "wrap-up" / soft-close attempt: saying
// goodbye, thanking off, handing over contact info, or promising to follow up.
// Used to force an explicit clarifying checkpoint ("end and score now, or keep
// going?") instead of silently holding the session open or guessing it's over.
const CLOSE_INTENT_PATTERNS: RegExp[] = [
  /\bgood\s?bye\b/,
  /\bbye(?:\s+now)?\b/,
  /\bsee you\b/,
  /\btake care\b/,
  /\bhave a (?:good|great|nice)\b/,
  /\b(?:here'?s|take|leave you) my (?:card|number|info|contact|details)\b/,
  /\bbusiness card\b/,
  /\bcall me\b/,
  /\bgive me a call\b/,
  /\b(?:when|whenever) you'?re ready\b/,
  /\bi'?ll (?:follow up|be in touch|let you go|check back|get back to you|leave you)\b/,
  /\bfollow up with you\b/,
  /\breach out\b/,
  /\bthanks?(?: you)? (?:for your time|so much|again)\b/,
  /\bthank you for your time\b/,
  /\bappreciate your time\b/,
  // Graceful-referral / "not the best fit" wrap-ups. A referral is also a way of
  // ending the conversation, so it must trigger the same end-and-score checkpoint.
  /\b(?:best|right|good)\s+fit\b/,
  /\brefer you (?:to|out)\b/,
  /\bpoint you (?:to|toward|in the direction)\b/,
  /\bsomeone (?:who|that) (?:can|could|might|may|would) (?:better |)(?:serve|help|fit)\b/,
  /\bbetter served (?:by|elsewhere)\b/,
];

export function detectCloseIntent(text: string): boolean {
  const normalized = (text ?? "").toLowerCase();
  if (!normalized.trim()) return false;
  return CLOSE_INTENT_PATTERNS.some((re) => re.test(normalized));
}

// The scoring result shape returned to callers and cached verbatim.
export type ScoreResult = { rubric: RubricScores | LeadershipRubricScores; feedback: string; overall: number };

// The one API call scoreTranscript makes, factored out so tests can inject a
// spy/stub without reaching OpenAI. Mirrors the WrittenGradeResponder seam:
// production defaults to the shared client; tests pass their own. Takes the
// fully-built input and the routing cache key, returns raw output_text.
export type ScoreResponder = (input: string, promptCacheKey: string) => Promise<string>;

const defaultScoreResponder: ScoreResponder = async (input, promptCacheKey) => {
  const response = await client.responses.create({
    model: CHAT_MODEL,
    input,
    prompt_cache_key: promptCacheKey,
  });
  return response.output_text || "";
};

// The subset of storage scoreTranscript needs, injectable so tests can supply an
// in-memory fake instead of hitting Postgres.
export interface ScoreCacheStore {
  getScoreCacheEntry(contentHash: string): Promise<ScoreCache | undefined>;
  createScoreCacheEntry(entry: InsertScoreCache): Promise<ScoreCache>;
}

// Stable sha256 over EVERYTHING that affects the scoring result: each turn's
// role + exact text in order, plus difficulty, track, and transactionType. The
// serialized structure is built with a fixed key order here (not relying on the
// insertion order of objects handed in by arbitrary callers), so byte-identical
// inputs always hash identically and any trivial difference (one changed word,
// a different track/difficulty/transactionType) yields a different hash.
export function computeScoreCacheHash(
  transcript: TranscriptMessage[],
  difficulty: string,
  track: string,
  transactionType: string | null | undefined
): string {
  const normalized = {
    transcript: transcript.map((m) => ({ role: m.role, content: m.content })),
    difficulty,
    track,
    transactionType: transactionType ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

// Scores a completed session. Branches on the scenario's `track`: consulting
// sessions use the discovery rubric (RubricScores); leadership sessions use the
// conflict-management rubric (LeadershipRubricScores). Both are stored the same
// way (JSON text in sessions.rubricScores) and disambiguated by track on read.
//
// Results are cached by a content hash of the inputs (see computeScoreCacheHash)
// so identical input deterministically returns the identical stored output with
// NO API call. OpenAI's Responses API has no seed parameter and does not
// guarantee identical output even at temperature 0, so this cache — not
// model-level determinism — is what makes repeat scoring reproducible.
//
// `deps` is injected only by tests (spy responder + in-memory cache); production
// callers pass nothing and get the real OpenAI client and Postgres-backed
// storage. The public 4-arg signature is unchanged so existing callers work.
export async function scoreTranscript(
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  track: string = "consulting",
  // Internal-only real-estate transaction type (never trainee-facing). When the
  // scenario carries one, it selects the close-expectation baseline and injects
  // matching guidance into the scoring prompt. Ignored for leadership sessions.
  transactionType: string | null | undefined = null,
  deps: { responder?: ScoreResponder; cache?: ScoreCacheStore } = {}
): Promise<ScoreResult> {
  const responder = deps.responder ?? defaultScoreResponder;
  const cache = deps.cache ?? storage;

  // Deterministic short-circuit: identical inputs return the stored result and
  // make no API call.
  const contentHash = computeScoreCacheHash(transcript, difficulty, track, transactionType);
  const cached = await cache.getScoreCacheEntry(contentHash);
  if (cached) {
    return {
      rubric: JSON.parse(cached.rubric) as RubricScores | LeadershipRubricScores,
      feedback: cached.feedback,
      overall: cached.overall,
    };
  }

  const transcriptText = transcript
    .map((m) => `${m.role === "customer" ? "Customer" : "Consultant"}: ${m.content}`)
    .join("\n");

  const isLeadership = track === "leadership";
  const system = isLeadership ? LEADERSHIP_RUBRIC_SYSTEM : RUBRIC_SYSTEM;
  const calibrationMap = isLeadership ? LEADERSHIP_RUBRIC_DIFFICULTY_CALIBRATION : RUBRIC_DIFFICULTY_CALIBRATION;
  const calibration = calibrationMap[difficulty] ?? calibrationMap.intermediate;
  const keys = isLeadership ? LEADERSHIP_RUBRIC_KEYS : CONSULTING_RUBRIC_KEYS;

  // Consulting sessions with a known transaction type get a type-specific
  // calibration block appended so the model classifies the close outcome against
  // the right same-day-vs-multi-step expectation. Leadership sessions and
  // untyped scenarios get no extra block (identical prompt to before).
  const txnCalibration =
    !isLeadership && transactionType && transactionType in TRANSACTION_TYPE_RUBRIC_CALIBRATION
      ? TRANSACTION_TYPE_RUBRIC_CALIBRATION[transactionType as TransactionType]
      : "";

  // Stable rubric + calibration lead; the volatile transcript comes last so the
  // rubric prefix (identical for every session at the same track/difficulty/type)
  // can be served from cache.
  const stablePrefix = txnCalibration
    ? `${system}\n\n${calibration}\n\n${txnCalibration}`
    : `${system}\n\n${calibration}`;

  const raw = (await responder(`${stablePrefix}\n\nTranscript:\n${transcriptText}`, cacheKeyForPrefix(stablePrefix))).trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Scoring model did not return valid JSON");
  }
  const parsed = JSON.parse(jsonMatch[0]);

  const rubric = Object.fromEntries(keys.map((k) => [k, parsed[k] ?? 0])) as unknown as
    | RubricScores
    | LeadershipRubricScores;

  // Consulting sessions use the tiered recommendation + client-buy-in weighting
  // (see computeConsultingOverall). Leadership sessions keep the flat mean of
  // their de-escalation dimensions.
  const overall = isLeadership
    ? Math.round(keys.reduce((sum, k) => sum + (parsed[k] ?? 0), 0) / keys.length)
    : computeConsultingOverall(
        rubric as RubricScores,
        normalizeCloseOutcome(parsed.closeOutcome),
        difficulty,
        closeExpectationForTransactionType(transactionType)
      );

  const result: ScoreResult = { rubric, feedback: parsed.feedback ?? "", overall };

  // Persist under the content hash so the identical input returns this exact
  // result next time with no API call. The raw transcript + params are stored
  // for debuggability; lookups key only on contentHash.
  await cache.createScoreCacheEntry({
    contentHash,
    rubric: JSON.stringify(result.rubric),
    feedback: result.feedback,
    overall: result.overall,
    track,
    difficulty,
    transactionType: transactionType ?? null,
    transcript: JSON.stringify(transcript.map((m) => ({ role: m.role, content: m.content }))),
    createdAt: new Date().toISOString(),
  });

  return result;
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
    prompt_cache_key: cacheKeyForPrefix(buildWrittenGradingStablePrefix(input)),
  });
  return response.output_text || "";
};

// The stable, per-question prefix of a grading prompt: the grading instruction,
// the question, the rubric, and the output-format instruction. Only the
// candidate's answer varies between submissions for the same question, so
// placing the answer LAST keeps this prefix cacheable across candidates.
export function buildWrittenGradingStablePrefix(prompt: string, rubric?: string): string {
  // Called two ways: (prompt, rubric) when building, or (fullPrompt) to derive a
  // cache key from an already-built prompt. When only one arg is given we key on
  // everything up to the candidate's answer.
  if (rubric === undefined) {
    const marker = "\n\nCandidate's answer:";
    const idx = prompt.indexOf(marker);
    return idx === -1 ? prompt : prompt.slice(0, idx);
  }
  return `You are grading a single free-text answer on a professional certification exam. Decide whether the candidate's answer satisfies the rubric.

Question: ${prompt}

Rubric for a correct answer: ${rubric}

Respond with ONLY valid JSON, no other text: {"correct": boolean, "reason": string}. Mark "correct" true only if the answer substantively meets the rubric.`;
}

export function buildWrittenGradingPrompt(prompt: string, rubric: string, answer: string): string {
  return `${buildWrittenGradingStablePrefix(prompt, rubric)}

Candidate's answer: ${answer || "(no answer provided)"}`;
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

  // Stable instruction leads; the volatile transcript comes last so the
  // instruction prefix is cacheable across calls.
  const stablePrefix = `Read this discovery-training role-play transcript. Has the consultant reached a terminal point — that is, either (a) proposed ANY recommendation, solution, product/option, or next step/close to the customer, even a tentative or partial one, OR (b) after a genuine discovery effort, gracefully referred the customer elsewhere because they aren't the right fit? Answer with ONLY the single word "yes" or "no".`;

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input: `${stablePrefix}\n\nTranscript:\n${transcriptText}`,
    prompt_cache_key: cacheKeyForPrefix(stablePrefix),
  });

  const raw = (response.output_text || "").trim().toLowerCase();
  return raw.startsWith("yes");
}

// Level progression order and the score threshold to auto-advance. Advanced is
// the ceiling — there is no auto-advance beyond it.
export const LEVEL_ORDER = ["beginner", "intermediate", "advanced"] as const;
export type Level = (typeof LEVEL_ORDER)[number];
// The qualifying-score bar and the number of individually-qualifying sessions
// needed to advance live in @shared/advancement so the client shows the exact
// numbers the server enforces. Imported for local use and re-exported to keep
// existing importers (routes.ts, tests) unchanged.
import { ADVANCE_THRESHOLD, REQUIRED_QUALIFYING_SESSIONS } from "@shared/advancement";
export { ADVANCE_THRESHOLD, REQUIRED_QUALIFYING_SESSIONS };

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
type LeveledScenario = { id: number; track?: string | null; difficulty: string; vertical?: string | null };

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

// Like scoresForTrackAtLevel, but ALSO scoped to a single industry vertical. This
// is what keeps per-industry certification progress (industry_certifications)
// independent per vertical: a consultant advancing in Manufactured Housing never
// advances their Real Estate progress, even on the same track and difficulty.
export function scoresForVerticalAtLevel(
  track: string,
  vertical: string,
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
      return (
        scenarioTrack(scenario.track) === track &&
        scenario.difficulty === level &&
        (scenario.vertical ?? null) === vertical
      );
    })
    .map((s) => s.score as number);
}
