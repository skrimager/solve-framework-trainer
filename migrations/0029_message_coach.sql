-- Message Coach v1 — the public "score and rewrite my outreach message" tool.
--
-- Purely additive: three new tables, no ALTER of anything that already exists.
-- The whole feature is dark unless MESSAGE_COACH_ENABLED is 'true', so these
-- tables simply sit empty until it is switched on.
--
-- These rows are deliberately NOT joined to demo_signups. A Message Coach
-- visitor is anonymous in the same way a demo visitor is (email only, no login,
-- no office, no seat), but the two funnels meter different things and share no
-- quota, so one signup row for both would make either limit depend on the other.
--
-- Idempotent (IF NOT EXISTS) per the existing migration convention.

-- One row per email that has used the free tool. free_score_used_at IS the
-- enforcement for "one free score per email": NULL means it is still available,
-- any timestamp means it is spent for good.
CREATE TABLE IF NOT EXISTS "message_coach_signups" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "name" text,
  "created_at" text NOT NULL,
  "free_score_used_at" text,
  CONSTRAINT "message_coach_signups_email_unique" UNIQUE("email")
);--> statement-breakpoint

-- One row per scored message, whichever path paid for it. Both foreign keys are
-- nullable because the three sources fill different ones: a free/paid score has
-- a signup_id and no office_id, a member score has an office_id and no
-- signup_id. office_id exists only so usage-by-office can be reported later
-- without a backfill; nothing reads it yet.
CREATE TABLE IF NOT EXISTS "message_coach_scores" (
  "id" serial PRIMARY KEY NOT NULL,
  "signup_id" integer REFERENCES "message_coach_signups"("id"),
  "office_id" integer REFERENCES "offices"("id"),
  "industry" text,
  "message_text" text NOT NULL,
  "score" integer NOT NULL,
  "stalled_step" text NOT NULL,
  "coaching" text NOT NULL,
  "rewrite" text NOT NULL,
  "source" text NOT NULL,
  "created_at" text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_coach_scores_signup_idx" ON "message_coach_scores" ("signup_id");--> statement-breakpoint

-- One row per $4.99 additional-score purchase, mirroring demo_paid_sessions
-- field for field. Only the consumed_by_* target differs, because a Message
-- Coach credit buys a score row rather than a practice session.
--
-- status: 'pending' (checkout created, payment unconfirmed) -> 'paid' (webhook
-- confirmed; one unconsumed credit) -> 'consumed' (spent, linked via
-- consumed_by_score_id).
CREATE TABLE IF NOT EXISTS "message_coach_paid_purchases" (
  "id" serial PRIMARY KEY NOT NULL,
  "signup_id" integer NOT NULL REFERENCES "message_coach_signups"("id"),
  "email" text NOT NULL,
  "stripe_checkout_session_id" text NOT NULL,
  "stripe_payment_intent_id" text,
  "amount_total" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" text NOT NULL,
  "paid_at" text,
  "consumed_at" text,
  "consumed_by_score_id" integer REFERENCES "message_coach_scores"("id"),
  CONSTRAINT "message_coach_paid_purchases_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);--> statement-breakpoint
-- Backs the credit lookup on the score path (signup + status).
CREATE INDEX IF NOT EXISTS "message_coach_paid_purchases_signup_idx" ON "message_coach_paid_purchases" ("signup_id");
