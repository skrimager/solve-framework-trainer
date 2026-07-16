-- Fair-use practice cap: track how much practice time each session consumed so a
-- consultant's per-calendar-month total (both text and voice sessions) can be
-- summed and capped. `duration_seconds` is populated when a session reaches a
-- terminal state (completed or saved-for-later); null while in progress. The
-- monthly sum is bucketed on `created_at`, so the composite index on
-- (user_id, created_at) keeps that a targeted lookup rather than a table scan.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "duration_seconds" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_created_at_idx" ON "sessions" ("user_id","created_at");
