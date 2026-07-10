-- Opportunity Intelligence: admin-only outbound lead-gen + email-drip tables for
-- SOLVE Framework's own marketing. Fully separate from trainee data and the
-- inbound `contacts` CRM. `segment` and `geography` are free-text (no enums) so
-- new markets/verticals need no migration.

CREATE TABLE IF NOT EXISTS "prospect_searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"segment" text NOT NULL,
	"geography" text NOT NULL,
	"run_at" text NOT NULL,
	"results_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prospect_companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"segment" text NOT NULL,
	"city" text,
	"state" text,
	"employee_count" integer,
	"signal_type" text NOT NULL,
	"signal_detail" text NOT NULL,
	"source" text NOT NULL,
	"discovered_at" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prospect_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"full_name" text NOT NULL,
	"title" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"linkedin_url" text,
	"created_at" text NOT NULL,
	CONSTRAINT "prospect_contacts_company_id_prospect_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "prospect_companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prospect_outreach" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer NOT NULL,
	"search_id" integer NOT NULL,
	"sequence_step" integer NOT NULL,
	"email_subject" text NOT NULL,
	"email_body" text NOT NULL,
	"scheduled_at" text,
	"sent_at" text,
	"status" text DEFAULT 'draft' NOT NULL,
	CONSTRAINT "prospect_outreach_contact_id_prospect_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "prospect_outreach_search_id_prospect_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "prospect_searches"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prospect_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"event_detail" text NOT NULL,
	"occurred_at" text NOT NULL,
	CONSTRAINT "prospect_activity_contact_id_prospect_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE no action ON UPDATE no action
);
