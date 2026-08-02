-- Purely additive: one nullable column on the existing message_coach_signups
-- table. Null means "not yet synced (or sync failed)"; a timestamp means the
-- email was successfully added to the Resend "Message Coach Leads" audience.
-- No existing column, index, or constraint is touched.
ALTER TABLE "message_coach_signups" ADD COLUMN IF NOT EXISTS "resend_synced_at" text;
