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
const ANCHOR_TOLERANCE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DemoRosterPlannerUser {
  id: number;
  username: string;
  officeId: number;
}

export interface DemoRosterPlannerSession {
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

function sessionDays(existing: DemoRosterPlannerSession[], userId: number): Date[] {
  return existing
    .filter((session) => session.userId === userId && !!session.completedAt)
    .map((session) => new Date(session.completedAt!))
    .filter((date) => !Number.isNaN(date.getTime()));
}

function hasSessionNearDay(existingDays: Date[], target: Date): boolean {
  const targetMs = startOfUtcDay(target).getTime();
  return existingDays.some((day) => Math.abs(startOfUtcDay(day).getTime() - targetMs) <= ANCHOR_TOLERANCE_DAYS * DAY_MS);
}

/**
 * Plans only additive Demo Office roster sessions. A daily recent attempt
 * keeps seven- and 30-day dashboard periods populated. A bounded set of
 * bootstrap anchors gives new installations immediate multi-month depth, and
 * a new ~180-day anchor is inserted whenever the prior one drifts more than a
 * week old. Existing history is never deleted.
 */
export function planDemoRefresh(
  personas: DemoRosterPlannerUser[],
  existingSessions: DemoRosterPlannerSession[],
  now: Date,
): DemoSessionInsertPlan[] {
  const today = startOfUtcDay(now);
  const plans: DemoSessionInsertPlan[] = [];

  for (const user of personas) {
    if (user.officeId !== DEMO_ROSTER_OFFICE_ID || !DEMO_ROSTER_USERNAMES.has(user.username)) continue;
    const persona = personaFor(user.username);
    if (!persona) continue;

    const personaIndex = DEMO_OFFICE_PERSONAS.findIndex((candidate) => candidate.username === user.username);
    const existingDays = sessionDays(existingSessions, user.id);
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
      plans.push({
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
  }

  return plans.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.userId - b.userId);
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
  "listUsersByOffice" | "listSessionsByUser" | "listScenarios" | "createSession" | "createCoachingMessage"
>;

/** Thin database wrapper around the pure plan. It only queries office #1 and
 * only creates rows for the six allowlisted usernames. */
export async function refreshDemoRoster(
  storage: DemoRosterRefreshStorage,
  now: Date = new Date(),
): Promise<{ sessionsCreated: number; coachingCreated: number }> {
  const users = await storage.listUsersByOffice(DEMO_ROSTER_OFFICE_ID);
  const allowedUsers = users.filter((user) => DEMO_ROSTER_USERNAMES.has(user.username));
  const existingByUser = await Promise.all(allowedUsers.map(async (user) => storage.listSessionsByUser(user.id)));
  const plans = planDemoRefresh(allowedUsers, existingByUser.flat(), now);
  if (plans.length === 0) return { sessionsCreated: 0, coachingCreated: 0 };

  const pools = scenarioPools(await storage.listScenarios());
  let coachingCreated = 0;
  for (const plan of plans) {
    const pool = pools[plan.level];
    const scenario = pool[Math.abs(plan.seed) % pool.length];
    const draft: InsertSession = {
      userId: plan.userId,
      scenarioId: scenario.id,
      status: "completed",
      transcript: "[]",
      score: plan.score,
      rubricScores: rubricFor(plan.score, plan.seed),
      feedback: `Practice attempt on "${scenario.title}", overall ${plan.score}.`,
      createdAt: plan.completedAt,
      completedAt: plan.completedAt,
    };
    draft.transcript = buildTranscript(draft as Pick<Session, "score" | "completedAt">, scenario, plan.seed);
    const created = await storage.createSession(draft);
    for (const message of buildCoachingMessages(created, scenario, plan.seed)) {
      await storage.createCoachingMessage(message);
      coachingCreated += 1;
    }
  }
  return { sessionsCreated: plans.length, coachingCreated };
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
