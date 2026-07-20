-- Audio misattribution guardrail for Real Conversation Scoring (Phase 2
-- hardening). Whisper has no speaker diarization, so the audio path blindly
-- alternates customer/consultant across segments. When a segment looks split or
-- merged (see detectSuspiciousAudioTranscript), the audio route now stores the
-- row but skips auto-scoring and flags it for manual review instead of emitting a
-- misleading score.
--
--   * needs_manual_review (nullable) is true when the transcript was flagged.
--   * flag_reasons (nullable) holds the human-readable reasons it was flagged.
--
-- Both are null for pasted text/email submissions and for clean audio that was
-- auto-scored normally. Idempotent (IF NOT EXISTS) so re-running is safe.

ALTER TABLE "real_conversations" ADD COLUMN IF NOT EXISTS "needs_manual_review" boolean;--> statement-breakpoint
ALTER TABLE "real_conversations" ADD COLUMN IF NOT EXISTS "flag_reasons" text;
