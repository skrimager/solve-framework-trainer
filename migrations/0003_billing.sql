ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "subscription_status" text NOT NULL DEFAULT 'incomplete';--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "manager_item_id" text;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "seat_item_id" text;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "active_seat_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "seat_active" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_demo_account" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"office_id" integer,
	"payload_summary" text,
	"created_at" text NOT NULL,
	CONSTRAINT "billing_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
UPDATE "offices" SET "subscription_status" = 'active' WHERE "invite_code" = 'DEMO2024';--> statement-breakpoint
UPDATE "users" SET "is_demo_account" = true, "seat_active" = true
WHERE "office_id" IN (SELECT "id" FROM "offices" WHERE "invite_code" = 'DEMO2024');--> statement-breakpoint
UPDATE "users" SET "is_demo_account" = true, "seat_active" = true WHERE "role" = 'qa';
