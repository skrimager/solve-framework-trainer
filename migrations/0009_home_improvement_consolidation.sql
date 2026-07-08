-- Vertical consolidation (Part 1): collapse the separate home-improvement
-- project topics into a single trainee-facing "home_improvement" vertical, and
-- merge the two outdoor topics into one "pool_landscaping" vertical. The
-- individual scenarios are preserved as distinct rows WITHIN each consolidated
-- vertical — only their `vertical` grouping label changes so the scenario
-- picker shows fewer top-level categories. Idempotent (re-running is a no-op
-- once values are already consolidated).
UPDATE "scenarios" SET "vertical" = 'home_improvement' WHERE "vertical" IN ('kitchen_remodel', 'bathroom_remodel');--> statement-breakpoint
UPDATE "scenarios" SET "vertical" = 'pool_landscaping' WHERE "vertical" IN ('pool_installation', 'landscaping');
