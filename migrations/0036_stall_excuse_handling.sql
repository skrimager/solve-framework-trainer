-- Internal-only tag used by the dedicated Stall & Excuse Handling practice
-- module. Nullable so every existing scenario row remains unchanged.
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "stall_type" text;
