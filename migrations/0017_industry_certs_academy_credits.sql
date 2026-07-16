-- Per-industry certification tracking + SOLVE Success Investment credits/ranks.
--
-- 1. users.seat_activated_at: ISO timestamp of when a user's paid seat first went
--    active. Backs the "seat active for at least 60 days" credit-earning gate.
--    Nullable so legacy rows (and users who never held a paid seat) are safe.
-- 2. industry_certifications: per-(user, track, vertical) progression, tracked
--    independently of the legacy per-track flags on users. Unique on
--    (user_id, track, vertical) so there is exactly one progress row per industry
--    per track.
-- 3. academy_credits: the SOLVE Success Investment credit ledger. One row per
--    credit-earning event (a consultant reaching one of the four sequential
--    Academy levels). Unique on (user_id, level) so a level is awarded at most
--    once per consultant, naturally capping lifetime credit at $200.
-- All idempotent (IF NOT EXISTS) so re-running is safe.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "seat_activated_at" text;--> statement-breakpoint
ALTER TABLE "certification_attempts" ADD COLUMN IF NOT EXISTS "vertical" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "industry_certifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "track" text NOT NULL,
  "vertical" text NOT NULL,
  "current_level" text DEFAULT 'beginner' NOT NULL,
  "certified_at" text
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "academy_credits" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "office_id" integer NOT NULL,
  "level" integer NOT NULL,
  "amount_cents" integer DEFAULT 5000 NOT NULL,
  "earned_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "industry_certifications_user_track_vertical_uniq" ON "industry_certifications" ("user_id","track","vertical");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "academy_credits_user_level_uniq" ON "academy_credits" ("user_id","level");
