-- Adds self-service forgot-password / forgot-username support for the shared
-- `users` table (manager/office accounts today; consultant/qa rows share the
-- table but are not exposed through the new manager recovery endpoints).
--
-- `email` is nullable: existing accounts were provisioned before any recovery
-- flow existed and have no email on file. A row with a null email simply never
-- matches a lookup — POST /api/manager/forgot-password and
-- POST /api/manager/forgot-username still return their generic "if an account
-- exists" response either way (no enumeration signal).
--
-- `password_reset_token` + `password_reset_expires_at` back a single-use,
-- random, expiring token (see server/routes.ts). The token column is unique so
-- a lookup by token is a normal indexed equality lookup; it is cleared
-- (set back to NULL) the moment it is redeemed or superseded by a newer
-- request, so it can never be replayed.
--
-- No data is dropped and no existing rows change: every new column backfills
-- to NULL.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_token" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_expires_at" text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_password_reset_token_unique'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_password_reset_token_unique" UNIQUE ("password_reset_token");
  END IF;
END $$;
