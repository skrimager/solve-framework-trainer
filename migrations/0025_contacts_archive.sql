-- Add soft-archive support to the CRM `contacts` table. `archived_at` is a
-- nullable ISO timestamp: null means the contact is active, a value means it was
-- archived (hidden from the default list but fully reversible via unarchive).
-- No data is dropped and no dependent tables (contact_events, lead_drip_emails,
-- office_setup_tokens) are touched. Existing rows backfill to NULL (active).

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "archived_at" text;
