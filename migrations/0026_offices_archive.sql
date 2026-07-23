-- Add soft-archive support to the `offices` table, mirroring the
-- `contacts.archived_at` convention from migration 0025. `archived_at` is a
-- nullable ISO timestamp: null means the office is active, a value means it was
-- archived (hidden from the default Sales list but fully reversible via
-- unarchive). No data is dropped and no dependent tables (users, academy_credits,
-- real_conversations, paid_office_signups, billing_events) are touched. Existing
-- rows backfill to NULL (active).

ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "archived_at" text;
