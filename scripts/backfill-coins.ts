// One-time backfill: awards coins retroactively for consultants who already
// passed a level BEFORE the coin-award feature existed (so no live "crossing"
// event ever fired for them). This does not change currentLevel/leadershipLevel,
// does not touch sessions, and never deletes or overwrites an existing coin row
// (insertCoinAwardIfAbsent is a no-op if the (userId, track, tier) row already
// exists, thanks to the DB unique constraint).
//
// Logic: LEVEL_ORDER is beginner -> intermediate -> advanced. Being AT a given
// level already proves every level strictly below it was fully passed (that's
// how computeLevelAdvancement works: you only reach intermediate by clearing
// beginner's 5x85+ gate, and only reach advanced by clearing intermediate's).
// So for each user/track:
//   - if level index >= 1 (intermediate or advanced): they already earned bronze
//   - if level index >= 2 (advanced): they already earned silver
//   - if level is advanced AND isExamEligible (5x85+ AT advanced): they earned gold
//     (gold requires clearing advanced's own gate, not just reaching it)
//
// Usage:
//   npx tsx scripts/backfill-coins.ts --dry-run   (default; prints plan only)
//   npx tsx scripts/backfill-coins.ts --apply     (writes to DATABASE_URL)

import { db } from "../server/storage";
import { users, sessions as sessionsTable, scenarios as scenariosTable, coinAwards } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import {
  LEVEL_ORDER,
  scoresForTrackAtLevel,
  isExamEligible,
} from "../server/llm";
import { coinTierForLevel, type IntelligenceTrack } from "../server/repIntelligence";

const APPLY = process.argv.includes("--apply");

type TierPlan = {
  userId: number;
  username: string;
  officeId: number;
  track: IntelligenceTrack;
  tier: "bronze" | "silver" | "gold";
  reason: string;
  earnedAt: string;
};

async function main() {
  const allUsers = await db.select().from(users);
  const allScenarios = await db.select().from(scenariosTable);
  const existingAwards = await db.select().from(coinAwards);
  const existingKey = (userId: number, track: string, tier: string) => `${userId}:${track}:${tier}`;
  const existingSet = new Set(existingAwards.map((a) => existingKey(a.userId, a.track, a.tier)));

  const plans: TierPlan[] = [];

  for (const user of allUsers) {
    if (user.role !== "consultant") continue;

    const allUserSessions = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.userId, user.id));

    for (const track of ["consulting", "leadership"] as const) {
      const level = track === "leadership" ? user.leadershipLevel : user.currentLevel;
      const levelIdx = LEVEL_ORDER.indexOf(level as (typeof LEVEL_ORDER)[number]);
      if (levelIdx === -1) continue;

      // Sessions on this track only (scenario.track matches, defaulting to
      // consulting for legacy scenarios with no track column, same rule the
      // live advancement logic uses).
      const trackSessions = allUserSessions.filter((s) => {
        const scenario = allScenarios.find((sc) => sc.id === s.scenarioId);
        if (!scenario) return false;
        const scenarioTrack = scenario.track === "leadership" ? "leadership" : "consulting";
        return scenarioTrack === track;
      });

      // Bronze: reaching intermediate or higher already proves beginner's gate cleared.
      if (levelIdx >= 1) {
        const key = existingKey(user.id, track, "bronze");
        if (!existingSet.has(key)) {
          const beginnerScores = scoresForTrackAtLevel(track, "beginner", trackSessions, allScenarios);
          const qualifying = beginnerScores.filter((s) => s >= 85);
          // earnedAt = date of the 5th qualifying beginner session, chronological order
          const sortedQualifying = trackSessions
            .filter((s) => s.status === "completed" && s.score !== null && s.score >= 85)
            .filter((s) => {
              const scenario = allScenarios.find((sc) => sc.id === s.scenarioId);
              return scenario?.difficulty === "beginner";
            })
            .sort((a, b) => (a.completedAt ?? a.createdAt).localeCompare(b.completedAt ?? b.createdAt));
          const earnedAt = sortedQualifying[4]?.completedAt ?? sortedQualifying[4]?.createdAt ?? new Date().toISOString();
          plans.push({
            userId: user.id,
            username: user.username,
            officeId: user.officeId,
            track,
            tier: "bronze",
            reason: `at ${level} (idx ${levelIdx}) implies beginner gate cleared (${qualifying.length} qualifying beginner sessions on record)`,
            earnedAt,
          });
        }
      }

      // Silver: reaching advanced already proves intermediate's gate cleared.
      if (levelIdx >= 2) {
        const key = existingKey(user.id, track, "silver");
        if (!existingSet.has(key)) {
          const intermediateScores = scoresForTrackAtLevel(track, "intermediate", trackSessions, allScenarios);
          const qualifying = intermediateScores.filter((s) => s >= 85);
          const sortedQualifying = trackSessions
            .filter((s) => s.status === "completed" && s.score !== null && s.score >= 85)
            .filter((s) => {
              const scenario = allScenarios.find((sc) => sc.id === s.scenarioId);
              return scenario?.difficulty === "intermediate";
            })
            .sort((a, b) => (a.completedAt ?? a.createdAt).localeCompare(b.completedAt ?? b.createdAt));
          const earnedAt = sortedQualifying[4]?.completedAt ?? sortedQualifying[4]?.createdAt ?? new Date().toISOString();
          plans.push({
            userId: user.id,
            username: user.username,
            officeId: user.officeId,
            track,
            tier: "silver",
            reason: `at ${level} (idx ${levelIdx}) implies intermediate gate cleared (${qualifying.length} qualifying intermediate sessions on record)`,
            earnedAt,
          });
        }
      }

      // Gold: only awarded if AT advanced AND has actually cleared advanced's
      // own 5x85+ gate (isExamEligible). Being at advanced alone is not enough.
      if (level === "advanced") {
        const advancedScores = scoresForTrackAtLevel(track, "advanced", trackSessions, allScenarios);
        if (isExamEligible("advanced", advancedScores)) {
          const key = existingKey(user.id, track, "gold");
          if (!existingSet.has(key)) {
            const qualifying = advancedScores.filter((s) => s >= 85);
            const sortedQualifying = trackSessions
              .filter((s) => s.status === "completed" && s.score !== null && s.score >= 85)
              .filter((s) => {
                const scenario = allScenarios.find((sc) => sc.id === s.scenarioId);
                return scenario?.difficulty === "advanced";
              })
              .sort((a, b) => (a.completedAt ?? a.createdAt).localeCompare(b.completedAt ?? b.createdAt));
            const earnedAt = sortedQualifying[4]?.completedAt ?? sortedQualifying[4]?.createdAt ?? new Date().toISOString();
            plans.push({
              userId: user.id,
              username: user.username,
              officeId: user.officeId,
              track,
              tier: "gold",
              reason: `at advanced with ${qualifying.length} qualifying advanced sessions (exam-eligible)`,
              earnedAt,
            });
          }
        }
      }
    }
  }

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — ${plans.length} coin(s) to backfill:\n`);
  for (const p of plans) {
    console.log(`  user=${p.username} (id=${p.userId}) office=${p.officeId} track=${p.track} tier=${p.tier} earnedAt=${p.earnedAt}`);
    console.log(`    reason: ${p.reason}`);
  }

  if (!APPLY) {
    console.log("\nDry run only — no writes made. Re-run with --apply to write these rows.");
    process.exit(0);
  }

  let inserted = 0;
  for (const p of plans) {
    const didInsert = await db
      .insert(coinAwards)
      .values({ userId: p.userId, officeId: p.officeId, track: p.track, tier: p.tier, earnedAt: p.earnedAt })
      .onConflictDoNothing({ target: [coinAwards.userId, coinAwards.track, coinAwards.tier] })
      .returning({ id: coinAwards.id });
    if (didInsert.length > 0) inserted++;
  }
  console.log(`\nInserted ${inserted} new coin award row(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
