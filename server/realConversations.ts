// Pure, dependency-free helpers for Real Conversation Scoring (Phase 1). Kept
// separate from routes/storage so they can be unit-tested without a DB, an HTTP
// server, or the OpenAI client. Nothing here touches practice `sessions`, the
// scoring prompts, or the model. A real conversation is parsed into the SAME
// TranscriptMessage[] the practice engine already consumes, then handed to the
// existing scoreTranscript unchanged.

import type { TranscriptMessage, RubricScores } from "@shared/schema";
import { WEAK_PROCESS_THRESHOLD } from "./llm";

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
}) => Promise<{ text: string; duration?: number; segments?: AudioSegment[] }>;

// A single Whisper segment: its text plus the start/end offsets (seconds) Whisper
// reports in verbose_json. Timings are optional because the sentence-split
// fallback (no Whisper segments) has none, and older/other transcribers may omit
// them; the suspicious-transcript detector simply skips timing checks when absent.
export type AudioSegment = { text: string; start?: number; end?: number };

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

// A leading timestamp token that phone systems, Zoom, and other call-transcript
// exporters prefix onto each line. Matched forms (anchored at the very start):
//   [00:14]  [00:14:32]  (00:14)  (00:14:32)  00:14  00:14:32
// optionally followed by a single separator (":", "-", or ">") and surrounding
// spaces. Supports both MM:SS and HH:MM:SS digit groupings. Only a LEADING token
// is stripped, so a time inside a sentence ("I'll be there at 3:45") is untouched.
const LEADING_TIMESTAMP =
  /^\s*(?:\[\s*\d{1,2}:\d{2}(?::\d{2})?\s*\]|\(\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)|\d{1,2}:\d{2}(?::\d{2})?)\s*[-:>]?\s*/;

// Removes a leading timestamp so speaker-label detection sees the label at the
// start of the line. The timestamp is discarded, not retained: TranscriptMessage
// carries no timestamp-display field that scoring consumes (each parsed message
// already gets a single parse-time ISO stamp). A line with no leading timestamp
// is returned unchanged.
export function stripLeadingTimestamp(line: string): string {
  return line.replace(LEADING_TIMESTAMP, "");
}

// Generic diarization labels that meeting/phone tools emit instead of names, e.g.
// "Speaker A", "Speaker B", "Speaker 1", "Speaker 2". They carry no inherent
// rep-vs-customer meaning, so classifyLabel cannot map them; they are resolved by
// order of first appearance instead (see resolveGenericSpeakerRole).
const GENERIC_SPEAKER_LABEL = /^speaker\s*[a-z0-9]+$/i;

function isGenericSpeakerLabel(label: string): boolean {
  return GENERIC_SPEAKER_LABEL.test(label.trim());
}

function classifyLabel(label: string): ParsedRole | null {
  const normalized = label.trim().toLowerCase();
  if (REP_LABELS.has(normalized)) return "consultant";
  if (CUSTOMER_LABELS.has(normalized)) return "customer";
  // Email headers: treat the "From:" author generically. Direction is decided by
  // alternation fallback below, so return null to signal "unknown label".
  return null;
}

// Resolves a generic speaker label to a role by the order it first appears in THIS
// transcript: the first distinct label is the customer and the second is the
// consultant/rep, matching the customer-led convention used for the no-labels
// fallback (the customer leads, the rep responds). A third-or-later distinct
// label collapses to customer rather than introducing a new role, keeping the
// binary role model intact for rare three-plus-speaker transcripts. The
// assignments map persists the label-to-role decisions across the parse.
function resolveGenericSpeakerRole(
  label: string,
  assignments: Map<string, ParsedRole>
): ParsedRole {
  const key = label.trim().toLowerCase();
  const existing = assignments.get(key);
  if (existing) return existing;
  const role: ParsedRole = assignments.size === 1 ? "consultant" : "customer";
  assignments.set(key, role);
  return role;
}

// Parses a pasted text/SMS/chat log or an email thread into TranscriptMessage[].
//
// Heuristics (deterministic, no model call):
//   * A leading timestamp ("[00:14] ", "00:14 - ") is stripped first so it never
//     hides the speaker label behind it.
//   * Lines with a recognized speaker label ("Me:", "Customer:") take that role.
//   * Generic diarization labels ("Speaker A:", "Speaker B:") are resolved by
//     order of first appearance: first distinct label -> customer, second -> rep.
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
  // Per-transcript memory of which role each generic "Speaker X" label maps to.
  const genericSpeakerRoles = new Map<string, ParsedRole>();

  for (const rawLine of lines) {
    // Skip common email envelope noise so it does not become a customer turn.
    if (submissionType === "email" && isEmailEnvelopeLine(rawLine)) continue;

    // Strip a leading timestamp before anything else so label detection sees the
    // label at the start. A line that was only a timestamp becomes empty; skip it.
    const line = stripLeadingTimestamp(rawLine).trim();
    if (line.length === 0) continue;

    const match = line.match(LABEL_PREFIX);
    if (match) {
      const label = match[1];
      let role = classifyLabel(label);
      // Fall back to generic-speaker resolution for "Speaker A/B/1/2" style labels
      // that carry no semantic rep-vs-customer meaning.
      if (!role && isGenericSpeakerLabel(label)) {
        role = resolveGenericSpeakerRole(label, genericSpeakerRoles);
      }
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
  segments?: AudioSegment[]
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

// --- Audio misattribution guardrail (Phase 2 hardening) ---
//
// Whisper has no speaker diarization, so parseAudioTranscript blindly alternates
// customer/consultant across segments. That is fragile: if Whisper splits ONE
// speaker's turn into two segments (a mid-sentence breath/pause), every later
// turn's role shifts by one and the rubric score is corrupted. These heuristics
// flag transcripts where blind alternation is likely wrong so the route can route
// them to manual review instead of silently emitting a misleading score.

// A gap this small (seconds) between the end of one segment and the start of the
// next indicates a continuous utterance Whisper split, not a real turn change.
export const SHORT_SEGMENT_GAP_SECONDS = 0.3;
// A single turn longer than this multiple of the median turn length suggests two
// real turns were merged into one segment (no pause detected between speakers).
export const LONG_TURN_MEDIAN_MULTIPLE = 4;
// Fewer turns than this is too little back-and-forth to attribute speakers from
// alternation with any confidence (and too little conversation to score well).
export const MIN_MEANINGFUL_TURNS = 3;

function median(sortedAscending: number[]): number {
  if (sortedAscending.length === 0) return 0;
  const mid = Math.floor(sortedAscending.length / 2);
  return sortedAscending.length % 2 === 1
    ? sortedAscending[mid]
    : (sortedAscending[mid - 1] + sortedAscending[mid]) / 2;
}

// Inspects Whisper segments for the misattribution risks above and returns
// whether the audio transcript should be held for manual review, with
// human-readable reasons. Never throws and never mutates its input; a transcript
// with clean, well-separated, similarly-sized turns returns suspicious:false.
export function detectSuspiciousAudioTranscript(
  segments: AudioSegment[] | undefined
): { suspicious: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const turns = (segments ?? [])
    .map((s) => ({ text: (s.text ?? "").trim(), start: s.start, end: s.end }))
    .filter((s) => s.text.length > 0);

  // (b) Too few turns to trust alternation (or to score meaningfully).
  if (turns.length < MIN_MEANINGFUL_TURNS) {
    reasons.push(
      `Only ${turns.length} spoken turn(s) were detected, too little back-and-forth to reliably tell who is speaking.`
    );
  }

  // (a) A very short gap between consecutive segments: one utterance Whisper
  // split, which shifts every subsequent role assignment by one.
  for (let i = 1; i < turns.length; i++) {
    const prevEnd = turns[i - 1].end;
    const curStart = turns[i].start;
    if (typeof prevEnd === "number" && typeof curStart === "number") {
      const gap = curStart - prevEnd;
      if (gap < SHORT_SEGMENT_GAP_SECONDS) {
        reasons.push(
          `A ${gap.toFixed(
            2
          )}s gap between turns ${i} and ${i + 1} suggests one speaker's turn was split, which can misassign every later speaker label.`
        );
        break; // One instance is enough to warrant review.
      }
    }
  }

  // (c) An implausibly long turn relative to the rest: two real turns likely
  // merged into a single Whisper segment with no detected pause between speakers.
  if (turns.length >= 2) {
    const lengths = turns.map((t) => t.text.split(/\s+/).filter(Boolean).length);
    const med = median([...lengths].sort((a, b) => a - b));
    const longest = Math.max(...lengths);
    if (med > 0 && longest > med * LONG_TURN_MEDIAN_MULTIPLE) {
      reasons.push(
        `One turn is far longer (${longest} words) than the typical turn (${med}), suggesting two speakers were merged into one segment.`
      );
    }
  }

  return { suspicious: reasons.length > 0, reasons };
}

// Lines that are email transport/header noise rather than conversational content.
function isEmailEnvelopeLine(line: string): boolean {
  return /^(from|sent|to|cc|bcc|date|subject):/i.test(line) ||
    /^on .+ wrote:$/i.test(line) ||
    /^-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(line);
}

// Maps each practice rubric dimension to the SOLVE step it most reflects, so the
// step where a real conversation stalled can be surfaced. This is a
// presentation-only derivation over the UNCHANGED practice rubric output; it
// never alters scoring.
//
// The entries are ordered to match the canonical SOLVE sequence (Situation, Open,
// Listen, Visualize success, Engineer the Solution) so that iteration order here
// IS the sequence order. The dimension-to-step semantic mapping is unchanged;
// only the ordering was fixed. The canonical sequence and its exact step names
// are a standing product rule and must not be altered.
const RUBRIC_KEY_TO_SOLVE_STEP: Record<keyof RubricScores, string> = {
  trustBuilding: "Situation",
  objectionPrevention: "Open",
  needsDiscovery: "Listen",
  relationshipContinuity: "Visualize success",
  naturalClose: "Engineer the Solution",
};

// A dimension at or below this score counts as a genuine breakdown (a "failed"
// step), reusing the same weak-process bar the scorer uses to decide discovery
// was too shallow to pass. Kept as the single source of truth for "low score".
const STALLED_STEP_FAILURE_THRESHOLD = WEAK_PROCESS_THRESHOLD;

// Deterministically derives the "stalled step". When one or more dimensions show
// a real breakdown (score at or below STALLED_STEP_FAILURE_THRESHOLD), the
// EARLIEST failing step in canonical SOLVE sequence is returned: an upstream miss
// (failing Situation or Open early) drags the downstream steps down as a
// consequence, so the earliest failure is the true root cause, not whichever
// symptom happens to score lowest. When nothing failed (all dimensions above the
// threshold), we fall back to the single lowest-scoring step so the field is
// still populated for coaching. Iteration follows SOLVE order, so ties resolve to
// the earlier step. Returns null when there is no rubric to inspect.
export function deriveStalledStep(rubric: RubricScores | null | undefined): string | null {
  if (!rubric) return null;
  const keys = Object.keys(RUBRIC_KEY_TO_SOLVE_STEP) as (keyof RubricScores)[];

  for (const key of keys) {
    const score = typeof rubric[key] === "number" ? (rubric[key] as number) : 0;
    if (score <= STALLED_STEP_FAILURE_THRESHOLD) {
      return RUBRIC_KEY_TO_SOLVE_STEP[key];
    }
  }

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
