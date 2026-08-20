-- Locked self-serve pricing metadata and one-time 14-Day Team Evaluation records.
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "command_center_entitled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "pricing_tier" text;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "seat_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "billing_interval" text;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "evaluation_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "current_evaluation_purchase_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "evaluation_purchase_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "evaluation_access_expires_at" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_purchases" (
  "id" serial PRIMARY KEY NOT NULL,
  "office_id" integer NOT NULL REFERENCES "offices"("id"),
  "stripe_customer_id" text NOT NULL,
  "stripe_checkout_session_id" text NOT NULL UNIQUE,
  "stripe_payment_intent_id" text UNIQUE,
  "base_amount_cents" integer NOT NULL,
  "additional_participant_amount_cents" integer NOT NULL,
  "total_amount_cents" integer NOT NULL,
  "participant_count" integer NOT NULL,
  "evaluation_started_at" text NOT NULL,
  "evaluation_ends_at" text NOT NULL,
  "conversion_status" text DEFAULT 'not_converted' NOT NULL,
  "converted_at" text,
  "converted_stripe_subscription_id" text UNIQUE,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_evaluation_purchase_id_evaluation_purchases_id_fk" FOREIGN KEY ("evaluation_purchase_id") REFERENCES "evaluation_purchases"("id");--> statement-breakpoint
UPDATE "offices" SET "command_center_entitled" = true WHERE "subscription_status" IN ('active', 'trialing');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_credit_ledger" (
  "id" serial PRIMARY KEY NOT NULL,
  "evaluation_purchase_id" integer NOT NULL UNIQUE REFERENCES "evaluation_purchases"("id"),
  "office_id" integer NOT NULL REFERENCES "offices"("id"),
  "currency" text DEFAULT 'usd' NOT NULL,
  "credit_amount_available_cents" integer NOT NULL,
  "redeemed" boolean DEFAULT false NOT NULL,
  "redeemed_at" text,
  "redeemed_stripe_subscription_id" text UNIQUE,
  "redeemed_stripe_invoice_id" text UNIQUE,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
