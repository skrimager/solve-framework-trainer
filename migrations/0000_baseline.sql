CREATE TABLE IF NOT EXISTS "scenarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"vertical" text NOT NULL,
	"description" text NOT NULL,
	"customer_persona" text NOT NULL,
	"difficulty" text NOT NULL,
	"briefing" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "scenarios_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"scenario_id" integer NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"transcript" text DEFAULT '[]' NOT NULL,
	"score" integer,
	"rubric_scores" text,
	"feedback" text,
	"created_at" text NOT NULL,
	"completed_at" text,
	"saved_at" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"current_level" text DEFAULT 'beginner' NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
