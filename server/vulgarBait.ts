// Detection for vulgar/belligerent "bait" messages from the consultant side of
// a role-play, and the strike bookkeeping that decides what happens when one is
// sent.
//
// The live incident this exists for: a demo visitor sent hostile/dismissive
// lines ("fuck off", "sorry not worth my time", etc.) at the simulated
// customer, who — because nothing told it not to — reacted to the vulgarity
// in character, and the conversation never reached a recommendation. The fix
// is not to make the customer persona better at handling abuse; it is to catch
// this class of input BEFORE it ever reaches the persona prompt and answer it
// with a fixed, scripted, out-of-character line instead. See getCustomerReply /
// streamCustomerReply in server/llm.ts, which call detectVulgarBait before
// building the normal prompt so both the demo and real trainee routes inherit
// this from the one shared code path.
//
// This is explicitly NOT a content-moderation system. It only has to catch the
// common, obvious cases (profanity, sexually crude baiting language) well
// enough to recognize "someone is trying to derail the practice session", not
// every creative way of phrasing an insult. False negatives on cleverly worded
// bait are acceptable.
import type { TranscriptMessage } from "@shared/schema";

// Maintainable word/phrase list rather than one dense regex: each entry is
// either a whole word (matched with word boundaries, so it cannot fire inside
// an unrelated longer word) or a short literal phrase (matched as a substring,
// since phrases like "your mama" are unambiguous even without boundaries).
// Add new entries here as new bait phrasing shows up in real sessions.
const VULGAR_WORDS: string[] = [
  "fuck",
  "fucking",
  "fucker",
  "motherfucker",
  "shit",
  "bullshit",
  "bitch",
  "asshole",
  "dick",
  "dickhead",
  "cock",
  "pussy",
  "cunt",
  "bastard",
  "whore",
  "slut",
  "retard",
];

const VULGAR_PHRASES: string[] = [
  "fuck off",
  "fuck you",
  "suck my dick",
  "suck my",
  "your mama",
  "yo mama",
  "eat shit",
  "piss off",
  "go to hell",
  "kiss my ass",
];

// One combined regex, built once at module load: a word-boundary alternation
// for the single words plus a plain alternation for the multi-word phrases
// (which already can't false-positive inside another word the way a bare word
// could). Rebuilding this per call would be wasted work on every single
// consultant message.
const WORD_PATTERN = new RegExp(`\\b(${VULGAR_WORDS.join("|")})\\b`, "i");
const PHRASE_PATTERN = new RegExp(`(${VULGAR_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");

// Flags a just-sent consultant message as profane/sexually-crude baiting
// language. Deliberately simple: this is a practical "are they trying to
// derail the demo" signal for common cases, not a rigorous moderation system.
export function detectVulgarBait(text: string): boolean {
  if (!text || !text.trim()) return false;
  return WORD_PATTERN.test(text) || PHRASE_PATTERN.test(text);
}

// Re-derives how many prior CONSULTANT turns in this transcript already
// tripped detectVulgarBait, BEFORE the current in-flight message (which is not
// part of the transcript yet at the point getCustomerReply/streamCustomerReply
// call this — see below). Stateless and recomputed every call, the same way
// hasProposedRecommendation and hasCustomerAcceptedProposal are derived fresh
// from the transcript each time, so no new schema column or migration is
// needed to track it.
export function countPriorVulgarStrikes(transcript: TranscriptMessage[]): number {
  return transcript.filter((m) => m.role === "consultant" && detectVulgarBait(m.content)).length;
}

// The exact, scripted, out-of-character replies for the first and second
// vulgar/belligerent message in a session. Verbatim per spec; do not silently
// reword these, they are reviewed copy.
export const VULGAR_STRIKE_ONE_REPLY =
  "Haha, that's funny. I get it, checking my temperature! People like to play around with me at first. This happens a lot. I'm paid to have a little practice session here and you're busting my chops! Do me a favor, let's get back to work. You're gonna get me in trouble. My boss has asked me to shut this down if we keep messing around, so if it happens again he'll pull the plug on us. Let's get through this together so I don't get fired.";

export const VULGAR_STRIKE_TWO_REPLY = "Oh man! Sorry, he's yelling at me. I gotta go.";

// Status value written when a session is ended by the second vulgar strike.
// Chosen to be distinct from every existing status ('in_progress' | 'saved' |
// 'completed' for real sessions, 'in_progress' | 'completed' for demo
// sessions — see shared/schema.ts) so nothing downstream that switches on
// status can mistake a conduct-ended session for either an ordinary
// in-progress or a normally-scored one.
export const VULGAR_ENDED_STATUS = "ended_conduct";
