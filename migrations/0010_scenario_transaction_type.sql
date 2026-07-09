-- Real-estate transaction-type classifier (Part 2). Adds an INTERNAL-ONLY
-- column that is never surfaced in any trainee-facing UI or scenario picker —
-- read only by the scoring/rubric logic to pick the right close-expectation
-- baseline (see closeExpectationForTransactionType in server/llm.ts). NULL for
-- every non-real-estate / non-manufactured-housing scenario. Backfills the
-- existing rows by slug so live databases match the seed classification.
-- Idempotent (ADD COLUMN IF NOT EXISTS + slug-scoped UPDATEs).
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "transaction_type" text;--> statement-breakpoint
UPDATE "scenarios" SET "transaction_type" = 'manufactured_dealer' WHERE "vertical" = 'manufactured_housing';--> statement-breakpoint
UPDATE "scenarios" SET "transaction_type" = 'manufactured_community' WHERE "vertical" = 'manufactured_housing_community';--> statement-breakpoint
UPDATE "scenarios" SET "transaction_type" = 're_listing_agent' WHERE "slug" = 'real-estate-downsizing-empty-nesters';--> statement-breakpoint
UPDATE "scenarios" SET "transaction_type" = 're_buyer_agent' WHERE "slug" IN ('real-estate-relocating-professional', 'real-estate-first-time-buyer-anxious', 'real-estate-investor-multi-unit', 'real-estate-aimless-browser-no-vision', 'real-estate-demo-buyer-30-days');
