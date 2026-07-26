-- Marks which demo flow created a demo_sessions row.
--   flow  NULL  the original free-demo flow (/api/demo/*). Every pre-existing
--               row keeps this value, so no backfill is needed and the v1 flow
--               is completely unaffected.
--         'v2'  the industry-choice flow (/api/demo-v2/*), which lets a visitor
--               pick Auto or Real Estate per session and guarantees they never
--               get the same scenario twice within an industry.
-- The v2 no-repeat picker scopes its exclusion set to flow = 'v2' rows for the
-- email, so this column is what keeps the two flows' histories independent. It
-- also lets admin views tell v1 and v2 demo traffic apart without a schema fork.
-- Idempotent (ADD COLUMN IF NOT EXISTS) per the existing migration convention.
ALTER TABLE "demo_sessions" ADD COLUMN IF NOT EXISTS "flow" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_sessions_flow_idx" ON "demo_sessions" ("flow");
