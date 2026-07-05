-- Evolve the marketing `leads` table into the unified CRM `contacts` table and
-- add the `contact_events` timeline. Data-preserving: the rename keeps all
-- existing rows/ids; new columns backfill to the Phase 1 defaults.

ALTER TABLE "leads" RENAME TO "contacts";
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "type" text DEFAULT 'general' NOT NULL;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "owner" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "follow_up_date" text;
--> statement-breakpoint
-- `source` existed as a nullable column; backfill existing rows to 'website'
-- then tighten it to NOT NULL DEFAULT 'website' to match the new schema.
UPDATE "contacts" SET "source" = 'website' WHERE "source" IS NULL;
--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "source" SET DEFAULT 'website';
--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "source" SET NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"description" text NOT NULL,
	"actor" text,
	"created_at" text NOT NULL,
	CONSTRAINT "contact_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- Seed one initial "Lead created" event per pre-existing contact so no timeline
-- starts empty. Uses each row's original created_at as the event timestamp.
INSERT INTO "contact_events" ("contact_id", "event_type", "description", "actor", "created_at")
SELECT "id", 'created', 'Lead created', 'system', "created_at" FROM "contacts";
