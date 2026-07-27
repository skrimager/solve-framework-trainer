-- One-time $4.99 purchases of an individual demo practice session.
--
-- One row per Stripe Checkout Session (mode: 'payment', quantity 1) rather than
-- a counter column on demo_signups, so every purchase keeps its own audit trail
-- and stripe_checkout_session_id can serve as the payment webhook's natural
-- idempotency key. Entirely separate from office subscription billing: a demo
-- visitor is anonymous, has no login, no office and no Stripe Customer.
--
-- status: 'pending' (checkout created, payment unconfirmed) -> 'paid' (webhook
-- confirmed; one unconsumed credit) -> 'consumed' (the credited session started,
-- linked via consumed_by_demo_session_id).
--
-- demo_sessions.paid_session_id is the other half of the link: NULL means the
-- one free session, non-NULL names the credit that funded it. That column is
-- what the voice gate reads, so voice access is never derived from a session
-- ordinal. Every pre-existing demo_sessions row stays correct with no backfill.
--
-- Idempotent (IF NOT EXISTS) per the existing migration convention.
CREATE TABLE IF NOT EXISTS "demo_paid_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "signup_id" integer NOT NULL REFERENCES "demo_signups"("id"),
  "email" text NOT NULL,
  "stripe_checkout_session_id" text NOT NULL,
  "stripe_payment_intent_id" text,
  "amount_total" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" text NOT NULL,
  "paid_at" text,
  "consumed_at" text,
  "consumed_by_demo_session_id" integer REFERENCES "demo_sessions"("id"),
  CONSTRAINT "demo_paid_sessions_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);--> statement-breakpoint
-- Backs the credit lookup on the session-start path (signup + status).
CREATE INDEX IF NOT EXISTS "demo_paid_sessions_signup_idx" ON "demo_paid_sessions" ("signup_id");--> statement-breakpoint
ALTER TABLE "demo_sessions" ADD COLUMN IF NOT EXISTS "paid_session_id" integer REFERENCES "demo_paid_sessions"("id");
