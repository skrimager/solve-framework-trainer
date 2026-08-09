-- Scenario versions begin at 1 for every existing scenario: the DEFAULT is
-- correct for those rows, so no backfill is needed. Session versions remain
-- null for every historic row because their exact scenario/rubric versions are
-- unknown and must never be fabricated.
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "scenario_version" integer;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "rubric_version" integer;
