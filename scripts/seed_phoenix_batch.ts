// Load the Phoenix, AZ discovery batch (server/phoenixBatch.ts) into the
// prospect_* tables: one prospect_searches row, its prospect_companies (each
// tagged with its own segment), their prospect_contacts, and the generated
// three-step draft outreach per contact — exactly what the batch route does,
// but with per-company segments the route's single-segment payload can't express.
//
//   npx tsx scripts/seed_phoenix_batch.ts --dry-run   # print the plan, no DB
//   npx tsx scripts/seed_phoenix_batch.ts             # persist (needs DATABASE_URL)
//
// Inserts in FK order (search → company → contact → outreach). Re-running
// creates a fresh batch; it does not de-dupe, so run once per intended load.

import { planPhoenixBatch, distinctSegments, phoenixBatchSeed } from "../server/phoenixBatch";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const plan = planPhoenixBatch();
  const segments = distinctSegments(phoenixBatchSeed);

  console.log(`Phoenix, AZ discovery batch`);
  console.log(`  geography:  ${phoenixBatchSeed.geography}`);
  console.log(`  source:     ${phoenixBatchSeed.source}`);
  console.log(`  companies:  ${plan.companies.length}`);
  console.log(`  contacts:   ${plan.contactCount}`);
  console.log(`  outreach:   ${plan.outreachCount} (3 draft steps/contact)`);
  console.log(`  segments (${segments.length}):`);
  for (const s of segments) console.log(`    - ${s}`);
  for (const c of plan.companies) {
    console.log(`  · ${c.company.name} [${c.company.segment}] — ${c.contacts.length} contact(s)`);
  }

  if (dryRun) {
    console.log(`\n--dry-run: nothing written.`);
    process.exit(0);
  }

  const { storage } = await import("../server/storage");
  const now = new Date().toISOString();

  const search = await storage.createProspectSearch({ ...plan.search, runAt: now });
  let contactCount = 0;
  let outreachCount = 0;

  for (const pc of plan.companies) {
    const company = await storage.createProspectCompany({ ...pc.company, discoveredAt: now });
    for (const pct of pc.contacts) {
      const contact = await storage.createProspectContact({
        ...pct.contact,
        companyId: company.id,
        createdAt: now,
      });
      contactCount += 1;
      for (const o of pct.outreach) {
        await storage.createProspectOutreach({ ...o, contactId: contact.id, searchId: search.id });
        outreachCount += 1;
      }
    }
  }

  console.log(
    `\nInserted batch searchId=${search.id}: ${plan.companies.length} companies, ` +
      `${contactCount} contacts, ${outreachCount} draft outreach rows (status pending_review).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
