import { sql } from "drizzle-orm";
import { db } from "./storage";

// This baseline has no migrations folder / migrate-on-boot step. Rather than
// introduce a migration toolchain, we self-heal the schema idempotently at boot:
// every statement uses IF NOT EXISTS so it is safe to run against both a fresh
// database and an already-migrated production one. Called before seed().
export async function runBillingMigration(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
  `);
  await db.execute(sql`
    ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text;
  `);
  await db.execute(sql`
    ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "subscription_status" text NOT NULL DEFAULT 'incomplete';
  `);
  await db.execute(sql`
    ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "manager_item_id" text;
  `);
  await db.execute(sql`
    ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "seat_item_id" text;
  `);
  await db.execute(sql`
    ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "active_seat_count" integer NOT NULL DEFAULT 0;
  `);

  await db.execute(sql`
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "seat_active" boolean NOT NULL DEFAULT false;
  `);
  await db.execute(sql`
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_demo_account" boolean NOT NULL DEFAULT false;
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "billing_events" (
      "id" serial PRIMARY KEY,
      "stripe_event_id" text NOT NULL UNIQUE,
      "event_type" text NOT NULL,
      "office_id" integer,
      "payload_summary" text,
      "created_at" text NOT NULL
    );
  `);

  // Backfill for existing production data. seed() only touches brand-new rows, so on
  // an upgrade the pre-existing Demo Office and QA accounts would otherwise default to
  // locked/non-demo. Keep the whole Demo Office and every QA account permanently free.
  await db.execute(sql`
    UPDATE "offices" SET "subscription_status" = 'active' WHERE "invite_code" = 'DEMO2024';
  `);
  await db.execute(sql`
    UPDATE "users" SET "is_demo_account" = true, "seat_active" = true
    WHERE "office_id" IN (SELECT "id" FROM "offices" WHERE "invite_code" = 'DEMO2024');
  `);
  await db.execute(sql`
    UPDATE "users" SET "is_demo_account" = true, "seat_active" = true WHERE "role" = 'qa';
  `);
}
