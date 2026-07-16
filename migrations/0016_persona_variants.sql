-- Structured, per-session persona variation. Splits the single freeform
-- customer_persona into a FIXED core (identity, situation, opening stance, and
-- the designed ideal-outcome behavior that must never change) plus three JSON
-- string-array pools a session draws from at start: personality/communication
-- style, primary motivation driver, and objections. The chosen rendition is
-- stored resolved on sessions.persona_variant so every turn of one conversation
-- reconstructs the same customer, while a fresh session gets a different one.
-- The legacy customer_persona column is deliberately kept for rollback and is no
-- longer used for prompt construction once persona_core is populated (backfilled
-- idempotently from the seed on boot). All columns default to empty so existing
-- rows and any future scenario are safe until populated. Idempotent.
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "persona_core" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "personality_variants" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "motivation_variants" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "objection_pool" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "persona_variant" text;
