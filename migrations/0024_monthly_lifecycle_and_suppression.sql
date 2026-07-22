-- Monthly "Practice makes money!" lifecycle email + the one-click unsubscribe
-- suppression list shared by all the new outbound lifecycle emails (demo drip +
-- monthly). email_suppressions is the authoritative, by-email send-time gate and
-- covers both demo signups and paying users with a single lookup. Neither table
-- touches the existing inbound/outbound drips, which are out of scope.

CREATE TABLE IF NOT EXISTS "monthly_lifecycle_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" integer NOT NULL,
	"email" text NOT NULL,
	"email_subject" text NOT NULL,
	"email_body" text NOT NULL,
	"scheduled_at" text NOT NULL,
	"sent_at" text,
	"status" text DEFAULT 'scheduled' NOT NULL
);

CREATE TABLE IF NOT EXISTS "email_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"suppressed_at" text NOT NULL,
	CONSTRAINT "email_suppressions_email_unique" UNIQUE("email")
);
