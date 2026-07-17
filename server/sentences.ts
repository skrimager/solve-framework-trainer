// Sentence-boundary detection for the streaming voice pipeline.
//
// Used in two places on the customer-reply path:
//   1. Streaming text generation: as the model streams the reply token by token,
//      we hand each COMPLETED sentence off to TTS immediately (see
//      createSentenceStreamer) instead of waiting for the whole reply.
//   2. Audio chunking: each sentence is synthesized as its own short clip so the
//      first one can start playing within about a second while the rest render.
//
// This is a real boundary detector, not a naive split on ".": it deliberately
// does NOT break on
//   - common abbreviations ("Mr.", "Dr.", "e.g.", "U.S.", single-letter
//     initials like "J."),
//   - decimal numbers ("3.14", "$1,499.99"),
//   - ellipses ("wait...").
// A boundary is only a terminator (. ! ?) that is followed by whitespace or the
// end of the text, so a period sitting inside a number ("3.14") or before more
// letters ("e.g.g") never ends a sentence. Trailing closing quotes/brackets are
// pulled into the sentence they close.

// Abbreviations whose trailing period must NOT end a sentence. Stored without the
// terminal period and matched case-insensitively. Internal-dot abbreviations
// ("e.g", "u.s") are stored in their pre-terminal form because the preceding
// token excludes the boundary period itself.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "inc", "ltd",
  "co", "corp", "dept", "est", "fig", "gen", "gov", "hon", "capt", "sgt", "col",
  "lt", "cmdr", "rev", "min", "max", "no", "vol", "approx", "appt", "apt",
  "e.g", "i.e", "a.m", "p.m", "u.s", "u.k", "ph.d", "d.c",
]);

const TERMINATORS = new Set([".", "!", "?"]);
const CLOSERS = /["'”’)\]]/; // straight/smart quotes and closing brackets

// The letters-and-internal-dots token immediately before a candidate period,
// used to recognize abbreviations ("Mr" -> "mr", "e.g" -> "e.g"). Excludes the
// boundary period itself.
function precedingToken(text: string, periodIdx: number): string {
  let s = periodIdx - 1;
  while (s >= 0 && /[A-Za-z.]/.test(text[s])) s--;
  return text.slice(s + 1, periodIdx).toLowerCase();
}

function isAbbreviation(token: string): boolean {
  if (!token) return false;
  const t = token.replace(/\.+$/, ""); // drop any trailing internal dot
  if (!t) return false;
  // A single letter before a period is almost always an initial ("J. Smith"),
  // not a sentence end.
  if (/^[a-z]$/.test(t)) return true;
  return ABBREVIATIONS.has(t);
}

// Splits a complete block of text into trimmed sentences. Empty/whitespace-only
// input yields an empty array. Text with no terminal punctuation yields a single
// sentence (the whole trimmed string).
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let start = 0;

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (!TERMINATORS.has(ch)) continue;

    // Consume a run of terminators so "?!" or "!!!" or "..." is treated as one.
    let j = i;
    while (j + 1 < n && TERMINATORS.has(text[j + 1])) j++;
    const run = text.slice(i, j + 1);

    // Pull any closing quotes/brackets into this sentence ("...done." -> `."`).
    let k = j;
    while (k + 1 < n && CLOSERS.test(text[k + 1])) k++;

    const nextCh = k + 1 < n ? text[k + 1] : "";
    // Only whitespace or end-of-text confirms a real boundary. A terminator
    // followed by another character ("3.14", "e.g.x") is inside a token, so a
    // decimal point never splits: the digit after it is not whitespace.
    if (nextCh !== "" && !/\s/.test(nextCh)) {
      i = j;
      continue;
    }

    // An ellipsis ("wait...") trails off rather than ending a thought; don't
    // split on it (the following clause belongs to the same spoken breath).
    if (/^\.{2,}$/.test(run)) {
      i = k;
      continue;
    }

    // A lone period after an abbreviation or initial is not a boundary.
    if (run === "." && isAbbreviation(precedingToken(text, i))) {
      i = k;
      continue;
    }

    const sentence = text.slice(start, k + 1).trim();
    if (sentence) out.push(sentence);
    start = k + 1;
    i = k;
  }

  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// Incremental sentence extractor for streamed text. Feed it token deltas as they
// arrive; each push() returns any sentences that are now definitely complete. The
// final (still-growing) sentence is held back until either a later push confirms
// it ended or flush() is called at end-of-stream. Holding the last fragment is
// what keeps an abbreviation at the current stream edge from being mis-split.
export interface SentenceStreamer {
  push(delta: string): string[];
  flush(): string[];
}

export function createSentenceStreamer(): SentenceStreamer {
  let buffer = "";
  return {
    push(delta: string): string[] {
      buffer += delta;
      const sentences = splitSentences(buffer);
      if (sentences.length <= 1) return [];
      // Everything except the last is settled; the last may still grow, so keep
      // it in the buffer for the next push/flush.
      buffer = sentences[sentences.length - 1];
      return sentences.slice(0, -1);
    },
    flush(): string[] {
      const rest = buffer.trim();
      buffer = "";
      return rest ? splitSentences(rest) : [];
    },
  };
}
