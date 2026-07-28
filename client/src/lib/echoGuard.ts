// Guards the voice loop against capturing the AI customer's OWN speech as a
// consultant turn.
//
// The failure this exists to prevent: the browser's speech recognizer is
// restarted the instant we believe the reply audio finished, but that instant is
// derived from a Web Audio timeline estimate. If the estimate is even slightly
// early (or the device speaker has latency, or the user is on a laptop with no
// headset), the mic opens while the tail of the customer's TTS is still audible.
// Web Speech transcribes it, the draft is auto-sent, and it is POSTed as
// `role: "consultant"`. From then on the stored transcript claims the REP said
// something the CUSTOMER said, and the coach dutifully credits the rep for it.
// That is the reported "coach praised the rep for the customer's question" bug.
//
// Two independent defenses, both here so they can be unit-tested without a
// browser:
//   1. AUDIO_TAIL_GUARD_MS - extra padding before the mic is allowed to reopen.
//   2. isLikelyEchoOfCustomer - a text check that drops a draft which is really
//      a re-transcription of what the customer just said.
//
// The text check is the backstop, and it is deliberately conservative: a rep
// legitimately repeats the customer's words back ("so it's the safety that
// matters most") as good active listening, and that must still be sent. Only a
// draft that is almost entirely contained in the customer's last line is dropped.

// Padding added to the estimated end of the reply audio timeline before the mic
// reopens. Large enough to cover speaker latency and timeline drift, small
// enough that the conversation still feels responsive.
export const AUDIO_TAIL_GUARD_MS = 400;

// A draft this short carries no reliable signal either way, so it is never
// dropped as an echo (an echo that short also costs the transcript almost
// nothing, whereas dropping a real "Yes." or "That works." would be a bug).
const MIN_ECHO_WORDS = 4;

// Fraction of the draft's words that must appear, in order, inside the
// customer's last line for the draft to count as an echo of it.
const ECHO_CONTAINMENT_RATIO = 0.8;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

// Longest run of draft words that appears contiguously in the customer's line,
// as a fraction of the draft length. A re-transcription of TTS is contiguous by
// construction (it is the same audio), which is what distinguishes it from a rep
// paraphrasing scattered words back.
export function echoContainmentRatio(draft: string, customerText: string): number {
  const d = words(draft);
  const c = words(customerText);
  if (d.length === 0 || c.length === 0) return 0;

  // Longest common substring over word arrays.
  let longest = 0;
  const prev = new Array<number>(c.length + 1).fill(0);
  const cur = new Array<number>(c.length + 1).fill(0);
  for (let i = 1; i <= d.length; i++) {
    for (let j = 1; j <= c.length; j++) {
      cur[j] = d[i - 1] === c[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > longest) longest = cur[j];
    }
    for (let j = 0; j <= c.length; j++) prev[j] = cur[j];
  }

  return longest / d.length;
}

// True when `draft` is almost certainly the recognizer picking up the customer's
// own TTS rather than the rep speaking. Callers drop such a draft instead of
// sending it, so it can never be stored as a consultant turn.
export function isLikelyEchoOfCustomer(
  draft: string,
  customerText: string | null | undefined
): boolean {
  if (!customerText) return false;
  const d = words(draft);
  if (d.length < MIN_ECHO_WORDS) return false;
  return echoContainmentRatio(draft, customerText) >= ECHO_CONTAINMENT_RATIO;
}
