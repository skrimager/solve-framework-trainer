ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "office_setup_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"contact_id" integer,
	"email" text NOT NULL,
	"name" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	CONSTRAINT "office_setup_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paid_office_signups" (
	"id" serial PRIMARY KEY NOT NULL,
	"office_id" integer,
	"office_name" text NOT NULL,
	"seat_count" integer NOT NULL,
	"dashboard" boolean NOT NULL DEFAULT false,
	"stripe_subscription_id" text,
	"contact_email" text,
	"created_at" text NOT NULL
);
