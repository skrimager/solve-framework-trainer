// One-off, local-dev-only script that backdates a handful of extra practice
// sessions for the existing seed-demo-roster.ts personas so the Demo Office
// has session history stretching back to March 2026. This is ONLY meant to
// produce realistic-looking data for local screenshots of the new Command
// Center date range picker (its "All time" / custom-range presets need
// multi-month history to actually demonstrate anything). It does not modify
// scripts/seed-demo-roster.ts and is safe to skip in any real environment.
//
// Run against whatever DATABASE_URL points at:
//   DATABASE_URL=postgres://... npx tsx scripts/seed-demo-history-extend.ts
import { storage } from "../server/storage";
import type { InsertSession, Scenario } from "@shared/schema";

const DEMO_OFFICE_INVITE_CODE = "DEMO2024";
const CONSULTING_VERTICAL = "home_improvement";

function scenarioTrack(track: string | null | undefined): string {
  return track === "leadership" ? "leadership" : "consulting";
}

// Backdated sessions for existing personas, spread from March through June
// 2026 so a manager switching the date range picker to "All time" or a custom
// March-start range sees a materially different (larger, older) window than
// the 7/30/90-day presets.
const HISTORICAL: { username: string; level: "beginner" | "intermediate" | "advanced"; score: number; date: string }[] = [
  { username: "sofia.castellano", level: "beginner", score: 84, date: "2026-03-02T09:15:00.000Z" },
  { username: "sofia.castellano", level: "beginner", score: 88, date: "2026-03-10T10:30:00.000Z" },
  { username: "sofia.castellano", level: "beginner", score: 82, date: "2026-03-22T14:00:00.000Z" },
  { username: "sofia.castellano", level: "intermediate", score: 90, date: "2026-04-05T09:45:00.000Z" },
  { username: "sofia.castellano", level: "intermediate", score: 87, date: "2026-04-19T11:00:00.000Z" },
  { username: "trevor.osei", level: "beginner", score: 80, date: "2026-03-05T13:00:00.000Z" },
  { username: "trevor.osei", level: "beginner", score: 85, date: "2026-03-18T15:30:00.000Z" },
  { username: "trevor.osei", level: "intermediate", score: 83, date: "2026-04-02T10:00:00.000Z" },
  { username: "trevor.osei", level: "intermediate", score: 89, date: "2026-04-28T16:15:00.000Z" },
  { username: "hannah.cole", level: "beginner", score: 86, date: "2026-03-08T09:00:00.000Z" },
  { username: "hannah.cole", level: "beginner", score: 91, date: "2026-03-29T12:45:00.000Z" },
  { username: "hannah.cole", level: "intermediate", score: 88, date: "2026-04-14T10:15:00.000Z" },
  { username: "hannah.cole", level: "intermediate", score: 92, date: "2026-05-06T09:30:00.000Z" },
  { username: "diego.ramirez", level: "beginner", score: 87, date: "2026-03-12T11:30:00.000Z" },
  { username: "diego.ramirez", level: "beginner", score: 90, date: "2026-04-01T13:15:00.000Z" },
  { username: "diego.ramirez", level: "beginner", score: 85, date: "2026-05-20T14:45:00.000Z" },
];

function rubricFor(score: number, seed: number): string {
  const offsets = [3, -4, 1, -2, 2];
  const keys = ["needsDiscovery", "objectionPrevention", "trustBuilding", "naturalClose", "relationshipContinuity"] as const;
  const rubric: Record<string, number> = {};
  keys.forEach((k, i) => {
    const v = score + offsets[(i + seed) % offsets.length] + ((seed + i) % 2 === 0 ? 1 : -1);
    rubric[k] = Math.max(1, Math.min(100, v));
  });
  return JSON.stringify(rubric);
}

async function main() {
  const office = await storage.getOfficeByInviteCode(DEMO_OFFICE_INVITE_CODE);
  if (!office) {
    throw new Error(`Demo Office (invite code ${DEMO_OFFICE_INVITE_CODE}) not found. Run the app once, then re-run this script.`);
  }

  const allScenarios = await storage.listScenarios();
  const pools: Record<string, Scenario[]> = { beginner: [], intermediate: [], advanced: [] };
  for (const s of allScenarios) {
    if (scenarioTrack(s.track) !== "consulting") continue;
    if (s.vertical !== CONSULTING_VERTICAL) continue;
    if (s.difficulty in pools) pools[s.difficulty].push(s);
  }
  for (const level of Object.keys(pools)) pools[level].sort((a, b) => a.id - b.id);

  let created = 0;
  for (let i = 0; i < HISTORICAL.length; i++) {
    const spec = HISTORICAL[i];
    const user = await storage.getUserByUsername(spec.username);
    if (!user) {
      console.log(`skip ${spec.username}: user not found (run scripts/seed-demo-roster.ts first)`);
      continue;
    }
    const pool = pools[spec.level];
    if (!pool || pool.length === 0) {
      console.log(`skip ${spec.username}: no ${spec.level} scenarios available`);
      continue;
    }
    const scenario = pool[i % pool.length];
    const session: InsertSession = {
      userId: user.id,
      scenarioId: scenario.id,
      status: "completed",
      personaVariant: null,
      transcript: "[]",
      score: spec.score,
      rubricScores: rubricFor(spec.score, i),
      feedback: "Backdated demo session for date range picker screenshots.",
      createdAt: spec.date,
      completedAt: spec.date,
      savedAt: null,
      durationSeconds: 480 + (i % 5) * 60,
    };
    await storage.createSession(session);
    created++;
  }
  console.log(`Done. Inserted ${created} backdated session(s) spanning March-May 2026.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
