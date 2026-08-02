-- Purely additive: four nullable/defaulted columns on the existing
-- message_coach_signups table, matching the exact shape of demo_signups'
-- verification columns (code, code_expires_at, verified, last_sent_at). This
-- gates access to the anonymous scoring flow behind a 6-digit emailed code;
-- it does not touch freeScoreUsedAt or any billing/economics column.
-- No existing column, index, or constraint is touched.
ALTER TABLE "message_coach_signups" ADD COLUMN IF NOT EXISTS "code" text;
ALTER TABLE "message_coach_signups" ADD COLUMN IF NOT EXISTS "code_expires_at" text;
ALTER TABLE "message_coach_signups" ADD COLUMN IF NOT EXISTS "verified" boolean NOT NULL DEFAULT false;
ALTER TABLE "message_coach_signups" ADD COLUMN IF NOT EXISTS "last_sent_at" text;
