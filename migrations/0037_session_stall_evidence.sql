-- Structured coaching evidence is recorded only for dedicated Stall & Excuse
-- Handling sessions. Nullable so every historic and non-stall session remains
-- unchanged.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stall_evidence" text;
