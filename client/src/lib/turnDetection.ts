// Adaptive end-of-turn (silence) heuristic for the voice loop.
//
// The voice loop auto-sends the current utterance after a gap of silence. A
// single fixed timer is a poor fit for natural speech: people pause mid-thought
// ("I think the main thing is... the price"), and a short fixed timer cuts them
// off, while a long fixed timer makes finished sentences feel sluggish.
//
// This module inspects only the TRAILING tokens of the current (interim)
// transcript and returns a recommended wait time. It is a lightweight, purely
// lexical heuristic (regex/keyword based, no network and no per-keystroke LLM
// call, so it adds no latency). It is deliberately NOT semantic VAD; that needs
// the Realtime API and is deferred to phase 2 (see docs/voice-realtime-migration.md).
//
// Three outcomes:
//   - "incomplete": the utterance trails off or ends on a word that clearly
//     expects more (a conjunction, preposition, article, auxiliary/copula, or a
//     filler like "um"/"like"). Wait LONGER so a thinking pause is not cut off.
//   - "complete": the utterance ends with terminal punctuation or on a natural
//     sentence-final word. Wait SHORTER so responses feel snappy.
//   - "neutral": no strong signal either way. Use the caller's base wait.

export type TurnCompleteness = "incomplete" | "neutral" | "complete";

// The neutral (ambiguous) wait. Matches the loop's previous fixed timer so the
// common case is unchanged; the classifier only shortens or lengthens around it.
export const DEFAULT_SILENCE_MS = 1500;

// Multipliers applied to the base wait for the non-neutral outcomes.
const COMPLETE_RATIO = 0.6;
const INCOMPLETE_RATIO = 1.7;

// Absolute guardrails so an unusual base can never produce a jarring wait.
const MIN_WAIT_MS = 600;
const MAX_WAIT_MS = 3500;

// Words that, when they are the LAST token, mean the speaker almost certainly
// has more to say: coordinating/subordinating conjunctions, prepositions,
// articles, possessives, and auxiliary/copular verbs. Ending a spoken phrase on
// any of these is a strong "not finished" signal.
const TRAILING_CONNECTORS = new Set([
  // conjunctions
  "and", "but", "or", "nor", "so", "yet", "because", "since", "although",
  "though", "while", "whereas", "if", "unless", "until", "whether", "as",
  // prepositions
  "to", "of", "for", "with", "without", "about", "into", "onto", "from",
  "by", "at", "on", "in", "over", "under", "than", "then", "between",
  "through", "toward", "towards", "upon", "within", "against", "around",
  // articles and possessives
  "the", "a", "an", "my", "your", "our", "their", "his", "her", "its",
  // auxiliaries and copulas (expect a complement)
  "is", "are", "was", "were", "am", "be", "been", "being", "will", "would",
  "can", "could", "should", "shall", "may", "might", "must", "do", "does",
  "did", "have", "has", "had",
]);

// Single-word hesitation/filler tokens. Ending on one of these means the speaker
// is still gathering their thought, not done.
const FILLERS = new Set([
  "um", "uh", "erm", "er", "ah", "hmm", "hmmm", "like", "well", "so",
  "basically", "actually", "literally", "honestly",
]);

// Multi-word trailing phrases that signal the speaker is still going.
const TRAILING_FILLER_PHRASES = [
  "you know", "i mean", "kind of", "sort of", "let me think",
  "let me see", "let's see", "or something", "and stuff",
];

// Words that commonly and naturally END a complete spoken sentence: object
// pronouns and short affirmations/closers. Ambiguous words that can also open a
// subordinate clause (for example "that", "this") are intentionally excluded so
// they fall through to neutral instead of a false "complete".
const SENTENCE_FINAL_WORDS = new Set([
  "me", "you", "it", "us", "them", "him", "her",
  "yes", "yeah", "yep", "yup", "no", "nope", "ok", "okay", "sure",
  "right", "correct", "exactly", "agreed", "thanks", "please",
  "done", "perfect", "great", "fine", "good",
]);

function lastWord(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] ?? "";
  // Strip surrounding punctuation but keep internal apostrophes ("don't").
  return last.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "").toLowerCase();
}

// Classify the trailing edge of an (interim) transcript.
export function classifyUtterance(transcript: string): TurnCompleteness {
  const trimmed = transcript.trim();
  if (!trimmed) return "neutral";

  const lower = trimmed.toLowerCase();

  // Explicit trailing-off: an ellipsis means "still thinking".
  if (/(\.\.\.|…)$/.test(trimmed)) return "incomplete";

  // Trailing multi-word filler phrase.
  const lowerNoPunct = lower.replace(/[^A-Za-z0-9'\s]+$/g, "").trimEnd();
  for (const phrase of TRAILING_FILLER_PHRASES) {
    if (lowerNoPunct.endsWith(phrase)) return "incomplete";
  }

  const word = lastWord(trimmed);
  if (word && (FILLERS.has(word) || TRAILING_CONNECTORS.has(word))) {
    return "incomplete";
  }

  // Terminal punctuation is a strong "finished" signal (some recognizers add it
  // to finalized results).
  if (/[.!?]["'”’)\]]*$/.test(trimmed)) return "complete";

  if (word && SENTENCE_FINAL_WORDS.has(word)) return "complete";

  return "neutral";
}

function clamp(ms: number): number {
  return Math.round(Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, ms)));
}

// Recommend how long to wait for more speech before auto-sending, given the
// current transcript. `baseMs` is the neutral/ambiguous wait; complete and
// incomplete utterances scale down/up from it.
export function recommendSilenceMs(transcript: string, baseMs: number = DEFAULT_SILENCE_MS): number {
  switch (classifyUtterance(transcript)) {
    case "complete":
      return clamp(baseMs * COMPLETE_RATIO);
    case "incomplete":
      return clamp(baseMs * INCOMPLETE_RATIO);
    default:
      return clamp(baseMs);
  }
}
