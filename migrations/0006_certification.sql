ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consulting_certified" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consulting_certified_at" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "leadership_certified" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "leadership_certified_at" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "certification_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"track" text NOT NULL,
	"started_at" text NOT NULL,
	"question_ids" text NOT NULL DEFAULT '[]',
	"written_score" integer,
	"written_passed" boolean NOT NULL DEFAULT false,
	"scenario_session_id" integer,
	"scenario_score" integer,
	"scenario_passed" boolean NOT NULL DEFAULT false,
	"overall_passed" boolean NOT NULL DEFAULT false,
	"completed_at" text
);
