import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./storage";

// Bring the connected database up to the latest schema before the app serves
// traffic. Drizzle records applied migrations in __drizzle_migrations, so this
// is idempotent and safe to run on every boot. The 0000 baseline uses
// CREATE TABLE IF NOT EXISTS so it no-ops against a database provisioned by an
// earlier `drizzle-kit push` that never recorded a migration. Billing columns
// (offices/users) and the billing_events table live in 0003_billing.
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), "migrations");
  await migrate(db, { migrationsFolder });
  console.log("Database migrations applied (schema up to date).");
}
