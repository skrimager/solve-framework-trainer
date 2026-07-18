// Pure, dependency-free helpers for Real Conversation Scoring (Phase 1). Kept
// separate from routes/storage so they can be unit-tested without a DB, an HTTP
// server, or the OpenAI client. Nothing here touches practice `sessions`, the
// scoring prompts, or the model. A real conversation is parsed into the SAME
// TranscriptMessage[] the practice engine already consumes, then handed to the
// existing scoreTranscript unchanged.

import type { TranscriptMessage, RubricScores } from "@shared/schema";

// The two paste-based submission methods (Phase 1) plus 'audio' (Phase 2, a file
// upload transcribed by Whisper). All three land in the SAME scoring pipeline.
export const REAL_CONVERSATION_SUBMISSION_TYPES = ["text_chat", "email", "audio"] as const;
export type RealConversationSubmissionType =
  (typeof REAL_CONVERSATION_SUBMISSION_TYPES)[number];

export function isValidSubmissionType(
  value: unknown
): value is RealConversationSubmissionType {
  return (
    typeof value === "string" &&
    (REAL_CONVERSATION_SUBMISSION_TYPES as readonly string[]).includes(value)
  );
}

// Submission types that carry a pasted transcript in the request body. Audio is
// excluded: it arrives as a file upload on a dedicated multipart route.
export type PastedSubmissionType = Exclude<RealConversationSubmissionType, "audio">;

// --- Phase 2 audio upload limits/validation (all enforced server-side) ---
// Strict byte cap, enforced at the multer layer AND re-checked in the route.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB
// Approximate duration ceiling, checked against Whisper's reported duration.
export const MAX_AUDIO_DURATION_SECONDS = 30 * 60; // ~30 minutes
// Only these three container formats are accepted.
export const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav"] as const;

// Validates an uploaded audio file by its extension (the user-visible, reliable
// signal) rather than the browser-supplied mimetype, which varies by OS/browser
// for m4a/wav and is sometimes empty or application/octet-stream.
export function isAllowedAudioFile(filename: string | undefined | null): boolean {
  if (typeof filename !== "string") return false;
  const lower = filename.toLowerCase();
  return ALLOWED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// The Whisper transcription call, injected so routes/tests can swap in a fake
// without the OpenAI client or network access (mirrors RealConversationScorer).
// Returns the flat transcript text, and, when the API reports them, the audio
// duration (for the ~30 min cap) and per-segment text (natural turn boundaries).
export type RealConversationTranscriber = (input: {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}) => Promise<{ text: string; duration?: number; segments?: { text: string }[] }>;

// The exact consent language the rep must agree to before a submission is
// accepted. Kept as a single exported constant so the server gate and the client
// checkbox render byte-for-byte identical text.
export const REAL_CONVERSATION_CONSENT_TEXT =
  "I have the legal right to submit this conversation, including any required consent to its recording.";

// Injected scorer type so routes/tests can swap in a fake without the OpenAI
// client. Matches the practice engine's signature/return shape exactly.
export type RealConversationScorer = (
  transcript: TranscriptMessage[],
  difficulty?: string,
  track?: string,
  transactionType?: string | null
) => Promise<{ rubric: RubricScores; feedback: string; overall: number }>;

// Which side of the conversation a parsed line came from. The practice engine
// only knows "customer" vs "consultant"; the rep who submits is the consultant.
type ParsedRole = TranscriptMessage["role"];

// Speaker labels that map to the rep (the "consultant" side). Everything that is
// not clearly the rep is treated as the customer, so an unlabeled counterparty
// line is never mis-credited to the rep.
const REP_LABELS = new Set([
  "me",
  "rep",
  "agent",
  "consultant",
  "sales",
  "salesperson",
  "advisor",
]);
const CUSTOMER_LABELS = new Set([
  "customer",
  "client",
  "prospect",
  "lead",
  "them",
  "buyer",
  "homeowner",
]);

// A "Label: text" prefix at the start of a line (e.g. "Me: hi", "Customer - hi",
// "From: Jane <j@x.com>"). Captures the label and the remainder.
const LABEL_PREFIX = /^\s*([A-Za-z][A-Za-z .'@<>()\-]{0,40}?)\s*[:>-]\s+(.*)$/;

function classifyLabel(label: string): ParsedRole | null {
  const normalized = label.trim().toLowerCase();
  if (REP_LABELS.has(normalized)) return "consultant";
  if (CUSTOMER_LABELS.has(normalized)) return "customer";
  // Email headers: treat the "From:" author generically. Direction is decided by
  // alternation fallback below, so return null to signal "unknown label".
  return null;
}

// Parses a pasted text/SMS/chat log or an email thread into TranscriptMessage[].
//
// Heuristics (deterministic, no model call):
//   * Lines with a recognized speaker label ("Me:", "Customer:") take that role.
//   * Unlabeled lines inherit the previous line's role (multi-line messages).
//   * If a submission has NO recognizable labels at all, we alternate starting
//     with the customer, since a real discovery conversation is customer-led and
//     the rep is responding. This keeps a bare paste usable rather than rejected.
//
// The output is only ever fed to the existing scoreTranscript; it is never shown
// back to the rep as if it were an authoritative reconstruction.
export function parsePastedTranscript(
  raw: string,
  submissionType: PastedSubmissionType
): TranscriptMessage[] {
  const nowIso = new Date().toISOString();
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const messages: TranscriptMessage[] = [];
  let sawAnyLabel = false;
  let lastRole: ParsedRole = "customer";

  for (const line of lines) {
    // Skip common email envelope noise so it does not become a customer turn.
    if (submissionType === "email" && isEmailEnvelopeLine(line)) continue;

    const match = line.match(LABEL_PREFIX);
    if (match) {
      const role = classifyLabel(match[1]);
      const body = match[2].trim();
      if (role) {
        sawAnyLabel = true;
        lastRole = role;
        if (body) pushOrAppend(messages, role, body, nowIso);
        continue;
      }
      // Unknown label (e.g. a person's name): keep the body, defer role to the
      // alternation/inheritance logic below by falling through with full line.
    }

    if (sawAnyLabel) {
      // We're in "labeled mode": an unlabeled line continues the current speaker.
      pushOrAppend(messages, lastRole, line, nowIso);
    } else {
      // No label seen yet: keep each line as its own turn so a bare paste can be
      // rebuilt by strict alternation below. Role is a placeholder until then.
      messages.push({ role: lastRole, content: line, timestamp: nowIso });
    }
  }

  // No labels anywhere: rebuild by strict alternation starting with the customer.
  if (!sawAnyLabel && messages.length > 0) {
    return messages.map((m, i) => ({
      ...m,
      role: (i % 2 === 0 ? "customer" : "consultant") as ParsedRole,
    }));
  }

  return messages;
}

function pushOrAppend(
  messages: TranscriptMessage[],
  role: ParsedRole,
  text: string,
  timestamp: string
): void {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content = `${last.content} ${text}`.trim();
    return;
  }
  messages.push({ role, content: text, timestamp });
}

// Parses a Whisper transcript into TranscriptMessage[]. Whisper's basic API
// returns a flat transcript with no speaker labels, so we cannot know who spoke.
// This reuses the exact same fallback parsePastedTranscript applies to an
// unlabeled paste: split the transcript into turns and alternate starting with
// the customer, since a real discovery conversation is customer-led and the rep
// is responding. Whisper segments (when present) give natural turn boundaries;
// otherwise we split the flat text on sentence boundaries as a best effort. The
// output is only ever fed to the unchanged scoreTranscript, never shown back as
// an authoritative reconstruction.
export function parseAudioTranscript(
  text: string,
  segments?: { text: string }[]
): TranscriptMessage[] {
  const nowIso = new Date().toISOString();

  let turns: string[];
  if (segments && segments.length > 0) {
    turns = segments.map((s) => s.text.trim()).filter((t) => t.length > 0);
  } else {
    turns = text
      .replace(/\r\n/g, "\n")
      .split(/(?<=[.!?])\s+|\n+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  return turns.map((content, i) => ({
    role: (i % 2 === 0 ? "customer" : "consultant") as ParsedRole,
    content,
    timestamp: nowIso,
  }));
}

// Lines that are email transport/header noise rather than conversational content.
function isEmailEnvelopeLine(line: string): boolean {
  return /^(from|sent|to|cc|bcc|date|subject):/i.test(line) ||
    /^on .+ wrote:$/i.test(line) ||
    /^-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(line);
}

// Maps each practice rubric dimension to the SOLVE step it most reflects, so the
// weakest dimension can be surfaced as the step where the real conversation
// stalled. This is a presentation-only derivation over the UNCHANGED practice
// rubric output; it never alters scoring.
const RUBRIC_KEY_TO_SOLVE_STEP: Record<keyof RubricScores, string> = {
  needsDiscovery: "Listen",
  objectionPrevention: "Open",
  trustBuilding: "Situation",
  naturalClose: "Engineer the Solution",
  relationshipContinuity: "Visualize success",
};

// Deterministically derives the "stalled step": the SOLVE step corresponding to
// the lowest-scoring rubric dimension. Ties break by the fixed key order above
// (stable, testable). Returns null when there is no rubric to inspect.
export function deriveStalledStep(rubric: RubricScores | null | undefined): string | null {
  if (!rubric) return null;
  const keys = Object.keys(RUBRIC_KEY_TO_SOLVE_STEP) as (keyof RubricScores)[];
  let worstKey: keyof RubricScores | null = null;
  let worstScore = Infinity;
  for (const key of keys) {
    const score = typeof rubric[key] === "number" ? (rubric[key] as number) : 0;
    if (score < worstScore) {
      worstScore = score;
      worstKey = key;
    }
  }
  return worstKey ? RUBRIC_KEY_TO_SOLVE_STEP[worstKey] : null;
}
