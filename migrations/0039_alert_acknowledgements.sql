-- Manager/QA acknowledgement state for derived Command Center alerts.
-- An acknowledgement is scoped to its office, consultant, and reason. It is
-- retained as an audit record; the application considers it active only until
-- a newer relevant completed session supersedes it.
CREATE TABLE IF NOT EXISTS "alert_acknowledgements" (
  "id" serial PRIMARY KEY NOT NULL,
  "office_id" integer NOT NULL REFERENCES "offices"("id") ON DELETE CASCADE,
  "consultant_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "acknowledged_by" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "acknowledged_at" text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_acknowledgements_office_idx"
  ON "alert_acknowledgements" ("office_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_acknowledgements_consultant_reason_idx"
  ON "alert_acknowledgements" ("consultant_id", "reason");
