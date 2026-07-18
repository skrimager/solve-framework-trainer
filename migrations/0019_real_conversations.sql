-- Real Conversation Scoring (Phase 1). A rep pastes a real discovery
-- conversation (text/SMS/chat or an email thread) and it is scored against the
-- SAME SOLVE rubric engine used for practice sessions. Kept in its own table so
-- real-world submissions never mix with practice `sessions`, office analytics, or
-- level progression.
--
-- The schema is laid down to support later phases without another reshape:
--   * submission_type leaves room for 'audio' (Phase 2) alongside 'text_chat' | 'email'.
--   * original_audio_filename (nullable) is reserved for Phase 2 audio upload.
--   * submission_counted_for_cap (nullable) is reserved for Phase 3 fair-use capping.
--   * field_verified_eligible (nullable) is reserved for the Phase 4 "Field Verified" badge.
-- No Phase 1 logic reads/writes those reserved columns yet.
--
-- Consent is mandatory: consent_accepted + consent_accepted_at capture the
-- timestamped consent record (submitter = submitted_by_user_id, submission id =
-- id) required before a submission is accepted.
--
-- Idempotent (IF NOT EXISTS) so re-running is safe.
CREATE TABLE IF NOT EXISTS "real_conversations" (
  "id" serial PRIMARY KEY NOT NULL,
  "submitted_by_user_id" integer NOT NULL,
  "subject_rep_user_id" integer NOT NULL,
  "office_id" integer NOT NULL,
  "submission_type" text NOT NULL,
  "raw_transcript" text NOT NULL,
  "original_audio_filename" text,
  "overall_score" integer,
  "rubric_scores" text,
  "feedback" text,
  "stalled_step" text,
  "consent_accepted" boolean DEFAULT false NOT NULL,
  "consent_accepted_at" text,
  "created_at" text NOT NULL,
  "submission_counted_for_cap" boolean,
  "field_verified_eligible" boolean
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "real_conversations_subject_rep_idx" ON "real_conversations" ("subject_rep_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "real_conversations_office_idx" ON "real_conversations" ("office_id");
