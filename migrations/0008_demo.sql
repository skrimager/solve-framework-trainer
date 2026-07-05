-- Public "Free Voice Demo" tables. `demo_signups` holds one row per email with
-- the verification-code state and the all-time usage counter enforcing the
-- 3-free-sessions-per-email limit. `demo_sessions` holds each anonymous demo
-- roleplay attempt, kept separate from the seat-gated `sessions` table so demo
-- traffic never touches office analytics, seat billing, or level progression.

CREATE TABLE IF NOT EXISTS "demo_signups" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code" text,
	"code_expires_at" text,
	"verified" boolean DEFAULT false NOT NULL,
	"sessions_used" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"last_sent_at" text,
	CONSTRAINT "demo_signups_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"signup_id" integer NOT NULL,
	"email" text NOT NULL,
	"scenario_id" integer NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"transcript" text DEFAULT '[]' NOT NULL,
	"score" integer,
	"rubric_scores" text,
	"feedback" text,
	"created_at" text NOT NULL,
	"completed_at" text,
	CONSTRAINT "demo_sessions_signup_id_demo_signups_id_fk" FOREIGN KEY ("signup_id") REFERENCES "demo_signups"("id") ON DELETE no action ON UPDATE no action
);
