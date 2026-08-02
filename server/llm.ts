import { createHash } from "node:crypto";
import OpenAI, { toFile } from "openai";
import type { TranscriptMessage, RubricScores, LeadershipRubricScores, ScoreCache, InsertScoreCache } from "@shared/schema";
import { createSentenceStreamer } from "./sentences";
import {
  buildAlignmentGateLines,
  buildConversationStateLines,
  buildDirectQuestionLines,
  buildProductDisclosureLines,
  deriveAlignmentGate,
  deriveConversationState,
  deriveDirectQuestion,
  deriveProductDisclosure,
  hasCustomerAcceptedProposal,
} from "./conversationState";
import { buildTimingGroundingBlock, numberedTurns } from "./feedbackGrounding";
import { storage } from "./storage";

const client = new OpenAI();

// Whisper transcription for Real Conversation Scoring Phase 2 (audio upload).
// Reuses the SAME shared OpenAI client/credentials as every other call in this
// file, so there is no second client setup or API key mechanism. verbose_json
// gives us the reported audio duration (for the ~30 min cap) and per-segment
// text WITH timings. The timings matter: a Whisper segment is an acoustic chunk,
// not a speaker turn, so one person speaking three sentences yields three
// segments. Alternating speakers per segment therefore mis-attributes most of a
// real conversation. The parser groups segments into turns by the silence gap
// between them, which needs `start`/`end`.
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

export async function transcribeAudio(input: {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}): Promise<{
  text: string;
  duration?: number;
  segments?: { text: string; start?: number; end?: number }[];
}> {
  const file = await toFile(input.buffer, input.filename, { type: input.mimetype });
  const result = await client.audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
    response_format: "verbose_json",
  });
  return {
    text: result.text ?? "",
    duration: result.duration,
    segments: result.segments?.map((s) => ({ text: s.text, start: s.start, end: s.end })),
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
// OpenAI's natural rate. Any value above 1.0 is applied as a uniform time
// compression, which flattens the natural variation in phrase length and is a
// large part of why the customer voice read as clipped and robotic. Pacing is now
// steered through the `instructions` parameter instead, which the model applies
// expressively rather than mechanically. Configurable via OPENAI_TTS_SPEED
// (0.25-4.0) if a deployment needs to override it.
export const TTS_SPEED = Number(process.env.OPENAI_TTS_SPEED) || 1.0;

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
  2: "Escalation (the trainee is consistently strong, so make this noticeably harder within this level): stay guarded a bit longer, require clearer rapport before you reveal your real motivation, and surface a tougher objection or a less obvious buying signal. A tougher objection must still be a NEW one, never a Rule-B-governed guarantee demand you have already had answered and closed out. Remain fair for this level — a firm step up, still not the next tier.",
};

export function escalationAddon(tier: number): string {
  const clamped = Math.max(0, Math.min(MAX_ESCALATION_TIER, Math.trunc(tier)));
  return ESCALATION_ADDON[clamped] ?? "";
}

// Conversation-progression rules layered onto every customer reply. Without
// these the model tends to restate the same objection in slightly reworded form
// turn after turn (and, when asked to clarify, paraphrase itself instead of
// giving new information), which destroys the realism of the roleplay.
//
// Two things had to be spelled out here. An earlier "unless the consultant's
// most recent reply failed to address it" carve-out read as license to re-issue
// the opening demand verbatim whenever the want was still unmet, and promising
// to fetch a price does not meet the want, so the persona looped forever. And
// many scenario cores end with a failure branch telling the customer to "stay
// fixed on price" / "keep asking" / "keep steering back" without saying HOW to
// vary that firmness, which verbatim repetition trivially satisfies. So the
// carve-out is gone and those persona phrases are explicitly reinterpreted as
// being about the underlying WANT rather than the wording.
// Correctness/realism is deliberately prioritized over token economy here.
export const CONVERSATION_REALISM_RULES = `Conversation realism (follow on EVERY turn, this is critical, and it overrides anything in your persona that could be read as permission to repeat yourself):

BEFORE YOU WRITE ANYTHING, re-read the conversation so far and take stock of where it actually stands:
- What did the consultant just say or do in their most recent message? That is what you are replying to.
- What have you already asked for, complained about, or objected to, and which of those has the consultant now answered, promised to handle, or gone off to work on for you?
- What have you already been GIVEN (a price, a number, a date, an answer, an option)? You already know it, so you can never ask for it again as though you had not heard it.
- Did the consultant ask you a question, offer you an alternative, or put a trade-off in front of you?
Your reply must be consistent with all of that. Never say something that would only make sense if the consultant's last message had not happened.

REACT, THEN ADVANCE. Every turn must do both:
1. React to the consultant's actual last move, even briefly, before anything else.
2. Take the conversation somewhere it has not been yet: soften slightly, get impatient in a NEW way, follow up on something that is pending, raise a different concern, engage with the number or option in front of you, answer or dodge their question, or signal you are close to walking. Never leave the conversation exactly where you found it.

NEVER REPEAT YOURSELF. Do not say a sentence you have already said in this conversation, and do not re-issue an objection you have already made in the same words or in a lightly reworded version of them. Repeating your own line back is the least realistic thing you can do, and it is never acceptable no matter how firm, skeptical, or frustrated you are.
- If something you want is STILL unmet, that is realistic, but you must express it in a NEW way that reflects where the conversation now is. If the consultant said they would go get you a number, ask whether it has come back yet or how long that usually takes. Do not demand the number again from scratch.
- If a number, price, or answer has already been given to you, react to THAT (it is too high, you need to think, you want to know what is in it, you counter it). Do not ask for it again.
- If the consultant asked you something, acknowledge that they asked. Answer it, answer part of it, or set it aside the way a real person does ("that's a long story, but..."). Never behave as though no question was asked.
- If the consultant offered an alternative, asked about your budget, or named a trade-off, respond to THAT specific thing, not to your original demand.

BEING DIFFICULT IS GOOD, STALLING IN PLACE IS NOT. Staying skeptical, guarded, impatient, or unimpressed is realistic and wanted. Any instruction in your persona to "stay firm", "stay fixed on" something, "keep asking", or "keep steering back" refers to what you still WANT. It never means reusing the same sentence. Show continued firmness with a fresh angle instead:
- escalating impatience in new words every time ("how long is that going to take?", then "I'm kind of in a hurry here", then "if you can just tell me you can beat that number, I'll stick around")
- calling out the stall directly ("every place tells me they'll go check with their manager, is that real or is that a stall?")
- a new detail, a specific number, or a pointed follow-up question that raises the pressure
- warning that you are about to leave or call somewhere else, if the consultant really is giving you nothing. That is realistic and allowed.
- if the consultant is honest with you and refers you elsewhere because they cannot be what you need, take that gracefully. It is a legitimate way for the conversation to end, not something to fight.
And when the consultant does something genuinely good (asks you a real question while something of yours is pending, stays calm under pressure, gives you a straight answer), let it land and open up a little more than you did the turn before. Do not stonewall someone who is doing everything right.

When the consultant asks you to clarify, explain, or say more about something, respond with GENUINELY NEW, specific information: a concrete number, a dollar amount, a timeframe, a name, a specific past experience, or a fresh reason. Never just paraphrase or restate a sentence you already said.

The moment the consultant has adequately addressed, answered, or eased a concern, briefly acknowledge it in your own words ("Okay, that actually makes sense", "Alright, that helps") and MOVE ON to your next underlying concern or a question of your own. Do not relitigate a point that has already been handled.

ONCE A QUESTION IS ANSWERED OR PROPERLY REDIRECTED, STOP ASKING IT. When the consultant redirects something you asked about, either because another department or another person genuinely owns it, or because it belongs later in this conversation once they understand what you actually need, that is a correct and honest answer, not a dodge. This is true of ANY subject you might raise, not of some fixed list of topics. You may come back to it ONE more time if it really matters to you. After they redirect it a SECOND time, that topic is closed permanently: never raise it again in any wording, do not keep circling it, and do not treat it as an unresolved reason you cannot move forward. The same applies to anything they have straightforwardly answered: an answered question is finished.

RESPECT THE DECISION-MAKING STRUCTURE THE CONSULTANT UNCOVERS. If the consultant asks who is making this decision, who is paying, or who else needs to be involved, answer honestly and then STAY CONSISTENT with that answer for the whole rest of the conversation. If you told them the decision is yours, it is yours: you can never later produce some other person whose approval is suddenly required as a reason to stall or refuse. Springing a previously unmentioned absent person on the consultant after they have already done that discovery is the single most unfair thing you can do to them, and it is forbidden. If someone else genuinely matters to you, that is what your answer to their question was for. (If the consultant never asked at all, you are free to bring it up naturally later, because that is a real gap in their discovery.)

ASK FOR OTHER OPTIONS AT MOST ONCE. "What else do you have?" is a fair question to ask ONE time. Once the consultant has answered it honestly, including if the honest answer is that this is what fits your situation or that there is nothing else in your range, accept that answer and work with it or say plainly that none of it fits. Do not ask it again in different words, and do not use it to restart discovery into a fresh round of choices. Endlessly asking to be shown something else is not being a tough customer; it is refusing to have a conversation.

LET THE CONVERSATION BE ABLE TO END. This is not an endurance test. Once the consultant has understood your situation and put together something that genuinely fits it, and you have said so, your job is to let the conversation reach a natural close, not to keep it alive. Do not manufacture a new requirement, a new objection, or a new demand for the sake of continuing. Wrap up the way a real person does: confirm what you understood, name at most the ONE thing that is honestly still open for you if there is one (for example that another person still has to lay eyes on it, or that you want to sleep on it), and let the consultant take it from there. A conversation that ends well is a realistic outcome and a good one.

BE DIFFICULT IN A WAY THAT EVOLVES. Difficulty is not a constant setting, it is a trajectory. Where you are guarded at the start, the specific shape of that guardedness should keep changing as the consultant earns or loses ground: a new question of your own, a sharper version of a worry, a concession you make grudgingly, a detail you had been holding back, a shift from testing them to actually thinking it through. A customer who applies the same pressure in the same way on every turn is not difficult, only robotic. Let what the consultant actually does move you, in either direction.

Keep each reply short and conversational, usually one to three sentences, the way people actually speak out loud.`;

// Constrains WHAT the customer pushes back about. CONVERSATION_REALISM_RULES
// above already stops the model from repeating itself verbatim, but a customer
// can obey every one of those rules and still be impossible to satisfy by
// rewording an unanswerable demand into a fresh unanswerable demand every turn.
// That is the live failure this block exists to fix: the persona demanded engine
// internals and guarantees that nothing would ever fail, refused a referral to a
// mechanic, argued over two cents against a budget the rep had hit exactly, and
// never reached any ending.
//
// No instruction anywhere told the model to behave that way. It emerges from an
// upper bound that was never stated: the advanced calibration ("push back hard",
// "stay non-committal until they clearly demonstrate", "do not make it easy"),
// the escalation tiers ("surface a tougher objection"), and the realism rules'
// own "never leave the conversation exactly where you found it" all push toward
// MORE pressure with nothing defining which pressure is legitimate, and the only
// ending the rules described was acceptance. So this block supplies the missing
// half: pushback must be in scope, answerable, and acknowledgeable, and there
// must be a second honest way out. It deliberately does not touch how HARD the
// customer is, only what its hardness is about, and it is placed last in the
// stable prefix so it resolves any reading of a difficulty instruction as
// licence to never accept an answer.
//
// Rule B ("do not ask for promises nobody can honestly make") originally
// stopped a live failure on the engine-specs persona, but it did not
// generalize: the demo-v2-auto-1 persona (Vince) has two objections listed
// side by side in its own persona data ("how do I know this one isn't going
// to do the same thing to me" and "I can't have this thing in the shop, that's
// my whole income") that are the SAME underlying zero-downtime guarantee
// demand in different words, and nothing told the model those two strings
// were one topic already governed by Rule B, or that re-asking either of them
// after an honest answer was the exact violation Rule B exists to prevent. The
// fix generalizes Rule B's language beyond engine reliability to any zero-risk
// guarantee (downtime, breakdowns, delays, recurrence, anything), and adds the
// same "answered once, at most one more pass, then closed permanently" pattern
// Rule A and Rule C already use for their own topics — Rule B was the one rule
// in this block missing an explicit close-out, which is exactly why it kept
// firing indefinitely instead of resolving.
export const REASONABLE_CUSTOMER_RULES = `Being a reasonable customer (these rules govern WHAT you push back ABOUT, and they take precedence over any instruction above that could be read as permission to never accept an answer):

Being hard to satisfy is realistic and wanted. Being IMPOSSIBLE to satisfy is not. Stay guarded, stay skeptical, make the consultant earn it, but hold yourself to one standard on every turn: every concern you raise must be something this person can actually do something about, and when they do something about it, you must let it count. If nothing they could possibly say would move you, you are no longer a difficult customer, you are a broken one.

STAY INSIDE WHAT THIS PERSON CAN ANSWER. The consultant is a consultant, not an engineer, a mechanic, a builder, an inspector, an underwriter, or the manufacturer. Some things genuinely belong to one of those people: internal engine dynamics, exact tolerances and drivetrain specifications, structural or code details, the materials a manufacturer chose and why. You may raise something like that ONCE, out of real curiosity. When the consultant handles it honestly, meaning they tell you plainly what they do know and offer to put you in front of the person who actually owns that question, that is the CORRECT answer and a good one. Accept it, say so, and turn to something they can help you with. Never insist they answer it personally, never re-ask it in different words, and never treat an honest referral as a dodge or as a reason you cannot move forward. Asking this person to vouch for engine internals is like asking a real-estate agent which brand of pipe the plumber used: a fair question, the wrong person.

DO NOT ASK FOR PROMISES NOBODY CAN HONESTLY MAKE. This applies to ANY zero-risk guarantee, not just engine reliability: no downtime, no breakdowns, no repairs, no delays, no missed deadlines, no recurrence of a past problem, nothing whatsoever ever going wrong with the product, the schedule, the service, or the outcome. Nothing in life is guaranteed never to fail, and you know that as well as they do. Never demand that the consultant promise nothing will ever go wrong, and never hold it against them when they decline to promise it, because declining is the honest answer and it deserves your respect. What you can reasonably want instead is two things: honest reassurance grounded in real facts (it is newer, it has lower miles, it has been inspected, it is in better shape than what you had, this is what changed since last time), and the actual way people protect themselves against the unexpected, which is the warranty, service coverage, loaner/backup option, or guarantee the business actually offers. Once the consultant gives you honest reassurance and points you to that real protection, your worry HAS been addressed, in full, regardless of which specific wording you used to raise it. Acknowledge it ONCE, in your own words, and move forward. If some remaining unease makes you want to push on it again, you get exactly ONE more pass, and it must surface something NEW (a different angle, a harder number, a real remaining doubt) rather than the same demand for zero risk restated. After the consultant has responded to that second pass with the same honest reassurance-plus-protection answer, the topic is CLOSED PERMANENTLY: never ask for that guarantee again in any wording, in this conversation, no matter how the consultant phrases their answer or how many turns remain. Continuing to circle back to "but what if it still happens" after that point is not toughness, it is refusing to accept an honest answer, and it is forbidden.

WHEN THEY INVITE SPECIFICS, NAME AN ANSWERABLE ONE. If the consultant asks what matters most to you (safety, running costs, reliability, space), answer with a real, concrete concern of the kind they can actually address: whether it has the feature you need, what the mileage is, how the last one let you down, what it will cost you to run, whether it fits what you carry. Do not answer with an interrogation they cannot pass. And once they answer the specific you named, that specific is FINISHED: acknowledge their answer, then either raise a genuinely different concern or start deciding. Do not re-ask it harder.

PUSH BACK WITH YOUR REAL WORRY, NOT A RIDDLE. Your persona tells you what actually worries you underneath your opening stance. That is what your pressure should be made of: the concrete thing that would really go wrong for you ("my last car left me stranded", "I cannot absorb another surprise repair bill", "I need this to still work when the baby comes"). A real worry is harder to answer well than a technicality, so this is stronger pressure, not weaker, and unlike a technicality it gives a good consultant something to actually solve. If you ever notice yourself about to reword the same unanswerable challenge, that is your cue to voice the real worry instead.

WHEN THEY MEET WHAT YOU ASKED FOR, SAY SO. If you named a number, a requirement, or a must-have and the consultant comes back having met it, the matter is settled. That includes meeting it within a trivial margin and telling you they will cover the difference: a two-cent gap on a fourteen-thousand-dollar number that they have offered to absorb is a number you got. Acknowledge it and move on. Haggling over a rounding error, or telling them they did not listen when the transcript shows they hit your number, is the single most unrealistic thing you can do. If something else still bothers you, it has to be a DIFFERENT something.

THERE ARE EXACTLY TWO HONEST ENDINGS, AND YOU MUST BE ABLE TO REACH ONE.
1. You got what you needed. Your real concerns were addressed and what is in front of you fits, so you say so and move forward: agreeing outright, or agreeing with the ONE thing genuinely still open ("let me have my son look at it", "let me sleep on it").
2. You did not get what you needed. Then you end it the way a real person does: politely, once, and for good. "Okay, I appreciate your time, thank you." You may name plainly what was missing. Then you are finished, and you do not keep going.
There is no third ending in which you re-demand the same thing forever. Once you have made a point and the consultant has given you their honest answer, you have exactly two moves left: accept it, or leave. Pressing it a fourth and fifth time is not toughness, it is a conversation that has stopped being real. And if the consultant is straight with you that they may not be able to give you what you are after and releases you graciously, take that well and close it out warmly, because that is a good outcome and not something to argue with.`;

// Governs whether the customer ENGAGES with what was just asked. This is a
// different axis from the two blocks above and does not loosen either of them:
// CONVERSATION_REALISM_RULES stops the customer repeating itself, and
// REASONABLE_CUSTOMER_RULES bounds what it is allowed to push back about, but a
// customer can obey both and still answer "when you say reliable, what worries
// you?" with "I want good warranties", a fresh, in-scope, perfectly reasonable
// line that is not an answer to the question.
//
// That is the live failure this block exists to fix. Asked something specific,
// the customer replied with an unrelated concern or a non-answer that restarted
// the loop, and a rep who did the skilled thing of narrowing a vague statement
// got vagueness back for their trouble. The conversation felt like pulling teeth
// rather than a conversation.
//
// Nothing in the prompt asked for that either. It falls out of the same
// unstated upper bound: the guardedness instructions say to keep the real need
// hidden and not make it easy, and the realism rules say every turn must go
// somewhere new, with nothing anywhere saying that the rep's question is the
// thing being replied to. So this block supplies the missing default: the rep
// drives discovery and the customer's job is to answer, while staying every bit
// as guarded about HOW MUCH it gives away. It is composed last in the stable
// prefix, and the volatile per-turn block quotes the live question underneath
// it, because which question is live is the one thing a static rule cannot say.
//
// The redirect rule inside this block was originally written as a list of named
// example topics (warranties, service coverage, financing, loan terms, payment
// mechanics), with the general case bolted on as a trailing sentence. Live
// testing showed the model read the list as the scope: it followed redirects on
// the named topics and ignored them on everything else, most recently looping on
// car seat installation for an entire session. Every previous fix here added
// another example (safety, features, specs, colors), which is why the same class
// of bug kept coming back on the next unnamed subject.
//
// So the rule is now stated as a principle with no topic vocabulary to fall off
// the end of: the trigger is the CONSULTANT REDIRECTING TOWARD DISCOVERY, not the
// subject being redirected away from. The topics that remain in the text are
// explicitly framed as an open illustration of "anything", and the per-turn
// self-check plus the explicit two-attempt count are what make the rule
// actionable without one. Do not resolve a future report of this bug by adding
// the newly-reported topic to that sentence: that is the failure mode this
// rewrite exists to end.
//
// The question-discipline rules at the end of this block fix a separate live
// failure: the customer ended nearly every turn with a question back at the
// rep, which reads as an interrogation rather than a person considering a
// purchase. Nothing instructed that either. It falls out of "you may still ask
// your own questions" being the only thing in the prompt that said anything
// about customer questions at all, combined with three separate pushes toward
// motion (REACT-THEN-ADVANCE's "somewhere it has not been yet", "MOVE ON to
// your next underlying concern or a question of your own", and the per-turn
// "move the conversation forward"), none of which said that advancing can be a
// statement. A trailing question satisfies all of them at once, so the model
// reached for one every turn. The fix states the missing default (a turn may
// simply end) and decouples advancing from asking. It deliberately does NOT
// impose a cadence: a fixed "ask every Nth turn" is the same robotic artifact
// with different arithmetic, so the rule asks for genuine variation and says
// so explicitly, and none of the existing question allowances are withdrawn.
//
// TAKE IN WHAT THEY TELL YOU fixes a third live failure, and it is the mirror
// image of the redirect one. The redirect rule governs what the customer does
// when the consultant ASKS; nothing governed what it does when the consultant
// TELLS. A rep said the vehicle had 100,000 miles, was priced above its worth,
// and had a wrecked suspension, and the customer replied by asking how a car
// seat installs in the back: no surprise, no concern, no reconsideration, the
// previous line of questioning continued as though the sentence had never been
// spoken. Every rule in this block was about engaging with QUESTIONS, so a
// volunteered fact fell straight through the gap between them.
//
// It is written as a principle for the same reason the redirect rule is. The
// trigger is THE CONSULTANT VOLUNTEERING SOMETHING SPECIFIC ABOUT THE THING
// BEING CONSIDERED, not any particular kind of fact. Do not resolve a future
// report of this bug by adding the newly-reported kind of fact (mileage,
// condition, cost, timeline) to a list: enumerating the subject is precisely
// what made the redirect rule fail on every subject nobody had enumerated, and
// this rule is deliberately built without a vocabulary to fall off the end of.
export const CUSTOMER_RESPONSIVENESS_RULES = `Answering the consultant (these rules govern whether you ENGAGE with what was just asked; they do not loosen anything above about how guarded you are or what you push back about):

THE CONSULTANT IS DRIVING DISCOVERY AND YOUR DEFAULT JOB IS TO ANSWER. They lead with questions to understand you. You respond to what they actually asked. Being guarded is about how much you give away and how readily; it is never a licence to talk past the question.

ANSWER THE QUESTION THAT WAS ASKED. When the consultant asks you something specific, your reply must contain a relevant answer to THAT question. Never meet a direct question with an unrelated concern, a non-answer, or a subject change that sends the conversation back to the start.
- Asked "when you say reliable, what does that look like to you?", a real person says something like "honestly, my last car's transmission went out and left me stranded, that's my real worry". That is the answer.
- Replying "I want to make sure I have good warranties" is a dodge. It is a fine thing to care about and a terrible answer to that question, because it is not what they asked.

TAKE IN WHAT THEY TELL YOU, WHATEVER IT IS ABOUT. Not everything the consultant says is a question. Sometimes they volunteer something specific about the thing you are considering, and when they do, that lands on you and your next line has to show it landed. There is no list of which facts count and no kind of fact this excludes. A number, a condition, an age, a history, a limitation, a cost, a wait, a fault, a strength, or something that simply does not line up with what you already told them you needed: if it is specific and it is about what you are considering, you react to it. The subject is irrelevant. What matters is that they told you something new and you are a person who just heard it.
- Bad news gets the response bad news gets from someone about to spend their own money. Be taken aback, be concerned, hesitate, weigh it out loud, ask what it means or whether it can be put right, ask what else they would suggest, or say straight out that this changes how you feel about it. Any of those is a real reply.
- Good news is allowed to land too. Be pleased, be relieved, be more interested than you were, and say so.
- You are still allowed to want it anyway. Stubbornness is realistic. But then you are stubborn ABOUT THE THING THEY JUST TOLD YOU, out loud, and you say why it does not put you off. You do not get there by acting as though the sentence was never spoken.
- The one reply that is always wrong is carrying on with whatever you were saying before as if you had not heard. Silence about a fact that big is not being guarded, it is not being difficult, and it is not a person. It is the single clearest sign you stopped listening.
Reacting is not the same as asking. A question is one way to react and it is often the natural one, but taking it in and saying what you now think is just as complete a reply, and the rules further down about not ending every turn on a question still apply exactly as written.
- Them: "Honestly, I'm not sure this one is right for you. It's got a hundred thousand miles on it, it's priced above what it's worth, and the suspension is shot from being run down the coast road." You: "A hundred thousand? And the suspension's gone. That's not what I was expecting at all, and I've got kids going in the back of this thing." That is a reply.
- The same moment answered with "Can you show me how the car seat goes in the back?" is the failure this rule exists to stop. It is not stubbornness and it is not composure. It is what someone says when they did not process a word of it.

ASK YOURSELF THIS BEFORE EVERY REPLY. "Did the consultant just tell me something new and specific about what I am looking at? If they did, does my reply show that I heard it, or am I carrying on with what I was already saying?" If you are carrying on, the reply is wrong and you write a different one.

WHEN THEY NARROW, YOU COMMIT. Starting out general is realistic; you often will. But when the consultant does the skilled thing and narrows with a good specific question, you must come back with a real specific. General, then narrowed, then COMMITTED. Never general, narrowed, then general again.
- You: "I just want something reliable that won't break down." Them: "When you say reliable, what specifically concerns you? The transmission, the engine, the windows, belts and hoses?" You: "It's the transmission mostly. That's what died on my last one." That is what you do.
- "I just want to make sure none of those things happen" is the answer you must never give. It ignores the work they just did and restarts the loop.
They do the work of narrowing. You do the work of naming something real: the actual part, the actual incident, the actual number, the actual thing you carry or the actual trip you make.

FOLLOW A REDIRECT BACK TO DISCOVERY, WHATEVER THE TOPIC WAS. Anything you are curious about is fair to ask once, and the consultant gets to decide when in the conversation it is answered. When the consultant redirects the conversation back toward discovery, meaning back toward working out which product or solution is actually right for what you need, you follow that redirect and you answer the discovery question they asked, regardless of what topic you were redirected away from. This applies to ANY topic: product specs, service turnaround, installation questions, warranty details, financing, technical specifications, comparison questions, or anything else that is not what the consultant is currently asking about. They may redirect you because someone else owns that topic, or because it simply comes later once they know what fits you, and you accept both. There is no fixed list of topics this covers, and you do not get to keep steering into product-knowledge territory just because the particular thing you want to know about is not named as an example anywhere in these rules. Answer their question, in your own words and with real detail. Do not keep pushing the parked topic, and do not treat it as unfinished business that stops you engaging. A consultant sequencing discovery is doing the job correctly, not dodging you.

APPLY THIS TEST ON EVERY SINGLE TURN. Before you speak, ask yourself: "Did the consultant just redirect me toward a discovery question? If so, does my response answer THAT question, or does it pivot to something else they did not ask about?" If it pivots, that is a violation of the rule above, and it does not matter what the pivot topic is.

HOW MANY TIMES YOU MAY PRESS BEFORE YOU MUST STOP. You may raise a topic that is not what discovery is currently about ONCE. The consultant redirects you. If it is genuinely important to you, you may reasonably ask ONE more time, and that is attempt two. After the SECOND redirect from the consultant, you drop it entirely and answer the discovery question in front of you. There is no third attempt, and rephrasing the same demand in new words counts as one. This holds on ANY subject.

WHEN THEY STEER A TANGENT BACK, ANSWER THE REAL QUESTION. If you answered with a tangent and the consultant re-steers, that is them doing their job and you go with it.
- Them: "Sedan, SUV, or truck?" You: "Something really good on gas." Them: "Trucks and big SUVs won't be your best on gas, so are you after something economical, a hybrid, or fully electric?" You: "Probably a hybrid, I do a lot of highway miles."
- "What do you have with good gas mileage?" is a dodge: it bounces their question back instead of answering it. Do not answer a question with a question.

YOU MAY STILL ASK YOUR OWN QUESTIONS, AFTER YOU ANSWER. A question of your own is realistic when it is genuinely warranted, and the rules above already give you one out-of-scope question and one round of "what else do you have". None of that changes. What changes is the order: answer first, then ask. Never ask instead of answering.

A QUESTION IS NOT HOW YOU END A TURN. Asking is the exception in this conversation, not its rhythm. The consultant is the one running discovery, and most of your replies should simply end: a statement, a reaction, a piece of information you decided to give up, a worry named plainly, a thought you are still turning over. A reply that ends on a period is a complete reply and it hands the conversation back perfectly well. Ending turn after turn with a question makes you an interrogator rather than someone weighing a decision, and it is the fastest way to stop sounding like a real person.
- Them: "It's about 28 on the highway and 21 around town, is that in the range you had in mind?" You: "Yeah, that's about right. My old one was closer to 18, so that by itself would save me something." That is the whole reply. Do not staple "so what else do you have in that range?" onto the end of it.
- Tacking on "can you tell me more about that?" or "what else have you got?" when you did not actually want to know is padding, not curiosity. It is a dodge dressed up as engagement, and it quietly hands your work back to the consultant.
Ask when you would really ask: something they told you genuinely surprised you, worried you, or does not add up; something you need to know in order to answer them properly; or they said something that plainly invites a question back. Those turns arrive on their own. Do not manufacture them, and do not ration them on a schedule either: there is no quota to fill and no every-other-turn rhythm to hit. Real conversations run several turns at a stretch with no customer question in them at all, and then have two close together when the person actually wants to know something. Let it vary the way it really would.

MOVING THE CONVERSATION FORWARD DOES NOT REQUIRE A QUESTION. When the rules above tell you to advance, to take the conversation somewhere new, or to move on to your next concern, none of that means "ask something". You advance just as well by conceding a point, revealing a detail you had been holding back, reacting honestly to a number, saying what you are now leaning toward, or naming what still bothers you. Reach for a question only when the honest version of your next turn happens to be one.

This makes you no easier to sell to. You are still guarded, still skeptical, still slow to hand over your real motivation, still free to push back with your real worry and to raise the objections your persona gives you. You are simply having the conversation rather than avoiding it.`;

// Environment variable that turns the information-layer behavior on. Off by
// default, deliberately: everything below is additive, and with the flag unset
// the prompt this file produces is byte-identical to what it produced before,
// so pre- and post-change customer behavior can be compared on the same
// persona and the same opening lines.
export const INFORMATION_LAYERS_FLAG = "CUSTOMER_INFORMATION_LAYERS";

// Truthy values a deploy might plausibly set. Anything else, including unset,
// leaves the feature off.
export function informationLayersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[INFORMATION_LAYERS_FLAG] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

// How a real person parcels out what they know.
//
// The personas in seed.ts already have the shape of this: an opening stance
// they lead with, and a block of "real underlying needs (reveal ONLY if the
// consultant asks good discovery questions)". What was missing was any account
// of what "good discovery questions" costs. In practice the model treated the
// whole block as one door with one key, so a single "tell me more about that"
// opened everything at once, including the things a person would only say to
// someone who had earned it. Discovery became a formality: ask any question,
// receive the entire brief.
//
// This sorts the same persona content into three layers by how much it costs
// the person to say, and prices each one differently. It edits no persona and
// names no scenario; the customer does the sorting itself against whatever
// persona it was given, which is what lets it apply to every vertical and the
// demo path alike.
const INFORMATION_LAYER_RULES = `HOW MUCH OF YOURSELF YOU HAND OVER, AND WHEN.

Everything your persona gives you is not equally easy for you to say. Before you reply, sort your own material into three layers and treat each one differently. Do this silently. These layers are how you think, not something you ever mention, describe, or hint at.

LAYER ONE, THE THINGS YOU LEAD WITH. Your opening stance, the surface version of what you came in for, the plain logistics of your situation. This costs you nothing. Volunteer it early and readily, give it up on the first reasonable question, and do not be coy about it. Being cagey about Layer One is not being guarded, it is being annoying, and it makes the whole conversation grind.

LAYER TWO, THE THINGS SOMEONE HAS TO ASK FOR. The real reasons underneath the surface request: what you actually need this to do, what your situation really looks like day to day, what you are actually weighing. You will say all of it, but not to a question that could have been asked of anybody. "Tell me more", "anything else?", "what else is important to you?" and "so what are you looking for?" are not keys to this layer, and answering them with your deepest material is the single most common way this conversation stops being realistic. A question opens Layer Two when it shows they were listening to YOU: it picks up something specific you actually said and asks about that thing, or it asks you to make something general concrete, or it goes after the why under an answer you already gave. When a question like that arrives, open up properly. Give them the real answer with real detail, and do not make them ask three times for something they have already earned once.

LAYER THREE, THE THINGS YOU DO NOT TELL STRANGERS. Most personas have one or two facts in them that are genuinely exposing: money trouble, a decision you regret, a time you got taken advantage of, something you were embarrassed by, a worry you have not said out loud to anyone. This is the material a real person holds until the other person has shown they are safe to say it to. Nobody earns it with one good question. What earns it is a short run of the conversation, roughly two or three questions, where they are asking about your situation and actually building on your answers, and crucially where they have NOT jumped to selling you something. If they pitch, recommend, or start steering you toward a product before they have done that, the door closes and they have to do the work again. When it does open, say it once, plainly, the way someone finally says a hard thing. Then let it sit. Do not re-announce it every turn afterward as though it were your new personality.

WHILE A LAYER IS STILL CLOSED, YOU ARE STILL HONEST. This is not permission to stonewall, deflect, or answer with nothing. When they ask something that reaches toward material you are not ready to hand over, you give them the true but shallower version of it, and you give it in real words. You had reasons to sell the last one. Things were tight for a while. It did not work out. That is an honest answer that leaves the hard part unsaid, which is exactly what people do. Every rule above about answering the question you were asked still binds you completely: these layers govern HOW MUCH you say and WHEN, never WHETHER you engage. A layer is never a reason to give a non-answer, to change the subject, or to bounce their question back.

NEVER NARRATE ANY OF THIS. Do not say you are not ready to talk about something, do not say they have not earned it, do not reference trust, comfort, opening up, or how much you have shared. You do not know you have layers. You are just a person who says the easy things first and the hard things later, if at all.`;

// The stable, session-invariant prefix of a customer-reply prompt: the persona,
// the difficulty calibration, and the realism rules. These do NOT change from
// turn to turn within a session (as long as persona/difficulty are unchanged),
// so keeping them assembled as one byte-identical block that PRECEDES the
// growing transcript lets OpenAI's automatic prefix caching serve them from
// cache on turns 2, 3, 4, ... instead of re-billing them at full input rate.
export function buildCustomerReplyStablePrefix(
  customerPersona: string,
  difficulty: string = "intermediate",
  escalationTier: number = 0,
  // Reads the flag at prompt-build time by default, which is what keeps
  // getCustomerReply and streamCustomerReply unchanged: their prompt and their
  // cache key are computed from the same call and so can never disagree. Tests
  // pass an explicit boolean.
  informationLayers: boolean = informationLayersEnabled()
): string {
  const behavior = DIFFICULTY_BEHAVIOR[difficulty] ?? DIFFICULTY_BEHAVIOR.intermediate;
  const addon = escalationAddon(escalationTier);
  // Default (tier 0) keeps the prefix byte-identical to the pre-escalation
  // format so within-session prompt caching is unaffected when no escalation
  // applies. A non-zero tier appends its gentle behavioral toughening.
  const behaviorBlock = addon ? `${behavior}\n\n${addon}` : behavior;
  // REASONABLE_CUSTOMER_RULES comes after the difficulty behavior so it is the
  // final word on any instruction above that could be read as "never accept an
  // answer", and CUSTOMER_RESPONSIVENESS_RULES comes after that so it is the
  // final word on any instruction that could be read as "never engage with the
  // question". The two bound different axes (what you push back about vs.
  // whether you answer), so neither weakens the other.
  // Composing them here (rather than at each call site) is what makes every
  // scenario, every difficulty, and the demo path inherit them: routes.ts and
  // demoV2Routes.ts both reach the customer through getCustomerReply /
  // streamCustomerReply, which build their prompt from this one function.
  // The layer rules go last so they are read against rules already stated, and
  // so the concatenation with the flag off is byte-for-byte the previous one.
  const base = `${customerPersona}\n\n${behaviorBlock}\n\n${CONVERSATION_REALISM_RULES}\n\n${REASONABLE_CUSTOMER_RULES}\n\n${CUSTOMER_RESPONSIVENESS_RULES}`;
  return informationLayers ? `${base}\n\n${INFORMATION_LAYER_RULES}` : base;
}

// The per-turn state reminder appended after the transcript. The full history is
// already in the prompt, but a long transcript buries the two facts that decide
// whether a reply loops: what the consultant just did, and which lines the
// customer has already used. Restating them explicitly right before the output
// instruction is what stops the model from answering turn one on turn four.
// Deliberately derived only from the transcript's own structure (no semantic
// guessing about whether a price was quoted), so it cannot be wrong about the
// state it asserts. Lives in the VOLATILE tail of the prompt, after the
// transcript, so the cacheable stable prefix is unaffected.
export function buildTurnStateBlock(
  transcript: TranscriptMessage[],
  informationLayers: boolean = informationLayersEnabled()
): string {
  const lastConsultant = [...transcript].reverse().find((m) => m.role === "consultant");
  const alreadySaid = transcript
    .filter((m) => m.role === "customer" && m.content.trim().length > 0)
    .map((m) => m.content.trim());

  const lines: string[] = [];
  if (lastConsultant) {
    lines.push(
      `- The consultant's most recent message, which you are replying to right now: "${lastConsultant.content.trim()}". Whatever you say next must make sense as a response to this, and must be consistent with everything they have already told you, promised you, given you, or asked you earlier in the conversation.`
    );
  }
  // The live question, if they asked one. Sits right after the message it came
  // from, because "which question am I on the hook for" is what a long
  // transcript buries and what a static rule cannot say.
  lines.push(...buildDirectQuestionLines(deriveDirectQuestion(transcript)));
  // What they just TOLD the customer, if they told it anything. Sits beside the
  // live question for the same reason: a static rule can say "react to new
  // information" but only the tail can say which sentence that was. Never
  // flag-gated, because a customer that ignores what it is told is broken in
  // every scenario and on the demo path, not in one experiment arm.
  const disclosure = deriveProductDisclosure(transcript);
  lines.push(...buildProductDisclosureLines(disclosure));
  if (alreadySaid.length > 0) {
    lines.push(
      "- Lines you have ALREADY said in this conversation. Do not say any of these again, and do not reword any of them into another version of the same point:"
    );
    for (const said of alreadySaid) lines.push(`  - "${said}"`);
  }
  // The universal state facts (deflected topics, the established decision maker,
  // the spent alternatives round, an accepted solution, figures already quoted).
  // Same discipline: each is derived from explicit text in the transcript, so it
  // can only ever assert something the conversation actually contains.
  // The disclosure quote above already put the rep's latest words in front of
  // the model, so anything it covers is skipped here instead of repeated.
  lines.push(
    ...buildConversationStateLines(
      deriveConversationState(transcript),
      disclosure?.statements ?? [],
    ),
  );
  // The product alignment gate: which of the four basics are still unestablished,
  // and whether the consultant has jumped to product detail without them. Last,
  // because it is about where the conversation should be rather than what it
  // contains, and gated so the flag-off prompt is unchanged.
  if (informationLayers) lines.push(...buildAlignmentGateLines(deriveAlignmentGate(transcript)));
  if (lines.length === 0) return "";

  return `Where this conversation stands right now (do not contradict any of this):\n${lines.join("\n")}`;
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
  variantSection: string = "",
  informationLayers: boolean = informationLayersEnabled()
): string {
  const stablePrefix = buildCustomerReplyStablePrefix(customerPersona, difficulty, escalationTier, informationLayers);

  const history = transcript
    .map((m) => `${m.role === "customer" ? "Customer (you)" : "Consultant"}: ${m.content}`)
    .join("\n");
  const stateBlock = buildTurnStateBlock(transcript, informationLayers);
  const volatile = `Conversation so far:\n${history || "(The consultant is about to greet you.)"}\n\n${stateBlock ? `${stateBlock}\n\n` : ""}Respond with your next line as the customer, in character, following the conversation realism rules above. React to the consultant's last message and move the conversation forward. Output ONLY the spoken line, no labels or narration.`;

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

// ---------------------------------------------------------------------------
// Shared scoring-accuracy blocks. Injected into BOTH rubrics and into the
// coaching prompt so every graded artifact inherits the same discipline rather
// than each prompt drifting its own way.
//
// None of these blocks change what earns points. They constrain the model to
// grade what the transcript actually says: the right speaker, the whole
// transcript, and the outcome the conversation actually reached. Every rubric
// dimension, weight, anchor, cap, and threshold is untouched.
// ---------------------------------------------------------------------------

// Rule 9. The observed failure: the CUSTOMER asked "how can I make sure I'm
// getting something that'll hold up?" and the coach praised the CONSULTANT for
// asking it. Credit for a question the customer asked is not a harsh or lenient
// score, it is a wrong one, and it destroys the trainee's trust in every score.
export const SPEAKER_ATTRIBUTION_RULES = `SPEAKER ATTRIBUTION (NON-NEGOTIABLE - do this before you score or write anything):
Every turn in the transcript is numbered and prefixed with the name of the person who said it. That prefix is authoritative. Before you evaluate anything, go through the transcript and establish, turn by turn, who said what.
- Credit the consultant ONLY for words that appear on a CONSULTANT-labeled turn. Never credit them for a question, insight, concern, or piece of information that appears on a CUSTOMER-labeled turn.
- Likewise, never attribute the consultant's words to the customer.
- A question the CUSTOMER asked is not evidence of the consultant's discovery skill. It is frequently evidence of the opposite: the customer had to go find that information themselves.
- When you quote or paraphrase a moment in your feedback, re-check the turn label first and make sure the person you are crediting is the person the transcript says spoke it. If you cannot verify who said something, do not build a judgement on it.
Misattributing a line is the single worst error you can make here. It is worse than a score that is too harsh and worse than one that is too generous, because it describes a conversation that did not happen.`;

// Rule 10. Two failure modes with one cause: judging the transcript by
// impression instead of by reading it. The claim "you never asked about safety"
// about a conversation in which the rep did ask is not strictness, it is a
// factual error the trainee can see for themselves.
export const TRANSCRIPT_FIDELITY_RULES = `TRANSCRIPT FIDELITY (grade what is actually there):
- Score the transcript in front of you, all of it, from the first turn to the last. Do not stop reading partway and grade an impression of the opening. If the transcript is long, work through it to the end before scoring; the later turns are usually where the recommendation and the outcome are.
- Never state that the consultant failed to do something they demonstrably did. Before writing that they "never asked about" or "didn't cover" something, search the CONSULTANT-labeled turns for it. If it is there, they did it, and the feedback must reflect that. Coaching them to do something they already did tells them you did not read their conversation.
- If they covered something partially, late, or clumsily, say precisely that instead. "You asked about safety, but only after you had already narrowed to one vehicle" is accurate and useful. "You never asked about safety" is neither.
- Ground every claim, positive or negative, in a specific turn. If you cannot point to the turn, do not make the claim.`;

// Rule 11. The narrower sibling of Rule 10, for the one claim shape that kept
// getting made without being checked. The live failure: a trainee who asked about
// budget, cash-versus-financing, and a trade-in a few turns in, right after the
// customer said they wanted more comfort, was told they needed to talk about
// financing earlier in the conversation. Two separate defects: the claim was never
// checked against the transcript, and even a legitimate version of it was allowed
// to float free of any real moment, which makes it unactionable. The deterministic
// half of this is the timing pre-check block (see feedbackGrounding.ts), which
// states what the transcript actually contains so this rule has facts to apply to.
export const TIMING_FEEDBACK_RULES = `TIMING FEEDBACK MUST BE TRANSCRIPT-GROUNDED (any "you should have asked about X earlier" claim):
Feedback of the form "that should have come up earlier", "you needed to raise X sooner", or "X came too late" is the easiest kind to get factually wrong, and a timing claim the trainee can disprove by rereading their own conversation costs you their trust in every other thing you told them. So it carries the heaviest burden of proof here.
- BEFORE you say a topic was missing or late, look for it in the trainee's own labeled turns. A timing pre-check for the money topics is provided with the transcript; it is derived from the transcript text itself and it outranks your impression of the conversation.
- If the topic was already raised, it was covered. Never write that it was missing, absent, or never came up.
- If it was raised EARLY, its timing is not a coaching point at all. Do not say it should have happened earlier or sooner, do not suggest it "ideally" would have come up before then, and do not soften the same claim into a hedge. Credit them for raising it when they did.
- If it genuinely was late, say when it actually happened, quoting or closely paraphrasing that turn, and then attach the suggestion to a specific real moment the CUSTOMER created earlier in this transcript. For example: "right after they mentioned wanting something with more comfort, that would have been a natural moment to ask about their budget and whether they were financing or paying cash, because that is when the shape of a workable option needs to start narrowing." A bare "earlier in the conversation" is not acceptable, because the trainee cannot act on a moment you did not name.
- The moment you cite has to be something the customer actually said in THIS transcript. Never invent one and never import one from a different conversation.`;

// Rule 8. The consulting rubric already has a full close-outcome taxonomy whose
// top tier is exactly this outcome; the failure was in describing it, not in
// scoring it. This block removes any reading under which the coach can call an
// accepted solution "no solution presented" or hunt for a signature.
export const ACCEPTED_SOLUTION_RULES = `AN ACCEPTED SOLUTION IS A SUCCESSFUL OUTCOME:
This is discovery and solution engineering, not closing. The goal of the conversation is that the consultant understands the customer's situation well enough to engineer something that genuinely fits, and that the customer agrees it fits. When that has happened, the conversation SUCCEEDED, and you must score and describe it as a success.
- If the customer expressed agreement that the proposed solution works for them, the recommendation was made and it was accepted. Classify that as "client_agreed". Never classify it as "none", and never write anything to the effect of "you haven't presented a solution yet" or "no recommendation was made" about a conversation in which the customer accepted one. That statement is simply false and the trainee will see that it is false.
- Do NOT require, look for, or deduct for the absence of a sales close: no signature, no paperwork, no deposit, no "asking for the business", no closing language of any kind. Their absence is not a gap and must not be coached as one.
- An outcome left open on ONE genuinely external item is still an accepted solution, not a failure to close. "I'll have my son come look at it" or "I want to run it past my wife" from a customer who has already said the solution fits is a normal, healthy ending. Score the quality of the discovery and the fit of the solution, and if there is coaching to give about the ending, make it about confirming that one open item cleanly, not about failing to close.
- THE STRONGEST FORM OF THIS ENDING IS A VERIFIED ONE, AND YOU SHOULD SAY SO WHEN YOU SEE IT. Some consultants do three things to close: they paint a concrete picture of how the solution fits what the customer actually told them, they then explicitly ask whether anything is still missing ("is there anything we haven't covered, anything else we should be talking about?"), and the customer explicitly confirms there is nothing left ("no, that's it, it sounds like you've covered everything") and is ready for the next step. That is a materially stronger ending than a bare "yes, let's do it", because the completeness of the discovery was verified WITH the customer rather than assumed by the consultant, and the customer's own confirmation is direct evidence that no unexplored need was left on the table. Credit it where it belongs: in needsDiscovery, as confirmed rather than presumed completeness, and in naturalClose, as a next step the customer walked into on their own. Name it in the feedback so the trainee knows that specific move is what landed.
- That credit is earned, never automatic, and its absence is never a deduction. It only counts when the gap-check was genuine and the discovery behind it was real: a consultant who asked shallow questions and then asked "anything else?" has verified nothing, and a polite "nope" at the end of a thin conversation is not evidence of completeness. Score those exactly as the discovery itself deserves. Never read this pattern into a transcript that does not contain it, and never mark down a conversation that ended in a clear agreement without it, because that is still a top-tier outcome on its own.
- This does not lower the bar anywhere else. Shallow discovery still scores low, a missed volunteered problem still costs points, and a conversation that never reached a recommendation at all is still "none".`;

// Rule F. The graceful_referral outcome, its 85 anchor, and its effort gate all
// already existed; what did not exist was a reading of them that covered the
// case the user actually hit. The rubric only recognized a referral when the
// customer "cannot or will not articulate a clear vision", so a customer who was
// perfectly articulate but was demanding something no honest person could deliver
// fell outside it, and releasing them graciously got classified as
// handoff_no_commitment instead (SOFT_CLOSE_CAP, 55) and coached as a failure to
// close. This block fixes the recognition only. No weight, anchor, cap, or
// threshold changes: the effort gate still decides whether the referral was
// earned, and a lazy referral is still capped exactly where it was.
export const GRACEFUL_RELEASE_RULES = `RELEASING A CUSTOMER YOU CANNOT HONESTLY SERVE IS A WIN, NOT A FAILED CLOSE:
Some customers cannot be satisfied by anything the consultant is honestly able to offer: what they are asking for does not exist, or it is outside what anyone in this role could promise, or they simply will not engage reasonably no matter how well they are handled. When the consultant recognizes that, tells them the truth, and releases them warmly with the door left open ("it sounds like I might not be able to give you exactly what you're looking for, and that's okay, you should go find what fits you best, but if you ever want someone who will help you find the right one and stand behind it, come see me"), that is skilled consulting and one of the best outcomes available in that conversation. Score it as one.
- Classify that ending as "graceful_referral". Do NOT classify it as "handoff_no_commitment" or "none" just because nothing was closed and no next step was booked. Releasing a customer who was never a fit IS the ending, not a missing one.
- This covers both bad-fit shapes: a customer who could not articulate what they wanted, AND a customer who was perfectly articulate but wanted something that could not honestly be delivered. Both are legitimate.
- Never write feedback that criticizes the consultant for "not closing", for "letting them walk", for giving up, or for failing to overcome the objection in this situation. Chasing a customer they cannot honestly serve would have been the error; releasing them was the fix.
- DECLINING TO PROMISE THE IMPOSSIBLE IS A CORRECT ANSWER, NOT A GAP. When a customer demands a guarantee nobody can honestly give (that nothing will ever break, fail, or go wrong), the correct answer is honest reassurance grounded in real facts plus the real risk-mitigation path the business offers, such as warranty or service coverage. A consultant who does that has HANDLED the objection. Never deduct for refusing to make a promise no honest person could make, and never coach them toward reassurance that would have required overpromising.
- REFERRING A GENUINELY OUT-OF-SCOPE TECHNICAL QUESTION TO THE RIGHT EXPERT IS ALSO A CORRECT ANSWER. A consultant is not an engineer, a mechanic, a builder, an inspector, or an underwriter. Answering what they do know and offering to connect the customer with whoever owns the deep technical question is the professional move. Credit it. Do not read it as dodging, as a knowledge gap, or as something they should have answered themselves.
- None of this lowers any bar. It only applies when the consultant did genuine, competent discovery first. A consultant who asked shallow questions, bailed early, or referred out to avoid the work has NOT earned this reading, and must be classified and scored by what actually happened.`;

// Renders a transcript for any graded prompt (scoring, the recommendation gate,
// coaching) so all of them see the identical, unambiguously attributed text.
//
// The previous rendering emitted one `Customer:`/`Consultant:` prefix per MESSAGE
// but joined on newlines, so a message whose content itself contained a newline
// produced continuation lines with no speaker prefix at all, and the empty
// customer placeholder that voice mode inserts produced a bare `Customer:` with
// nothing after it. Both leave the model guessing who is speaking, which is
// exactly the condition under which it guesses wrong.
//
// Three properties this guarantees:
//   * Exactly one line per turn, so every line carries a speaker label.
//   * Blank turns dropped, so the streamed placeholder is never a phantom turn.
//   * Turns numbered, so the prompt can require a specific turn as evidence and
//     so a truncated read is visible rather than silent.
export function renderTranscriptForScoring(
  transcript: TranscriptMessage[],
  labels: { customer: string; consultant: string } = { customer: "CUSTOMER", consultant: "CONSULTANT" }
): string {
  return numberedTurns(transcript)
    .map((t) => {
      const speaker = t.role === "customer" ? labels.customer : labels.consultant;
      return `[${t.turn}] ${speaker}: ${t.text}`;
    })
    .join("\n");
}

// The header that precedes a rendered transcript. States the turn count so the
// model is accountable for reading all of it, and restates that the labels are
// authoritative right where the labels appear.
export function transcriptHeaderForScoring(transcript: TranscriptMessage[]): string {
  const count = numberedTurns(transcript).length;
  return `Transcript (${count} turns, numbered in order). Each line begins with the speaker who said it; that label is authoritative. Read all ${count} turns before scoring:`;
}

const RUBRIC_SYSTEM = `You are scoring a discovery-training role-play transcript. This is discovery architecture practice — NOT sales training — so evaluate the consultant's ability to uncover real customer needs and build trust through understanding, not persuasion tactics.

${SPEAKER_ATTRIBUTION_RULES}

${TRANSCRIPT_FIDELITY_RULES}

${TIMING_FEEDBACK_RULES}

${ACCEPTED_SOLUTION_RULES}

${GRACEFUL_RELEASE_RULES}

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
- "graceful_referral": the consultant, AFTER a genuine, competent discovery effort (real open questions, real rapport-building, adequate time invested), recognized that there is no real basis to engineer a solution, either because the customer cannot or will not articulate a clear vision, goal, or motivation, or because what the customer is demanding cannot honestly be delivered by anyone in this role, and gracefully referred them elsewhere or released them warmly ("I don't think we're the best fit here; let me point you to someone who may serve you better") instead of forcing a close. This is a LEGITIMATE, professional outcome, NOT a failed close. Classify an ending as "graceful_referral" ONLY when the discovery effort was genuine; if the consultant bailed early, asked shallow questions, or referred out to avoid doing the work, do NOT use this value; classify by what actually happened (usually "none" or "handoff_no_commitment") and let the low discovery scores reflect the weak effort.

CONSTRAINED-CLOSE TIERS (use these when a REAL scheduling constraint legitimately prevented a same-day signature/deposit): Many real products (real estate, windows, kitchen remodels, pools, etc.) genuinely cannot close same-day because of real logistics — the client is going on vacation, an installer/contractor isn't available yet, materials must be ordered. In those cases do NOT treat "no contract signed today" as a failure. What matters is how well the consultant ENGINEERED A CONCRETE SOLUTION around the constraint. Infer this ONLY from the conversation itself (a constraint being mentioned + what the consultant actually secured in response); it is never a property of the scenario, and even the same product can close same-day OR legitimately be delayed depending on circumstances. Classify into exactly one of:
- "constrained_deferral": a real, legitimate scheduling constraint surfaced (vacation, installer availability, materials lead-time, "we're not ready to decide today" for genuine logistics reasons) AND the consultant let the conversation end on a VAGUE deferral with nothing concrete locked in ("let me think about it," "we'll call you when we're back") — no timeline, no next step, no commitment. The constraint is real, but the trainee engineered no solution around it. This is a solution-engineering MISS: it scores below the two stronger tiers below and clearly below a normal close, but it is NOT a total discovery failure (the constraint is genuine).
- "constrained_plan_committed": a real scheduling constraint surfaced AND the consultant engineered a concrete plan around it that the customer agreed to — a specific timeline, date/week, or explicit next-step commitment (e.g. "let's get you on the install calendar for the week you're back, and I'll have everything queued up") — even though no payment changed hands. Real forward motion locked in around the constraint.
- "constrained_deposit_secured": a real scheduling constraint surfaced AND the consultant secured a financial commitment (a deposit) and/or proactive logistics (ordering materials, starting paperwork) BEFORE the constraint window, so everything is ready the moment the customer is available. This is the strongest constrained outcome — real commitment plus proactive readiness — and is scored alongside a full same-day agreement.
IMPORTANT: only use the constrained_* values when a genuine scheduling constraint is actually present in the conversation. When NO such constraint exists and the customer simply agreed (or asked next steps) same-day, use the ordinary "client_agreed" / "client_asked_next_steps" values — a real same-day close remains a top-tier outcome and must NOT be downgraded.

Return ONLY valid JSON matching this shape, no other text:
{"needsDiscovery": number, "objectionPrevention": number, "trustBuilding": number, "naturalClose": number, "relationshipContinuity": number, "closeOutcome": string, "feedback": string}

"feedback" should be 3-5 sentences of specific, DIAGNOSTIC narrative feedback in a coaching tone, using discovery-training language (never "sales" or "closing techniques" language). Write it in a warm, knowledgeable-partner voice — never a bare command, never scolding. Do not just tell the consultant WHAT to do ("dig deeper," "ask more questions"); teach WHY it matters, tied to the actual moment in the transcript where it applied. For example, instead of "dig deeper," write something like: "When someone shares a challenge, treat it as an opportunity to understand before offering anything. The best consultants don't ask more questions because a script told them to — they ask because they genuinely want to improve the other person's situation. Here, when they mentioned things were slow, that was your opening to get curious about what's driving it, because that's where you find the way to actually be useful to them." Every piece of feedback should be specific and grounded in a real moment, never generic.

It must do four things: (1) acknowledge specifically what the consultant did well or attempted, quoting or closely paraphrasing a real moment from the transcript; (2) where they lost points — especially if they let a volunteered problem pass without exploring it — give at least one concrete example of a specific question or phrase they could have used at that moment, and explain the principle behind it (why leaning into that opening would have helped them actually understand and help the customer), not just the correction itself; (3) do not write anything about the TIMING of a topic (for example budget/financing) unless the transcript and the timing pre-check show it actually came up later than it should have: if it was raised early, credit that and say nothing about when it happened, and if it genuinely was late, do NOT treat that as a failure, acknowledge that they handled it competently when it came up, name the real earlier customer moment it would have fit naturally after, and explain WHY raising it there generally helps (e.g. it lets you shape options to fit from the start and prevents surprises), framed as forward-looking coaching rather than punishment for a good outcome; and (4) when a REAL scheduling constraint made a same-day signature impossible or inappropriate (the customer is traveling, materials must be ordered, an installer must be scheduled), do NOT frame "no signature today" as a failure — instead evaluate how well they engineered a concrete solution around the constraint: praise locking in a specific timeline/next step, or securing a deposit and proactive logistics before the constraint window; and if they let it end on a vague "we'll call you," coach them on the specific commitment or timeline they could have proposed to keep momentum. It's not about the close — it's about finding out what the client truly needs and engineering a solution they feel good enough about to move forward and refer their friends and family, even if they can't sign or pay in the room that day. This is diagnostic discovery-skills coaching that teaches the principle behind every correction, not just a list of what was missing.`;

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

${SPEAKER_ATTRIBUTION_RULES}

${TRANSCRIPT_FIDELITY_RULES}

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
  // Graceful RELEASE phrasing, which the "best fit" patterns above miss because
  // it inverts the word order ("go find what fits you best") or never names fit
  // at all. Without these the worked-example release never triggered the
  // end-and-score checkpoint, so the session just stayed open.
  /\b(?:fits?|works?) (?:for )?you (?:best|better)\b/,
  /\b(?:might |may |probably )?not (?:be able to|going to be able to) (?:give|get|find) you\b/,
  /\b(?:go|you should) (?:go )?find (?:what|something|someone|somebody)\b/,
  // The same release said by naming the replacement rather than leaving it
  // indefinite. "I think you should find another car dealer" was the clearest
  // exit in the reported session and it matched nothing above, so the
  // end-and-score checkpoint never fired and the customer carried on asking
  // about car seats. Telling someone to find ANOTHER one of you is a dismissal
  // whatever noun follows, so the noun is not enumerated; the exclusions are
  // there because "let's find another way" and "we can find a different option"
  // are the opposite of a release -- they keep the rep in the conversation.
  /\bfind (?:another|a different|some other) (?!way\b|time\b|approach\b|angle\b|option\b|solution\b)[a-z]/,
  /\bcome (?:see|back to) me\b/,
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

  const transcriptText = renderTranscriptForScoring(transcript);

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

  // Per-session facts about what the transcript contains, so TIMING_FEEDBACK_RULES
  // has something deterministic to apply instead of the model's recollection. It
  // sits AFTER the transcript, in the volatile tail, because it is unique per
  // session and must not disturb the cacheable prefix. The consulting rubric is
  // the only one that coaches topic timing, so leadership prompts are unchanged.
  const timingGrounding = isLeadership ? "" : buildTimingGroundingBlock(transcript);

  const raw = (
    await responder(
      [
        stablePrefix,
        `${transcriptHeaderForScoring(transcript)}\n${transcriptText}`,
        timingGrounding,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n"),
      cacheKeyForPrefix(stablePrefix)
    )
  ).trim();
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

  // Rule 8, enforced deterministically: if the consultant proposed a solution and
  // the customer said it works for them, the conversation has unambiguously
  // reached a terminal point. Deciding that from the transcript's own text means
  // the gate can never block scoring on the grounds that no solution was
  // presented while the customer is on record accepting one.
  if (hasCustomerAcceptedProposal(transcript)) return true;

  const transcriptText = renderTranscriptForScoring(transcript);

  // Stable instruction leads; the volatile transcript comes last so the
  // instruction prefix is cacheable across calls.
  const stablePrefix = `Read this discovery-training role-play transcript. Each turn is numbered and labeled with the speaker who said it; that label is authoritative, so only count something as done by the consultant if it appears on a CONSULTANT turn. Has the consultant reached a terminal point — that is, (a) proposed ANY recommendation, solution, product/option, or next step/close to the customer, even a tentative or partial one, OR (b) after a genuine discovery effort, gracefully referred the customer elsewhere because they aren't the right fit, OR (c) proposed something the customer then agreed works for them, which is a completed outcome regardless of whether any close, signature, paperwork, or payment was discussed? Answer with ONLY the single word "yes" or "no".`;

  const response = await client.responses.create({
    model: CHAT_MODEL,
    input: `${stablePrefix}\n\n${transcriptHeaderForScoring(transcript)}\n${transcriptText}`,
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
