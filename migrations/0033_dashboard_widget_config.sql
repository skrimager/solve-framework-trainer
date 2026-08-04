-- Purely additive: one nullable JSON-text column on the existing offices
-- table, storing per-office Command Center widget visibility preferences
-- ({ [widgetKey: string]: boolean }). NULL means no preferences saved yet,
-- which the application layer treats as "every widget visible" (see
-- DEFAULT_DASHBOARD_WIDGET_CONFIG / resolveDashboardWidgetConfig in
-- server/routes.ts). No existing column, index, or constraint is touched.
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "dashboard_widget_config" text;
