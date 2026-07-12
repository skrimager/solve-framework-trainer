-- Inbound-lead welcome drip. A dedicated table (separate from prospect_outreach)
-- so the day 0/3/7 sequence auto-enrolled from POST /api/leads is never mixed in
-- with the admin OUTBOUND prospecting batches. Step 1 is the day-0 welcome
-- (recorded as sent, dispatched inline at capture), steps 2 and 3 are the day-3
-- and day-7 follow-ups the shared background sender delivers when scheduled_at
-- has passed. Only NEW inbound leads are enrolled; historical contacts are never
-- backfilled.

CREATE TABLE IF NOT EXISTS "lead_drip_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer NOT NULL,
	"sequence_step" integer NOT NULL,
	"email_subject" text NOT NULL,
	"email_body" text NOT NULL,
	"scheduled_at" text,
	"sent_at" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	CONSTRAINT "lead_drip_emails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE no action ON UPDATE no action
);
