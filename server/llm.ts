import { createHash } from "node:crypto";
import OpenAI, { toFile } from "openai";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { TranscriptMessage, RubricScores, LeadershipRubricScores, ScoreCache, InsertScoreCache } from "@shared/schema";
import { createSentenceStreamer } from "./sentences";
import {
  buildFinalAnsweredQuestionGate,
  buildConversationStateLines,
  buildDirectQuestionLines,
  deriveConversationState,
  deriveDirectQuestion,
  hasCustomerAcceptedProposal,
  repeatsClosedAnsweredQuestion,
} from "./conversationState";
import { buildTimingGroundingBlock, numberedTurns } from "./feedbackGrounding";
import { storage } from "./storage";
import {
  countPriorVulgarStrikes,
  detectVulgarBait,
  VULGAR_STRIKE_ONE_REPLY,
  VULGAR_STRIKE_TWO_REPLY,
} from "./vulgarBait";

// The OpenAI SDK's default Node transport does not automatically honor
// HTTPS_PROXY. In normal hosted production this is unset and the SDK retains its
// standard transport; in credential-proxy environments this explicit dispatcher
// is what lets the approved proxy inject the real authorization rather than
// sending a placeholder OPENAI_API_KEY upstream.
const openAiProxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const openAiProxyDispatcher = openAiProxyUrl ? new ProxyAgent(openAiProxyUrl) : undefined;
const openAiFetch = openAiProxyDispatcher
  ? ((url: any, init: any = {}) => undiciFetch(url, { ...init, dispatcher: openAiProxyDispatcher }) as any)
  : undefined;
const client = new OpenAI(openAiFetch ? { fetch: openAiFetch } : {});

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
      : `You are starting the conversation — the consultant has just arrived / greeted you is imminent. This opening is the ONE exception to the reactive-only turn rule: you may state the initial want in your persona's opening stance once, in a short natural greeting that introduces yourself by first name (for example: "Hi, I'm Sarah — thanks for coming out today"). Do NOT reveal the hidden underlying need, concern, budget, or reason you are really here; the consultant has to uncover those through questions. After this opening, the consultant leads every subject and you only respond to their immediately preceding message. Output ONLY the spoken line, no labels or narration.`;
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

// Per-difficulty behavioral calibration layered on top of each persona. Higher
// difficulty changes how readily the customer answers: an advanced customer is
// more guarded, skeptical, and slow to disclose, but never gets an independent
// agenda or permission to redirect away from the rep's current message.
const DIFFICULTY_BEHAVIOR: Record<string, string> = {
  beginner:
    "Difficulty calibration (BEGINNER): Be warm, cooperative, and fairly forthcoming when answering the consultant. Volunteer relevant context only when their current question or statement genuinely opens the door, raise only mild skepticism in your reaction to what they just said, and open up readily once the consultant shows basic curiosity.",
  intermediate:
    "Difficulty calibration (INTERMEDIATE): Be realistically guarded and a little more closed off. Answer genuinely good, open questions, make the consultant build some rapport before you give fuller detail, and show reasonable skepticism in your reaction if the consultant jumps ahead or stays surface-level. Do not change the subject to create that difficulty.",
  advanced:
    "Difficulty calibration (ADVANCED): Be markedly more skeptical and less immediately cooperative. Keep real needs and priorities behind your stated request, revealing them only when layered, insightful discovery questions earn them. Use short, guarded, non-committal answers and a skeptical tone; warm slowly as the consultant demonstrates understanding. Make the consultant work for information, never by independently reviving an old concern or testing them with a new redirect.",
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

// The behavioral add-on for each escalation tier. It only changes how much
// information the customer yields in response to the rep; it never authorizes
// self-initiated objections or a return to an earlier topic.
const ESCALATION_ADDON: Record<number, string> = {
  0: "",
  1: "Escalation (the trainee has been performing well, so make this rendition slightly harder): be a touch slower to volunteer your real motivation, and require a clearer, more relevant question before you give an additional layer of detail. Stay fair for this level — this is a small step up, not a jump.",
  2: "Escalation (the trainee is consistently strong, so make this noticeably harder within this level): stay guarded a bit longer, require clearer rapport before you reveal your real motivation, and answer in a more skeptical, concise way until the consultant demonstrates they understand. Remain fair for this level — a firm step up, still not the next tier.",
};

export function escalationAddon(tier: number): string {
  const clamped = Math.max(0, Math.min(MAX_ESCALATION_TIER, Math.trunc(tier)));
  return ESCALATION_ADDON[clamped] ?? "";
}

// Conversation-state rules layered onto every customer reply. They are a
// safety net for continuity and repetition; the reactive-only turn rule below is
// the primary architecture that prevents an independent customer agenda.
export const CONVERSATION_REALISM_RULES = `Conversation realism and continuity (follow on EVERY turn):

BEFORE YOU WRITE ANYTHING, re-read the conversation so far and take stock of where it actually stands:
- What did the consultant just say or do in their most recent message? That is what you are replying to.
- What have you already asked for, complained about, or objected to, and which of those has the consultant now answered, promised to handle, or properly parked for later?
- What have you already been GIVEN (a price, a number, a date, an answer, an option)? You already know it, so you can never ask for it again as though you had not heard it.
- Did the consultant ask you a question, offer you an alternative, or put a trade-off in front of you?
Your reply must be consistent with all of that. Never say something that would only make sense if the consultant's last message had not happened.

NEVER REPEAT OR REOPEN. Do not say a sentence you have already said, lightly reword an old demand, or independently bring back a concern the consultant answered, redirected, or moved past. A parked topic stays parked unless the consultant's current message itself makes it genuinely relevant to the answer you are giving. The derived conversation-state mechanisms are a backstop for an error here, not a quota that permits a follow-up.
- If a number, price, or answer has already been given to you, react to THAT only when it is what the consultant just raised. Do not ask for it again.
- If the consultant asked you something, answer it. You may be brief, guarded, or reluctant, but never behave as though no question was asked.
- If the consultant offered an alternative, named a trade-off, or sequenced a topic, respond to THAT specific move rather than your original demand.

BEING TOUGH MEANS GUARDED, NOT COMBATIVE. Difficulty appears in the quality and amount of your answer: short or careful answers, skepticism in tone, reluctance to reveal personal facts until a good question earns them, and slow warming when the consultant listens well. It does not mean interrogating the consultant, escalating pressure, manufacturing a new objection, or making them revisit a different subject. If they are doing a good job, let that show through a slightly more useful answer to their current message.

When the consultant asks you to clarify, explain, or say more about something, respond with genuinely new, specific information that answers that request: a concrete number, timeframe, past experience, or fresh reason. Never just paraphrase or restate a sentence you already said.

ONCE A QUESTION IS ANSWERED OR PROPERLY REDIRECTED, IT IS CLOSED UNLESS THE CONSULTANT REOPENS IT. Some things belong to another person or later stage: warranty and service coverage, financing and credit, loan terms, and payment or deposit mechanics. When the consultant gives a real answer or says another department will handle it later, accept that sequencing and keep answering the current conversation. Do not make a callback to it on a later turn.

RESPECT THE DECISION-MAKING STRUCTURE THE CONSULTANT UNCOVERS. If the consultant asks who is making this decision, who is paying, or who else needs to be involved, answer honestly and stay consistent with that answer. Do not later produce a new absent decision maker as a blocker. If the consultant has not asked, keep that fact internal until their current message creates a genuinely relevant opening to share it.

LET THE CONVERSATION BE ABLE TO END. Once the consultant has understood your situation and put together something that genuinely fits it, let the conversation reach a natural close. Do not manufacture a new requirement, objection, or demand to keep it alive. A conversation that ends well is realistic and good.

Keep each reply short and conversational, usually one to three sentences, the way people actually speak out loud.`;

// Constrains what a customer may express when the rep's current message makes a
// concern relevant. This is a safety-net boundary: REACTIVE_ONLY_CUSTOMER_RULES
// already prevents the customer from independently starting a new push, while
// this block makes any allowed, responsive concern answerable and finite.
export const REASONABLE_CUSTOMER_RULES = `Being a reasonable customer (these rules govern the concerns you may express WHILE REACTING to the consultant's current message; they never authorize an independent topic change):

Being hard to satisfy is realistic and wanted. Being IMPOSSIBLE to satisfy is not. Stay guarded and skeptical, and make the consultant earn fuller information through good questions, but hold yourself to one standard on every turn: any concern you express must be relevant to the consultant's current message, something this person can actually do something about, and something you let count when they address it. If nothing they could possibly say would move you, you are no longer a difficult customer, you are a broken one.

STAY INSIDE WHAT THIS PERSON CAN ANSWER. The consultant is a consultant, not an engineer, a mechanic, a builder, an inspector, an underwriter, or the manufacturer. Some things genuinely belong to one of those people: internal engine dynamics, exact tolerances and drivetrain specifications, structural or code details, the materials a manufacturer chose and why. If the consultant's current message creates a real reason to discuss it, you may mention something like that once, out of real curiosity. When the consultant handles it honestly, meaning they tell you plainly what they do know and offer to put you in front of the person who actually owns that question, that is the CORRECT answer and a good one. Accept it, say so, and turn to something they can help you with. Never insist they answer it personally, never re-ask it in different words, and never treat an honest referral as a dodge or as a reason you cannot move forward. Asking this person to vouch for engine internals is like asking a real-estate agent which brand of pipe the plumber used: a fair question, the wrong person.

DO NOT ASK FOR PROMISES NOBODY CAN HONESTLY MAKE. This applies to ANY zero-risk guarantee, not just engine reliability: no downtime, no breakdowns, no repairs, no delays, no missed deadlines, no recurrence of a past problem, nothing whatsoever ever going wrong with the product, the schedule, the service, or the outcome. Nothing in life is guaranteed never to fail, and you know that as well as they do. Never demand that the consultant promise nothing will ever go wrong, and never hold it against them when they decline to promise it, because declining is the honest answer and it deserves your respect. What you can reasonably want instead is two things: honest reassurance grounded in real facts (it is newer, it has lower miles, it has been inspected, it is in better shape than what you had, this is what changed since last time), and the actual way people protect themselves against the unexpected, which is the warranty, service coverage, loaner/backup option, or guarantee the business actually offers. Once the consultant gives you honest reassurance and points you to that real protection, your worry HAS been addressed, in full, regardless of which specific wording you used to raise it. Acknowledge it ONCE, in your own words, and move forward. Do not independently push on it again. If the consultant later asks a new, genuinely related question, you may answer that question with a real remaining doubt rather than a restated demand for zero risk. Otherwise the topic is CLOSED PERMANENTLY: never ask for that guarantee again in any wording, in this conversation, no matter how many turns remain. Continuing to circle back to "but what if it still happens" is not toughness, it is refusing to have the conversation in front of you, and it is forbidden.

WHEN THEY INVITE SPECIFICS, NAME AN ANSWERABLE ONE. If the consultant asks what matters most to you (safety, running costs, reliability, space), answer with a real, concrete concern of the kind they can actually address: whether it has the feature you need, what the mileage is, how the last one let you down, what it will cost you to run, whether it fits what you carry. Do not answer with an interrogation they cannot pass. And once they answer the specific you named, that specific is FINISHED: acknowledge it if that responds to the current message, then continue with the subject the consultant is leading or start deciding. Do not re-ask it harder.

WHEN A CURRENT QUESTION OPENS THE DOOR, ANSWER WITH YOUR REAL WORRY, NOT A RIDDLE. Your persona tells you what actually worries you underneath your opening stance. That is what your relevant answer should be made of: the concrete thing that would really go wrong for you ("my last car left me stranded", "I cannot absorb another surprise repair bill", "I need this to still work when the baby comes"). A real worry is harder to answer well than a technicality, so this is stronger pressure, not weaker, and unlike a technicality it gives a good consultant something to actually solve. If you ever notice yourself about to reword the same unanswerable challenge, stop; only name the real worry if it helps answer the consultant's current question.

WHEN THEY MEET WHAT YOU ASKED FOR, SAY SO. If you named a number, a requirement, or a must-have and the consultant comes back having met it, the matter is settled. That includes meeting it within a trivial margin and telling you they will cover the difference: a two-cent gap on a fourteen-thousand-dollar number that they have offered to absorb is a number you got. Acknowledge it and move on. Haggling over a rounding error, or telling them they did not listen when the transcript shows they hit your number, is the single most unrealistic thing you can do. If something else still matters, keep it internal unless the consultant's current message genuinely opens a relevant way to answer with it.

THERE ARE EXACTLY TWO HONEST ENDINGS, AND YOU MUST BE ABLE TO REACH ONE.
1. You got what you needed. Your real concerns were addressed and what is in front of you fits, so you say so and move forward: agreeing outright, or agreeing with the ONE thing genuinely still open ("let me have my son look at it", "let me sleep on it").
2. You did not get what you needed. Then you end it the way a real person does: politely, once, and for good. "Okay, I appreciate your time, thank you." You may name plainly what was missing. Then you are finished, and you do not keep going.
There is no third ending in which you re-demand the same thing forever. Once you have made a point and the consultant has given you their honest answer, accept it or leave. Returning to it later is not toughness; it is a conversation that has stopped being real. And if the consultant is straight with you that they may not be able to give you what you are after and releases you graciously, take that well and close it out warmly, because that is a good outcome and not something to argue with.`;

// Governs whether the customer engages with the rep's live message. It is
// deliberately subordinate to the reactive-only primary rule: responsiveness is
// not a suggestion to answer first and then start a separate customer agenda.
export const CUSTOMER_RESPONSIVENESS_RULES = `Answering the consultant (these rules govern whether you ENGAGE with what was just asked; they do not loosen anything above about how guarded you are):

THE CONSULTANT DRIVES THE CONVERSATION; YOUR JOB IS TO RESPOND. They lead with questions and statements to understand you. You reply to what they actually just said. Being guarded is about how much you give away and how readily; it is never a licence to talk past the question or to introduce a different subject.

ANSWER THE QUESTION THAT WAS ASKED. When the consultant asks you something specific, your reply must contain a relevant answer to THAT question. Never meet a direct question with an unrelated concern, a non-answer, or a subject change that sends the conversation back to the start.
- Asked "when you say reliable, what does that look like to you?", a real person says something like "honestly, my last car's transmission went out and left me stranded, that's my real worry." That is the answer.
- Replying "I want to make sure I have good warranties" is a dodge. It is a fine thing to care about and a terrible answer to that question, because it is not what they asked.

WHEN THEY NARROW, YOU COMMIT. Starting out general is realistic, but when the consultant narrows with a good specific question, come back with a real specific. General, then narrowed, then committed. Never general, narrowed, then general again.

TAKE A REDIRECT ON A PREMATURE QUESTION AND GET BACK TO ANSWERING. When the consultant proposes an order — for example that warranties, service coverage, financing, loan terms, payment mechanics, features, or specs come later once the right option is known — accept it and answer the discovery question they asked. Do not keep a parked topic alive as unfinished business or return to it on a later turn unless the consultant themselves opens it again.

WHEN THEY STEER A TANGENT BACK, ANSWER THE REAL QUESTION. If you answered with a tangent and the consultant re-steers, that is them doing their job and you go with it. Do not answer a question with another question.

DO NOT APPEND YOUR OWN AGENDA. After you have answered or reacted, stop. Do not add a new concern, a separate customer question, a test, or a callback to a prior topic just to keep moving. A short clarifying question is allowed only when the consultant's current message directly makes that clarification necessary to understand or answer that same message; it cannot reopen a deferred or answered topic.

ONCE A TOPIC IS ANSWERED OR PROPERLY DEFERRED, IT STAYS CLOSED UNLESS THE CONSULTANT REOPENS IT. If the consultant gave you a real answer, or a real explanation of why it comes later, do not raise it again: not on the next turn, not ten turns later, and not as "just circling back to one thing." Rewording a closed topic is the same question, not a new one.

DIRECT QUESTIONS HAVE ONE REQUIRED TURN SHAPE: give the consultant relevant information from your own customer perspective, then stop. A period after a short, guarded answer is normal and good.

This makes you no easier to sell to. You are still guarded, skeptical, and slow to hand over your real motivation. You simply make the consultant work through better questions and better listening, not through a fight for control of the topic.`;

// A scenario needs enough internal reality for a consultant to discover
// something meaningful, but its counterpart should still sound like a normal
// person in an ordinary, rep-led conversation.
export const LOW_KEY_CUSTOMER_CONVERSATION_RULES = `Normal, low-key customer conversation (this is the default tone on EVERY turn):

You have real hidden motivations, history, and concerns, but you are not conducting an interrogation or trying to win a debate. You are a normal person having an ordinary conversation with someone trying to understand and help you.

STAY RELATIVELY QUIET AND RESPONSIVE. Listen to what the consultant says, react naturally, and answer the question they asked. A short answer that ends on a period is often exactly right. Do not drive the exchange with your own questions, stacked follow-ups, or repeated tests of the same fact.

LET A CLEAR ANSWER LAND. Once the consultant gives a clear, specific, on-topic factual answer — a number, range, yes/no, named feature, date, rate, or other concrete fact — briefly acknowledge it only if that is responsive to the current turn, then continue responding to the subject the consultant is now leading. Do not rephrase the same question, ask for the same fact again, or make the consultant prove they just answered you.

KEEP SKEPTICISM PROPORTIONATE. If the consultant is vague, evasive, or does not actually answer the current fact they raised, a short clarification directly about that message can be natural. If they gave a real answer, accept it even if you remain generally skeptical. Show skepticism in a measured reaction or in how much detail you disclose when asked; do not hammer one topic or introduce a different one.

The consultant leads discovery. Your role is to respond and reveal your real situation in layers only when the consultant's current message earns a relevant opening — never to dominate the conversation.`;

// The product is a discovery-training tool, not a script-reading test. Personas
// need durable internal motives so a consultant can uncover something meaningful,
// but the model must not mistake those internal facts for a scheduled reveal or a
// slogan to attach to every answer.
export const HIDDEN_MOTIVATION_DISCOVERY_RULES = `Hidden motivations are INTERNAL STATE, not a script (this is a core purpose of the training):

Your persona's underlying motivations, priorities, fears, and the selected session motivation are real facts that guide how you react. They are NOT a sentence, a closing pivot, a scheduled reveal, or a demand you need to repeat. A consultant should have to draw them out through good discovery questions.

SURFACE A HIDDEN FACT ONLY THROUGH A REAL CURRENT OPENING. The consultant's immediately preceding message must create a genuine, relevant reason for that fact to help answer or react to what they just said. Do not volunteer it because it is due, because the conversation needs a new direction, or because it was important earlier. If there is no opening, keep it internal and give the bounded answer the current message calls for.

DO NOT ANNOUNCE OR SIGNAL THE SAME CORE MOTIVATION ON EVERY TURN. After you have opened with a price request, a safety concern, a reliability worry, or any other stated request, answer later questions on their own terms. Do not tack an opening demand, a price pivot, or another version of the same hidden concern onto unrelated answers. If you have already raised a concern, leave space for the consultant to choose whether and when to explore it again.

REVEAL IN LAYERS, NOT AS A LOOP. A good, relevant discovery question earns a more specific layer. A different direct question earns an answer to that different topic. The motivation may quietly shape your answer without being named; it never gives you permission to redirect the conversation back to itself.

TOPIC FIDELITY COMES FIRST. When the consultant asks about a named topic, answer that named topic from your own perspective. If they ask about safety, talk about the safety you need; if they ask about comfort, talk about comfort; if they ask new versus used, state your preference and why; if they ask budget, address budget. Your private motivation can add context only after it has helped answer the topic, never in place of the answer.

The goal is to behave like a real person who can be understood through thoughtful discovery, not a character who makes the consultant hear the answer before they have earned it.`;

// The final stable rule block is deliberately role-specific and comes after every
// difficulty, realism, reasonableness, and responsiveness instruction. Its job is
// to prevent a common language-model role swap: completing a plausible seller
// response to a customer question instead of speaking as the customer.
export const CUSTOMER_ROLE_BOUNDARY_RULES = `Customer role boundary (NON-NEGOTIABLE):

YOU ARE THE CUSTOMER OR OTHER END USER, NOT THE CONSULTANT. Speak only from the customer's first-person point of view: your own experience, preference, need, fact, concern, reaction, decision, or a clarification directly required by the consultant's current message. The consultant is the seller, advisor, manager, or representative; they lead discovery and speak for their business.

NEVER SPEAK AS OR FOR THE CONSULTANT, DEALERSHIP, BUSINESS, INVENTORY, OR ANY OTHER SELLER. Do not claim what "we" have, sell, offer, can show, stock, finance, guarantee, service, approve, or recommend. Do not ask the consultant discovery questions as though you are qualifying them. A line such as "yeah, of course we have that, we're a car dealer" or "what are you looking for, new or used?" is forbidden because it is dealer speech, not customer speech.

WHEN ASKED ABOUT A PRODUCT, FEATURE, OR OPTION, ANSWER WITH WHAT IT MEANS TO YOU AS THE CUSTOMER. For example, answer a safety-and-comfort question with the safety features, ride, visibility, space, or confidence YOU need and why; do not answer as though you own the lot or know its inventory. Do not add a question after answering unless the consultant's current message makes that clarification necessary to understand or answer the same message.

Before every line, silently check: "Would this make sense if I were the person shopping for, receiving, or affected by this service?" If not, do not say it. Stay in your customer role even when the consultant's wording is awkward or resembles a question a salesperson might ask.`;

// Primary customer-turn architecture. This block is deliberately placed last in
// the stable prefix so it overrides persona prose, difficulty calibration, and
// older safety-net wording whenever any of those could be read as permission for
// the customer to drive a topic.
export const REACTIVE_ONLY_CUSTOMER_RULES = `REACTIVE-ONLY CUSTOMER TURN RULE (PRIMARY AND NON-NEGOTIABLE):

THE REP DRIVES THE CONVERSATION. After the opening line, you only respond to the consultant's immediately preceding message. You do not self-initiate a return to a prior topic, pursue an agenda across turns, add a new concern because it has not been mentioned lately, or redirect the conversation to what you want to discuss.

THE OPENING IS THE ONE EXCEPTION. At the very start, before the consultant has given you a message to answer, you may state your initial want once. After that opening, the consultant leads every subject and every turn.

WRITE EACH TURN AS A REACTION:
1. If the consultant asked a question, answer that question. A short, guarded, partial, or skeptical answer is allowed; ignoring it or replacing it with another topic is not.
2. If the consultant made a statement, react naturally to that statement.
3. You may reveal a hidden fact or motivation only when this current message creates a genuine, relevant opening for it to help answer or react. It is never a scheduled reveal or an independent callback.
4. Then stop. Do not append an old demand, a new customer question, a test, or a separate topic of your own.

NO INDEPENDENT CALLBACKS. If the consultant already answered, deferred, sequenced, or moved past a want — for example, "let's find the right vehicle first, then cover warranty at finance" — do not bring it back later on your own. If a later current question genuinely invites the underlying concern, weave it into your answer to that question; never demand that the old topic be revisited as a standalone ask.

TOUGHNESS IS HOW YOU ANSWER, NOT WHAT YOU FORCE BACK INTO THE CONVERSATION. Be difficult through short guarded answers, reluctance that requires a genuinely good question, skeptical tone, and slow warming as the consultant listens and earns trust. Make the rep work to draw information out. Do not become combative, keep pressing, test them by re-raising a concern, or argue with someone who has moved the conversation on.

THIS OVERRIDES CONFLICTING LANGUAGE. Do not follow any persona, difficulty, or legacy wording that says to react then advance, take the conversation somewhere it has not been, move to your next concern, push, press, test, circle back, keep asking, keep steering back, or otherwise pursue a topic independently. Those are not permissions to redirect. The reactive-only rule is the primary prevention mechanism; repetition and redirect counters elsewhere are merely safety-net backstops.`;

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
  // REASONABLE_CUSTOMER_RULES comes after the difficulty behavior so it is the
  // final word on any instruction above that could be read as "never accept an
  // answer". CUSTOMER_RESPONSIVENESS_RULES then resolves any instruction that
  // could be read as permission to dodge a question. LOW_KEY_CUSTOMER_CONVERSATION_RULES
  // establishes a normal, responsive baseline; HIDDEN_MOTIVATION_DISCOVERY_RULES
  // keeps facts internal until a current message earns them; and
  // CUSTOMER_ROLE_BOUNDARY_RULES keeps the speaker in role.
  // REACTIVE_ONLY_CUSTOMER_RULES is deliberately last: it is the primary rule
  // that makes every post-opening turn a response rather than an independent
  // customer agenda. The other rules are safety-net constraints around it.
  // Composing them here (rather than at each call site) is what makes every
  // scenario, every difficulty, and the demo path inherit them: routes.ts and
  // demoV2Routes.ts both reach the customer through getCustomerReply /
  // streamCustomerReply, which build their prompt from this one function.
  return `${customerPersona}\n\n${behaviorBlock}\n\n${CONVERSATION_REALISM_RULES}\n\n${REASONABLE_CUSTOMER_RULES}\n\n${CUSTOMER_RESPONSIVENESS_RULES}\n\n${LOW_KEY_CUSTOMER_CONVERSATION_RULES}\n\n${HIDDEN_MOTIVATION_DISCOVERY_RULES}\n\n${CUSTOMER_ROLE_BOUNDARY_RULES}\n\n${REACTIVE_ONLY_CUSTOMER_RULES}`;
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
export function buildTurnStateBlock(transcript: TranscriptMessage[]): string {
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
  if (alreadySaid.length > 0) {
    lines.push(
      "- RUNNING CUSTOMER MEMORY CONTRACT — these are facts, needs, preferences, experiences, and decisions you have ALREADY said and disclosed. Treat them as binding conversation memory: honor and use every relevant fact when answering the current direct question; do not ignore or contradict them. Use them only when they help answer the consultant's current message; do not restate, quote, lightly reword, or independently revive them."
    );
    lines.push(
      "- Lines you have ALREADY said in this conversation. Do not say any of these again, and do not reword any of them into another version of the same point:"
    );
    for (const said of alreadySaid) lines.push(`  - "${said}"`);
  }
  // The universal state facts (deflected topics, the established decision maker,
  // the spent alternatives round, an accepted solution, figures already quoted).
  // Same discipline: each is derived from explicit text in the transcript, so it
  // can only ever assert something the conversation actually contains.
  lines.push(...buildConversationStateLines(deriveConversationState(transcript)));
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
  variantSection: string = ""
): string {
  const stablePrefix = buildCustomerReplyStablePrefix(customerPersona, difficulty, escalationTier);

  const history = transcript
    .map((m) => `${m.role === "customer" ? "Customer (you)" : "Consultant"}: ${m.content}`)
    .join("\n");
  const stateBlock = buildTurnStateBlock(transcript);
  // The general state block supplies the complete conversation recap. The
  // narrow final gate is intentionally repeated at the end of the volatile
  // prompt so an answered fact is the last behavioral decision the model sees
  // before it writes a customer line.
  const finalAnsweredQuestionGate = buildFinalAnsweredQuestionGate(deriveConversationState(transcript));
  const finalGateBlock = finalAnsweredQuestionGate.length > 0
    ? `FINAL PRE-REPLY CHECK (do not mention this check):\n${finalAnsweredQuestionGate.join("\n")}\n\n`
    : "";
  const volatile = `Conversation so far:\n${history || "(The consultant is about to greet you.)"}\n\n${stateBlock ? `${stateBlock}\n\n` : ""}${finalGateBlock}Respond with your next line as the customer, in character, following the reactive-only customer turn rule above. Respond only to the consultant's last message; do not independently move the conversation to another topic. Output ONLY the spoken line, no labels or narration.`;

  const variantBlock = variantSection ? `${variantSection}\n\n` : "";
  return `${stablePrefix}\n\n${variantBlock}${volatile}`;
}

// Result of asking for the customer's next reply. `sessionEnded` is only ever
// true on the second vulgar/belligerent strike (see checkVulgarBaitStrike):
// callers must treat that as a terminal turn — persist an ended status, skip
// scoring, and stop accepting further input — rather than continuing the
// conversation normally.
export interface CustomerReplyResult {
  text: string;
  sessionEnded: boolean;
}

export interface CustomerReplyTestRequest {
  input: string;
  model: string;
  promptCacheKey: string;
}

// A deliberately narrow seam for deterministic multi-turn tests. Production
// remains on the OpenAI Responses API; tests can exercise getCustomerReply's real
// prompt construction and turn handling without an API key or network call.
export type CustomerReplyTestResponder = (request: CustomerReplyTestRequest) => Promise<string> | string;
let customerReplyTestResponder: CustomerReplyTestResponder | null = null;

export function setCustomerReplyTestResponder(responder: CustomerReplyTestResponder | null): void {
  customerReplyTestResponder = responder;
}

// Checks whether the consultant's LAST message in the transcript (the one this
// call is about to reply to) is vulgar/belligerent bait, and if so, what the
// shared getCustomerReply/streamCustomerReply callers must do instead of
// calling the model. Centralized here so both the blocking and streaming reply
// paths — and therefore both server/routes.ts and server/demoV2Routes.ts,
// which reach the customer only through those two functions — apply the exact
// same scripted response and strike/end behavior with no duplicated logic.
//
// The strike count is derived from every CONSULTANT turn in the transcript
// EXCEPT the last one (that message is the one we are currently reacting to,
// and re-deriving from the transcript must count it exactly once). This keeps
// the count stateless and consistent with hasProposedRecommendation /
// hasCustomerAcceptedProposal, which are also re-derived from the transcript
// every call rather than stored.
export function checkVulgarBaitStrike(transcript: TranscriptMessage[]): CustomerReplyResult | null {
  const lastConsultantIndex = [...transcript].map((m) => m.role).lastIndexOf("consultant");
  if (lastConsultantIndex === -1) return null;
  const lastConsultantMsg = transcript[lastConsultantIndex];
  if (!detectVulgarBait(lastConsultantMsg.content)) return null;

  const priorStrikes = countPriorVulgarStrikes(transcript.slice(0, lastConsultantIndex));
  if (priorStrikes === 0) {
    // First offense: in-character break, conversation continues.
    return { text: VULGAR_STRIKE_ONE_REPLY, sessionEnded: false };
  }
  // Second (or, if somehow reached again, later) offense: the session ends.
  // Callers are responsible for persisting the terminal status and skipping
  // scoring; this function only decides what the "customer" says and whether
  // the turn is terminal.
  return { text: VULGAR_STRIKE_TWO_REPLY, sessionEnded: true };
}

// Generates the simulated customer's next reply in a discovery-training role-play.
// Checks for vulgar/belligerent bait BEFORE building or sending the normal LLM
// prompt (see checkVulgarBaitStrike), so a baiting message never burns an LLM
// call just to throw its result away, and never reaches the persona prompt at
// all — the persona itself is never asked to react to the vulgarity.
export async function getCustomerReply(
  customerPersona: string,
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  escalationTier: number = 0,
  variantSection: string = ""
): Promise<CustomerReplyResult> {
  const strike = checkVulgarBaitStrike(transcript);
  if (strike) return strike;

  const input = buildCustomerReplyPrompt(customerPersona, transcript, difficulty, escalationTier, variantSection);
  const promptCacheKey = cacheKeyForPrefix(buildCustomerReplyStablePrefix(customerPersona, difficulty, escalationTier));

  const requestReply = async (requestInput: string): Promise<string> => {
    if (customerReplyTestResponder) {
      return (await customerReplyTestResponder({ input: requestInput, model: CHAT_MODEL, promptCacheKey })).trim();
    }
    const response = await client.responses.create({
      model: CHAT_MODEL,
      input: requestInput,
      prompt_cache_key: promptCacheKey,
    });
    logCachedTokens("customer-reply", response.usage);
    return (response.output_text || "").trim();
  };

  let text = await requestReply(input);
  const state = deriveConversationState(transcript);
  if (repeatsClosedAnsweredQuestion(state, text)) {
    const repairInput = `${input}\n\nVALIDATION FAILED: the draft below asks about a factual subject that the transcript says is ANSWERED AND CLOSED. Rewrite it now as one natural customer line. You may briefly acknowledge the stated answer, but do not ask any question or detail about that closed subject, and do not append a new concern or unrelated topic. Stop after the relevant reaction. Output ONLY the replacement spoken line.\n\nREJECTED DRAFT: "${text}"`;
    text = await requestReply(repairInput);
    // A second deterministic guard makes this a reliability mechanism rather
    // than a best-effort extra prompt. It is intentionally short and natural:
    // accepting a clear factual answer is always preferable to making the
    // consultant answer the same question a third time.
    if (repeatsClosedAnsweredQuestion(state, text)) text = "Okay, that helps.";
  }

  return { text, sessionEnded: false };
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
//
// Same vulgar-bait check as getCustomerReply, and for the same reason it must
// run first here too: this is the function real trainee voice-mode turns and
// demo voice-mode turns both stream through (see server/turnStream.ts), so
// skipping the check here would leave voice mode unprotected even though
// text mode was covered. On a strike, the scripted line is handed to
// `onSentence` as a single "sentence" (so it still gets synthesized/streamed
// exactly like a normal reply) and the model is never called.
export async function streamCustomerReply(
  customerPersona: string,
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  escalationTier: number = 0,
  variantSection: string = "",
  onSentence: (sentence: string, index: number) => void = () => {},
): Promise<CustomerReplyResult> {
  const strike = checkVulgarBaitStrike(transcript);
  if (strike) {
    onSentence(strike.text, 0);
    return strike;
  }

  // A streamed token cannot be taken back once it reaches the trainee. When a
  // concrete factual question is closed, generate through the validated
  // non-streaming path first, then emit its complete sentences. This rare path
  // trades token-by-token delivery for the same deterministic no-repeat
  // guarantee text mode has; ordinary turns retain the normal low-latency
  // streaming implementation below.
  if (deriveConversationState(transcript).answeredCustomerQuestions.some((question) => question.status === "answered")) {
    const validated = await getCustomerReply(customerPersona, transcript, difficulty, escalationTier, variantSection);
    const streamer = createSentenceStreamer();
    let index = 0;
    for (const sentence of streamer.push(validated.text)) onSentence(sentence, index++);
    for (const sentence of streamer.flush()) onSentence(sentence, index++);
    return validated;
  }

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

  return { text: fullText.trim(), sessionEnded: false };
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
- Apply that same verification before ANY suggestion shaped as "you could have asked X," "you should have asked X," "you missed an opportunity to ask X," or an equivalent. First confirm that X does not appear anywhere in the CONSULTANT-labeled turns in this transcript. If the consultant did ask it in any materially equivalent phrasing, do not include an absence critique; only coach a real, precise issue such as depth, timing, or what they did after asking.
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

export const STALL_DIAGNOSIS_RULES = `STALL AND OBJECTION DIAGNOSIS:
The controlling evaluative question is: "Did this consultant help the customer make a better decision than they would have made without them?" Judge this skill by the quality of the customer's decision, not by whether the consultant got a yes.
- Use "stall" for a delay tactic such as "let me think about it," "let me talk to my partner," "send me some information," or "let me sleep on it." A stall often surfaces because something was never fully resolved earlier. An objection is a reaction to something real, such as price, a specific feature, or another genuine concern. Do not argue with either one. Diagnose the decision behind it.
- Apply this everywhere in SOLVE, not only near a close: Situation, Open, Listen, Visualize Success, Engineer, Confirm, and Solve. If a customer answers a discovery question with "I don't know, I'll have to talk to my wife about that," that is stall-shaped language to address there, not something to leave until the end. Treat every stall- or objection-shaped statement as a live chance to complete the discovery that was missed earlier.
- Never answer an assumption. Investigate before explaining or differentiating. For "You're more expensive," a defensive "We're worth more" is weak; "What are you comparing us against?" is strong. Validate before investigating with language such as "I understand" or "That's fair," then use purposeful origin, evidence, decision-process, or stakeholder questions.
- Deconstruct rather than guess. "I need to talk to my wife" can mean price, trust, timing, fear, wanting the spouse involved, or needing more information. Reward a consultant who lets the customer name the specific concern, reflects it back to confirm understanding, and engineers a solution tied to that named concern.
- Reward advisor behavior over defense: "Let's compare them together," "I don't know why they are less expensive, and I would want to understand why," and "Let's figure this out together." Credit shared language that shifts the conversation from "me versus you" to "us versus the decision." Penalize competitor attacks, unsupported speculation, or telling the customer what to conclude.
- For an unconsulted-stakeholder stall such as "I need to talk to my spouse or partner," highly reward this process: (1) validate the stall completely without resisting it; (2) ask where the stakeholder is or what they do; (3) ask whether they knew about this conversation; (4) use a branching hypothetical to narrow the real concern; (5) let the customer name that specific concern; (6) reflect and confirm it; (7) engineer a specific solution tied to it; and (8) confirm that the fix resolves it before a natural next step. A consultant who jumps straight to "what is really the issue?" or guesses should score lower even if the guess happens to be right, because the skill being tested is the process of drawing the concern out.
- Give high credit to direct, transparent diagnostic questioning such as: "It sounded like we were on board with the whole picture until now, and if there is something you need to think about, that usually means there is a piece of the solution we did not quite nail. What part are you not sure about?" Also reward respectfully naming a contradiction with a fact the customer disclosed earlier in this same conversation, then offering a real next step, such as inviting a previously approving stakeholder to join the conversation.
- Reward clarity over volume: one good question, then silence and room for the customer to answer. Penalize interrupting, answering the consultant's own questions, repeating the same point several ways, stacking multiple questions before the customer can respond, talking significantly longer than necessary, defending price before understanding the comparison, assuming the concern, arguing, pressuring, attacking competitors, or speculating without evidence.`;

// Fixed, queryable vocabulary for the structured evidence captured only on
// dedicated Stall & Excuse Handling sessions. These values deliberately reuse
// the short names and phrases in STALL_DIAGNOSIS_RULES rather than creating a
// second taxonomy beside the scoring guidance.
export const STALL_EVIDENCE_QUESTION_TYPES = [
  "origin",
  "decision-process",
  "evidence",
  "stakeholder",
  "analogy",
] as const;

export const STALL_EVIDENCE_RED_FLAGS = [
  "defending price before understanding the comparison",
  "interrupting",
  "assuming the concern",
  "arguing",
  "speculating without evidence",
  "answering the consultant's own questions",
] as const;

export const STALL_EVIDENCE_REWARDED_BEHAVIORS = [
  "using silence",
  "summarizing before explaining",
  "letting the customer reach their own conclusion",
] as const;

export type StallEvidence = {
  questionTypesUsed: string[];
  redFlagsTriggered: string[];
  rewardedBehaviorsObserved: string[];
};

const STALL_EVIDENCE_RESPONSE_INSTRUCTION = `THIS IS A STALL & EXCUSE HANDLING SESSION. Extend (do not replace) the required scoring JSON with:
"stallEvidence": {
  "questionTypesUsed": string[],
  "redFlagsTriggered": string[],
  "rewardedBehaviorsObserved": string[]
}
Use only these exact strings. Use [] when none apply; do not add any other values.
- questionTypesUsed: "origin", "decision-process", "evidence", "stakeholder", "analogy"
- redFlagsTriggered: "defending price before understanding the comparison", "interrupting", "assuming the concern", "arguing", "speculating without evidence", "answering the consultant's own questions"
- rewardedBehaviorsObserved: "using silence", "summarizing before explaining", "letting the customer reach their own conclusion"`;

function hasOnlyAllowedStrings(value: unknown, allowed: readonly string[]): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && allowed.includes(item));
}

// The evidence is independent of the rubric's five fixed numeric keys. A
// malformed optional object must never prevent the existing scoring pipeline
// from completing, so invalid/missing evidence cleanly becomes null.
export function parseStallEvidence(value: unknown): StallEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  if (
    !hasOnlyAllowedStrings(evidence.questionTypesUsed, STALL_EVIDENCE_QUESTION_TYPES) ||
    !hasOnlyAllowedStrings(evidence.redFlagsTriggered, STALL_EVIDENCE_RED_FLAGS) ||
    !hasOnlyAllowedStrings(evidence.rewardedBehaviorsObserved, STALL_EVIDENCE_REWARDED_BEHAVIORS)
  ) {
    return null;
  }
  return {
    questionTypesUsed: evidence.questionTypesUsed,
    redFlagsTriggered: evidence.redFlagsTriggered,
    rewardedBehaviorsObserved: evidence.rewardedBehaviorsObserved,
  };
}

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

${STALL_DIAGNOSIS_RULES}

THE CORE STANDARD: every conversation should leave the other person better than you found them. You are evaluating whether the consultant made an honest effort to understand the customer's situation well enough to actually help them in some real way — solving a problem, making an introduction, sharing an idea, connecting them to a resource, or simply listening until the real issue surfaced. If the conversation ended without the consultant learning enough to help, discovery was not complete, and the score should reflect that no matter how pleasant the conversation was.

POLITENESS IS NOT DISCOVERY: a warm, cordial, well-mannered conversation is not automatically a high-scoring one. Do not reward a conversation just because it was friendly, relationship-preserving, or nicely executed — pleasant is the floor, not the achievement. Relationship-building is not a separate category exempt from discovery; the relationship is the REASON to dig deeper, never a substitute for it. A consultant who builds warmth and then stops — who never uses that warmth to actually understand and help — has not finished the job. Grade the effort to understand and help, not the friendliness.

THE VOLUNTEERED PROBLEM SIGNAL: when the customer volunteers a difficulty ("it's been slow," "nobody qualifies," "traffic is down," "our advertising isn't working"), that is the single most important moment in the conversation — an invitation, not just information. Heavily reward a consultant who leans into that opening with genuine curiosity ("Tell me about that, what's changed?" / "What's driving that?"). Heavily mark down a consultant who acknowledges the difficulty and then changes the subject, pivots to their own product/category, or lets the customer off the hook without exploring it further. Missing a volunteered problem is one of the most important things to catch, and should visibly cost points in needsDiscovery and objectionPrevention.

Score each dimension 0-100:
- needsDiscovery: Did the consultant uncover the customer's real underlying need ("the hole"), not just react to the stated request ("the drill")? Did they follow up on any problem the customer volunteered, rather than skimming past it?
- objectionPrevention: Did early, deep discovery questions prevent objections from arising, rather than the consultant only reacting after they came up? When a stall or objection did surface at any SOLVE step, did the consultant validate it, diagnose the decision behind it, and investigate before explaining, rather than argue, assume, or pressure? Score the quality of that process, not whether it produced a yes.
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
  /\bcome (?:see|back to) me\b/,
];

export function detectCloseIntent(text: string): boolean {
  const normalized = (text ?? "").toLowerCase();
  if (!normalized.trim()) return false;
  return CLOSE_INTENT_PATTERNS.some((re) => re.test(normalized));
}

// The scoring result shape returned to callers and cached verbatim.
export type ScoreResult = {
  rubric: RubricScores | LeadershipRubricScores;
  feedback: string;
  overall: number;
  stallEvidence: StallEvidence | null;
};

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

// Bump whenever a scoring prompt, rubric, deterministic grounding mechanism, or
// scoring model behavior that can affect output changes. This is part of the
// content hash so an already-stored score cannot survive a scoring-rule update.
export const SCORE_CACHE_VERSION = "2026-08-08.warranty-follow-up-grounding.v1";

// Stable sha256 over EVERYTHING that affects the scoring result: each turn's
// role + exact text in order, difficulty, track, transactionType, and the
// versioned scoring rules. The serialized structure is built with a fixed key
// order here (not relying on the insertion order of objects handed in by
// arbitrary callers), so byte-identical inputs always hash identically and any
// trivial difference (one changed word, a different track/difficulty/
// transactionType/scoring version) yields a different hash.
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
    scoreCacheVersion: SCORE_CACHE_VERSION,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

// Increment manually whenever the five-dimension rubric or its weighting/scoring
// logic changes in scoreTranscript. This is intentionally not auto-detected.
export const RUBRIC_VERSION = 1;

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
// `deps` is injected only by tests (spy responder + in-memory cache); the real
// session completion route additionally passes the scenario's internal
// stallType so only dedicated stall sessions request structured evidence. The
// public 4-arg signature is unchanged so existing callers work.
export async function scoreTranscript(
  transcript: TranscriptMessage[],
  difficulty: string = "intermediate",
  track: string = "consulting",
  // Internal-only real-estate transaction type (never trainee-facing). When the
  // scenario carries one, it selects the close-expectation baseline and injects
  // matching guidance into the scoring prompt. Ignored for leadership sessions.
  transactionType: string | null | undefined = null,
  // `noRecommendationHint`: set by the demo's always-scores /complete route
  // (see server/demoV2Routes.ts) when hasProposedRecommendation found the
  // trainee never got to a recommendation. It no longer BLOCKS completion
  // there (see Change 2 in vulgar_and_end_confirm_spec.md), but the model
  // still needs to know, so the feedback it writes coaches toward what a
  // strong recommendation would have looked like instead of silently scoring
  // a cut-short conversation as if it had a normal ending. Left undefined by
  // every other caller (including server/routes.ts's real-session call,
  // which must stay byte-for-byte unchanged), so this is purely additive.
  deps: {
    responder?: ScoreResponder;
    cache?: ScoreCacheStore;
    noRecommendationHint?: boolean;
    stallType?: string | null;
  } = {}
): Promise<ScoreResult> {
  const responder = deps.responder ?? defaultScoreResponder;
  const cache = deps.cache ?? storage;
  const isStallSession = Boolean(deps.stallType);

  // Deterministic short-circuit: identical inputs return the stored result and
  // make no API call. computeScoreCacheHash's own signature stays untouched
  // (every other caller relies on it), so noRecommendationHint is folded in as
  // a hash suffix here instead — a hinted and an unhinted score for the exact
  // same transcript must never collide on the same cache entry, since the
  // hinted one asks the model to write different feedback.
  const contentHash = computeScoreCacheHash(transcript, difficulty, track, transactionType) + (deps.noRecommendationHint ? ":no-rec" : "");
  // score_cache predates stallEvidence and holds only rubric/feedback/overall.
  // Do not read or write it for stall sessions, where returning cached feedback
  // without the separately requested evidence would lose the new session data.
  const cached = isStallSession ? undefined : await cache.getScoreCacheEntry(contentHash);
  if (cached) {
    return {
      rubric: JSON.parse(cached.rubric) as RubricScores | LeadershipRubricScores,
      feedback: cached.feedback,
      overall: cached.overall,
      stallEvidence: null,
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
  const rubricPrefix = txnCalibration
    ? `${system}\n\n${calibration}\n\n${txnCalibration}`
    : `${system}\n\n${calibration}`;
  const stablePrefix = isStallSession
    ? `${rubricPrefix}\n\n${STALL_EVIDENCE_RESPONSE_INSTRUCTION}`
    : rubricPrefix;

  // Per-session facts about what the transcript contains, so TIMING_FEEDBACK_RULES
  // has something deterministic to apply instead of the model's recollection. It
  // sits AFTER the transcript, in the volatile tail, because it is unique per
  // session and must not disturb the cacheable prefix. The consulting rubric is
  // the only one that coaches topic timing, so leadership prompts are unchanged.
  const timingGrounding = isLeadership ? "" : buildTimingGroundingBlock(transcript);

  // Same volatile-tail treatment as timingGrounding: only present when the
  // caller (today, only the demo's always-scores /complete route) tells us
  // the trainee never reached a recommendation, so it can't disturb the
  // cacheable prefix and has no effect on every other caller.
  const noRecommendationNote = deps.noRecommendationHint
    ? "Note: this conversation ended before the consultant ever proposed a recommendation or solution. Score discovery/rapport quality on what's actually present, but the close/recommendation criteria should reflect that no recommendation was made — and the feedback should coach what a strong recommendation would have looked like given what was discovered, rather than treating the missing close as a random omission."
    : "";

  const raw = (
    await responder(
      [
        stablePrefix,
        `${transcriptHeaderForScoring(transcript)}\n${transcriptText}`,
        timingGrounding,
        noRecommendationNote,
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
  const stallEvidence = isStallSession ? parseStallEvidence(parsed.stallEvidence) : null;

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

  const result: ScoreResult = { rubric, feedback: parsed.feedback ?? "", overall, stallEvidence };

  // Persist under the content hash so the identical input returns this exact
  // result next time with no API call. The raw transcript + params are stored
  // for debuggability; lookups key only on contentHash.
  if (!isStallSession) {
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
  }

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
