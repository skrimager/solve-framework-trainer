// One-time script: backfills briefing text into already-seeded scenario rows
// (seed.ts only inserts missing scenarios by slug, so existing rows keep their
// old empty briefing until this runs). Safe to re-run.
import { scenarios } from "../server/seed";
import { storage } from "../server/storage";

async function main() {
  const existing = await storage.listScenarios();
  const bySlug = new Map(existing.map((s) => [s.slug, s]));
  let updated = 0;
  for (const scenario of scenarios) {
    const row = bySlug.get(scenario.slug);
    if (row && scenario.briefing && row.briefing !== scenario.briefing) {
      await storage.updateScenario(row.id, { briefing: scenario.briefing });
      updated++;
    }
  }
  console.log(`Backfilled briefing text for ${updated} scenario(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
