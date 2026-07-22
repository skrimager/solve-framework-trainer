-- Demo-activation drip. A dedicated table (separate from lead_drip_emails and
-- prospect_outreach) so the day 0/1/3 sequence auto-enrolled when a demo visitor
-- verifies their code is never mixed in with the inbound welcome drip or the
-- admin OUTBOUND prospecting batches. Keyed to demo_signups (not contacts),
-- because demo visitors never become contacts. Step 1 is the day-0 welcome
-- (recorded as sent, dispatched inline at verify), steps 2 and 3 are the day-1
-- and day-3 follow-ups the shared background sender delivers when scheduled_at
-- has passed. Only NEW verifications are enrolled; existing signups are never
-- backfilled.

CREATE TABLE IF NOT EXISTS "demo_drip_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"signup_id" integer NOT NULL,
	"sequence_step" integer NOT NULL,
	"email_subject" text NOT NULL,
	"email_body" text NOT NULL,
	"scheduled_at" text,
	"sent_at" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	CONSTRAINT "demo_drip_emails_signup_id_demo_signups_id_fk" FOREIGN KEY ("signup_id") REFERENCES "demo_signups"("id") ON DELETE no action ON UPDATE no action
);

-- One-click opt-out mirror for demo recipients of the new lifecycle emails. The
-- authoritative send-time gate is email_suppressions (see 0024); this column
-- keeps a demo_signups row self-describing for admin export.
ALTER TABLE "demo_signups" ADD COLUMN IF NOT EXISTS "unsubscribed" boolean DEFAULT false NOT NULL;
