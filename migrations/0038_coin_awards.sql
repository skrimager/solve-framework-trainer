-- Durable performance-achievement ledger for the manager command center.
-- The unique constraint is deliberately at the database layer so repeated
-- advancement checks cannot double-award a consultant's track/tier coin.
CREATE TABLE IF NOT EXISTS "coin_awards" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "office_id" integer NOT NULL REFERENCES "offices"("id"),
  "track" text NOT NULL,
  "tier" text NOT NULL,
  "earned_at" text NOT NULL,
  CONSTRAINT "coin_awards_user_track_tier_unique" UNIQUE("user_id", "track", "tier")
);

CREATE INDEX IF NOT EXISTS "coin_awards_office_user_idx" ON "coin_awards" ("office_id", "user_id");
