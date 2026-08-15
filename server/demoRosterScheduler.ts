import type { IStorage } from "./storage";
import type { InsertSession, Scenario, Session, User } from "@shared/schema";
import { DRIP_INTERVAL_MS } from "./opportunities";
import {
  buildCoachingMessages,
  buildTranscript,
  CONSULTING_VERTICAL,
  DEMO_OFFICE_PERSONAS,
  DEMO_ROSTER_OFFICE_ID,
  type Persona,
} from "../scripts/seed-demo-roster";

// The shared sales-demo roster is deliberately narrow. Keeping this explicit
// prevents an office-wide query from ever incorporating "Consultant Demo" or a
// similarly named account in another tenant.
export const DEMO_ROSTER_USERNAMES = new Set(DEMO_OFFICE_PERSONAS.map((persona) => persona.username));
export const ROLLING_WINDOW_DAYS = 180;
// Sessions are only pruned once they fall this far outside the active
// window, giving a safety margin so a session never gets deleted while it is
// still the oldest anchor satisfying ROLLING_WINDOW_DAYS.
export const PRUNE_AFTER_DAYS = 200;
const ANCHOR_TOLERANCE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DemoRosterPlannerUser {
  id: number;
  username: string;
  officeId: number;
}

export interface DemoRosterPlannerSession {
  id: number;
  userId: number;
  completedAt: string | null;
}

export interface DemoSessionInsertPlan {
  userId: number;
  username: string;
  completedAt: string;
  level: "beginner" | "intermediate" | "advanced";
  score: number;
  seed: number;
  reason: "recent" | "rolling_anchor";
}

export interface DemoRosterRefreshPlan {
  inserts: DemoSessionInsertPlan[];
  /** Existing session ids older than PRUNE_AFTER_DAYS, safe to delete along
   * with their coaching messages. Only ever includes ids belonging to the
   * allowlisted Demo Office personas passed into the planner. */
  pruneSessionIds: number[];
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function utcDayKey(value: Date): string {
  return startOfUtcDay(value).toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function timestampForDay(day: Date, personaIndex: number, seed: number): string {
  const result = startOfUtcDay(day);
  result.setUTCHours(11 + (personaIndex % 5), (personaIndex * 13 + seed * 7) % 60, 0, 0);
  return result.toISOString();
}

function scoreFor(persona: Persona, seed: number): number {
  // These bands extend the six established stories without changing their
  // vertical or current level distribution. The deterministic sequence makes
  // scheduler retries and test samples reproducible.
  const bands: Record<string, number[]> = {
    "marcus.bell": [61, 67, 72, 76, 69, 74],
    "priya.nair": [76, 82, 84, 79, 83, 81],
    "diego.ramirez": [78, 84, 87, 81, 89, 85],
    "hannah.cole": [82, 88, 91, 85, 89, 80],
    "trevor.osei": [84, 90, 87, 92, 82, 88],
    "sofia.castellano": [88, 93, 90, 95, 86, 92],
  };
  const values = bands[persona.username] ?? [80];
  return values[Math.abs(seed) % values.length];
}

function personaFor(username: string): Persona | undefined {
  return DEMO_OFFICE_PERSONAS.find((persona) => persona.username === username);
}

function userSessions(existing: DemoRosterPlannerSession[], userId: number): DemoRosterPlannerSession[] {
  return existing.filter((session) => session.userId === userId && !!session.completedAt);
}

function hasSessionNearDay(existingDays: Date[], target: Date): boolean {
  const targetMs = startOfUtcDay(target).getTime();
  return existingDays.some((day) => Math.abs(startOfUtcDay(day).getTime() - targetMs) <= ANCHOR_TOLERANCE_DAYS * DAY_MS);
}

/**
 * Plans additive inserts AND prunes for the Demo Office roster.
 *
 * Inserts: a daily recent attempt keeps seven- and 30-day dashboard periods
 * populated. A bounded set of bootstrap anchors gives new installations
 * immediate multi-month depth, and a new ~180-day anchor is inserted
 * whenever the prior one drifts more than a week old.
 *
 * Prunes: any existing session older than PRUNE_AFTER_DAYS is scheduled for
 * deletion (along with its coaching messages, handled by the caller). This
 * is what keeps the roster's total history genuinely rolling instead of
 * growing without bound: every tick both extends the recent/old edges AND
 * retires rows that have aged out past the active window plus a safety
 * margin.
 */
export function planDemoRefresh(
  personas: DemoRosterPlannerUser[],
  existingSessions: DemoRosterPlannerSession[],
  now: Date,
): DemoRosterRefreshPlan {
  const today = startOfUtcDay(now);
  const inserts: DemoSessionInsertPlan[] = [];
  const pruneSessionIds: number[] = [];
  const pruneCutoffMs = today.getTime() - PRUNE_AFTER_DAYS * DAY_MS;

  for (const user of personas) {
    if (user.officeId !== DEMO_ROSTER_OFFICE_ID || !DEMO_ROSTER_USERNAMES.has(user.username)) continue;
    const persona = personaFor(user.username);
    if (!persona) continue;

    const personaIndex = DEMO_OFFICE_PERSONAS.findIndex((candidate) => candidate.username === user.username);
    const existingForUser = userSessions(existingSessions, user.id);
    const existingDays = existingForUser.map((session) => new Date(session.completedAt!));
    const existingKeys = new Set(existingDays.map(utcDayKey));
    const daySeed = Math.floor(today.getTime() / DAY_MS) + personaIndex * 31;
    const desired: Array<{ day: Date; reason: DemoSessionInsertPlan["reason"] }> = [
      { day: today, reason: "recent" },
    ];

    // On a fresh roster, fill six broadly spaced milestones. Once populated,
    // only the oldest active-window anchor needs topping up over time.
    for (const daysAgo of [30, 60, 90, 120, 150]) {
      const day = addUtcDays(today, -daysAgo);
      if (!hasSessionNearDay(existingDays, day)) desired.push({ day, reason: "rolling_anchor" });
    }
    const rollingAnchor = addUtcDays(today, -ROLLING_WINDOW_DAYS);
    if (!hasSessionNearDay(existingDays, rollingAnchor)) {
      desired.push({ day: rollingAnchor, reason: "rolling_anchor" });
    }

    for (const { day, reason } of desired) {
      const key = utcDayKey(day);
      if (existingKeys.has(key)) continue;
      const seed = daySeed + Math.floor(day.getTime() / DAY_MS);
      inserts.push({
        userId: user.id,
        username: user.username,
        completedAt: timestampForDay(day, personaIndex, seed),
        level: persona.currentLevel,
        score: scoreFor(persona, seed),
        seed,
        reason,
      });
      existingKeys.add(key);
    }

    // Retire any existing session that has drifted past the active window
    // plus safety margin. This is the other half of "rolling": without it,
    // history only ever grows, even though the visible window stays anchored.
    for (const session of existingForUser) {
      const completedMs = new Date(session.completedAt!).getTime();
      if (completedMs < pruneCutoffMs) pruneSessionIds.push(session.id);
    }
  }

  inserts.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.userId - b.userId);
  pruneSessionIds.sort((a, b) => a - b);
  return { inserts, pruneSessionIds };
}

function scenarioPools(allScenarios: Scenario[]): Record<DemoSessionInsertPlan["level"], Scenario[]> {
  const pools: Record<DemoSessionInsertPlan["level"], Scenario[]> = { beginner: [], intermediate: [], advanced: [] };
  for (const scenario of allScenarios) {
    if (scenario.track === "leadership" || scenario.vertical !== CONSULTING_VERTICAL) continue;
    if (scenario.difficulty in pools) pools[scenario.difficulty as DemoSessionInsertPlan["level"]].push(scenario);
  }
  for (const level of Object.keys(pools) as DemoSessionInsertPlan["level"][]) {
    pools[level].sort((a, b) => a.id - b.id);
    if (pools[level].length === 0) throw new Error(`[demo-roster] no ${level} ${CONSULTING_VERTICAL} scenarios available`);
  }
  return pools;
}

function rubricFor(score: number, seed: number): string {
  const offsets = [3, -4, 1, -2, 2];
  const keys = ["needsDiscovery", "objectionPrevention", "trustBuilding", "naturalClose", "relationshipContinuity"];
  return JSON.stringify(Object.fromEntries(keys.map((key, index) => [
    key,
    Math.max(1, Math.min(100, score + offsets[(index + seed) % offsets.length] + ((seed + index) % 2 === 0 ? 1 : -1))),
  ])));
}

export type DemoRosterRefreshStorage = Pick<
  IStorage,
  | "listUsersByOffice"
  | "listSessionsByUser"
  | "listScenarios"
  | "createSession"
  | "createCoachingMessage"
  | "deleteSessionsByIds"
  | "deleteCoachingMessagesBySessionIds"
>;

/** Thin database wrapper around the pure plan. It only queries office #1 and
 * only creates or deletes rows for the six allowlisted usernames — every id
 * passed to the delete helpers was just fetched for those exact users, so
 * pruning can never reach outside the Demo Office roster. */
export async function refreshDemoRoster(
  storage: DemoRosterRefreshStorage,
  now: Date = new Date(),
): Promise<{ sessionsCreated: number; coachingCreated: number; sessionsPruned: number }> {
  const users = await storage.listUsersByOffice(DEMO_ROSTER_OFFICE_ID);
  const allowedUsers = users.filter((user) => DEMO_ROSTER_USERNAMES.has(user.username));
  const existingByUser = await Promise.all(allowedUsers.map(async (user) => storage.listSessionsByUser(user.id)));
  const plan = planDemoRefresh(allowedUsers, existingByUser.flat(), now);

  // Delete coaching messages before sessions (FK dependency), then the aged-
  // out sessions themselves. This is the half of "rolling" that keeps total
  // history bounded instead of growing forever.
  if (plan.pruneSessionIds.length > 0) {
    await storage.deleteCoachingMessagesBySessionIds(plan.pruneSessionIds);
    await storage.deleteSessionsByIds(plan.pruneSessionIds);
  }

  if (plan.inserts.length === 0) {
    return { sessionsCreated: 0, coachingCreated: 0, sessionsPruned: plan.pruneSessionIds.length };
  }

  const pools = scenarioPools(await storage.listScenarios());
  let coachingCreated = 0;
  for (const insertPlan of plan.inserts) {
    const pool = pools[insertPlan.level];
    const scenario = pool[Math.abs(insertPlan.seed) % pool.length];
    const draft: InsertSession = {
      userId: insertPlan.userId,
      scenarioId: scenario.id,
      status: "completed",
      transcript: "[]",
      score: insertPlan.score,
      rubricScores: rubricFor(insertPlan.score, insertPlan.seed),
      feedback: `Practice attempt on "${scenario.title}", overall ${insertPlan.score}.`,
      createdAt: insertPlan.completedAt,
      completedAt: insertPlan.completedAt,
    };
    draft.transcript = buildTranscript(draft as Pick<Session, "score" | "completedAt">, scenario, insertPlan.seed);
    const created = await storage.createSession(draft);
    for (const message of buildCoachingMessages(created, scenario, insertPlan.seed)) {
      await storage.createCoachingMessage(message);
      coachingCreated += 1;
    }
  }
  return { sessionsCreated: plan.inserts.length, coachingCreated, sessionsPruned: plan.pruneSessionIds.length };
}

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

/** Starts the in-process refresh loop using the established outreach cadence. */
export function startDemoRosterRefreshScheduler(storage: DemoRosterRefreshStorage): void {
  if (schedulerHandle) return;
  const tick = () => {
    refreshDemoRoster(storage).catch((error) => {
      console.error("[demo-roster] refresh tick failed:", error);
    });
  };
  schedulerHandle = setInterval(tick, DRIP_INTERVAL_MS);
  if (typeof schedulerHandle.unref === "function") schedulerHandle.unref();
}
