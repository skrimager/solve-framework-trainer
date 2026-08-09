-- Internal-only product category for the SaaS discovery scenarios. The column
-- remains nullable because every non-SaaS scenario must have no product tag.
-- Existing SaaS rows are tagged here so the data is usable immediately on
-- deploy; server/seed.ts reconciles their refreshed opening personas as well.
ALTER TABLE "scenarios" ADD COLUMN IF NOT EXISTS "product" text;

UPDATE "scenarios"
SET "product" = CASE "slug"
  WHEN 'saas-switching-from-spreadsheets' THEN 'crm'
  WHEN 'saas-champion-building-internal-buyin' THEN 'ai_roleplay_platform'
  ELSE "product"
END
WHERE "vertical" = 'saas';

-- Every SaaS scenario needs one of the approved product tags; every other
-- vertical must remain untagged. This guarantees the tag stays internal data,
-- not a generic metadata field that leaks into unrelated scenarios.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scenarios_product_scope_check'
  ) THEN
    ALTER TABLE "scenarios"
      ADD CONSTRAINT "scenarios_product_scope_check"
      CHECK (
        (
          "vertical" = 'saas' AND "product" IN (
            'crm',
            'website_builder',
            'ai_sales_automation',
            'ai_roleplay_platform',
            'email_drip_automation'
          )
        ) OR (
          "vertical" <> 'saas' AND "product" IS NULL
        )
      );
  END IF;
END $$;
