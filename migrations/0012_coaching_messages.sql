-- SOLVE Coach follow-up Q&A: a per-attempt conversational thread a trainee can
-- have with the AI after rubric feedback is shown. Scoped to one session attempt
-- and trainee; soft-cleared (cleared=true) when the trainee starts a new attempt
-- so the previous attempt's thread never reappears. Managers/QA read but never
-- post (authorship fixed to 'trainee' | 'coach').

CREATE TABLE IF NOT EXISTS "coaching_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"cleared" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
