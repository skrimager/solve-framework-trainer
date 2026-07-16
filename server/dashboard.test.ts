import { test, beforeEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import {
  registerManagerDashboardRoutes,
  buildDashboardStats,
  computeStreak,
  buildConsultantDashboard,
  STREAK_QUALIFYING_SCORE,
} from "./routes";
import type { User, Session, Scenario } from "@shared/schema";

// ===========================================================================
// Manager command-center dashboard analytics. Follows roster.test.ts: unit-test
// the pure aggregation (buildDashboardStats) with in-memory fixtures, then a few
// HTTP tests over the real route to prove authorization + office scoping.
// ===========================================================================

const OFFICE_ID = 1;
const OTHER_OFFICE_ID = 2;

function mkUser(partial: Partial<User> & { id: number; role: string }): User {
  return {
    officeId: OFFICE_ID,
    username: `user${partial.id}`,
    password: "x",
    displayName: `User ${partial.id}`,
    currentLevel: "beginner",
    leadershipLevel: "beginner",
    seatActive: true,
    isDemoAccount: false,
    consultingCertified: false,
    consultingCertifiedAt: null,
    leadershipCertified: false,
    leadershipCertifiedAt: null,
    ...partial,
  } as User;
}

function mkSession(partial: Partial<Session> & { id: number; userId: number; scenarioId: number }): Session {
  return {
    status: "completed",
    transcript: "[]",
    score: null,
    rubricScores: null,
    feedback: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    completedAt: "2026-03-01T00:00:00.000Z",
    savedAt: null,
    ...partial,
  } as Session;
}

const CONSULTING_RUBRIC = JSON.stringify({
  needsDiscovery: 80,
  objectionPrevention: 70,
  trustBuilding: 90,
  naturalClose: 60,
  relationshipContinuity: 50,
});

function fixtures() {
  const scenarios: Scenario[] = [
    { id: 10, difficulty: "beginner", track: "consulting", title: "Kicking Tires", vertical: "auto_sales" } as Scenario,
    { id: 11, difficulty: "advanced", track: "consulting", title: "Hard Close", vertical: "real_estate" } as Scenario,
    { id: 12, difficulty: "beginner", track: "leadership", title: "Upset Customer", vertical: "upset_customer_service" } as Scenario,
  ];
  const users: User[] = [
    mkUser({ id: 1, role: "manager", username: "manager1" }),
    mkUser({ id: 3, role: "consultant", username: "alice", displayName: "Alice A", currentLevel: "beginner" }),
    mkUser({
      id: 4,
      role: "consultant",
      username: "bob",
      displayName: "Bob B",
      currentLevel: "advanced",
      consultingCertified: true,
      consultingCertifiedAt: "2026-02-02T00:00:00.000Z",
    }),
    // A seatless consultant who has never practiced (honest empty-state member).
    mkUser({ id: 5, role: "consultant", username: "dave", displayName: "Dave D", seatActive: false }),
  ];
  const sessions: Session[] = [
    // Alice: two scored consulting sessions with rubric + one leadership scored.
    mkSession({ id: 100, userId: 3, scenarioId: 10, score: 90, rubricScores: CONSULTING_RUBRIC, completedAt: "2026-03-01T00:00:00.000Z" }),
    mkSession({ id: 101, userId: 3, scenarioId: 10, score: 80, rubricScores: CONSULTING_RUBRIC, completedAt: "2026-03-02T00:00:00.000Z" }),
    mkSession({ id: 102, userId: 3, scenarioId: 12, score: 70, completedAt: "2026-03-02T00:00:00.000Z" }),
    // Bob: one scored advanced consulting session + one in-progress.
    mkSession({ id: 200, userId: 4, scenarioId: 11, score: 100, rubricScores: CONSULTING_RUBRIC, completedAt: "2026-03-03T00:00:00.000Z" }),
    mkSession({ id: 201, userId: 4, scenarioId: 11, score: null, status: "in_progress", completedAt: null, createdAt: "2026-03-04T00:00:00.000Z" }),
  ];
  return { scenarios, users, sessions };
}

describe("buildDashboardStats (pure aggregation)", () => {
  const now = new Date("2026-03-05T00:00:00.000Z");

  test("team average is over scored completed sessions only", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    // Scored: 90, 80, 70, 100 -> avg 85.
    assert.equal(stats.kpis.teamAverageScore, 85);
  });

  test("practice sessions this period counts completions within the trailing week", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    // All four completed sessions are within 7 days of 2026-03-05.
    assert.equal(stats.kpis.practiceSessionsThisPeriod, 4);
  });

  test("counts certifications, active consultants, and total consultants", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    assert.equal(stats.kpis.certificationsEarned, 1); // Bob
    assert.equal(stats.kpis.activeConsultants, 2); // Alice + Bob (Dave seatless)
    assert.equal(stats.kpis.consultantCount, 3);
  });

  test("score-over-time buckets by completion day, ascending", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    assert.deepEqual(stats.scoreOverTime, [
      { date: "2026-03-01", averageScore: 90, sessions: 1 },
      { date: "2026-03-02", averageScore: 75, sessions: 2 }, // (80 + 70)/2
      { date: "2026-03-03", averageScore: 100, sessions: 1 },
    ]);
  });

  test("discovery dimensions average only consulting rubric sessions", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    assert.ok(stats.discoveryDimensions);
    const byKey = Object.fromEntries(stats.discoveryDimensions!.map((d) => [d.key, d.average]));
    // Three consulting rubric sessions, all identical rubric values.
    assert.equal(byKey.needsDiscovery, 80);
    assert.equal(byKey.trustBuilding, 90);
    assert.equal(byKey.relationshipContinuity, 50);
  });

  test("discovery dimensions are null when no consulting rubric sessions exist", () => {
    const { users, scenarios } = fixtures();
    const leadershipOnly = [
      mkSession({ id: 300, userId: 3, scenarioId: 12, score: 70, completedAt: "2026-03-02T00:00:00.000Z" }),
    ];
    const stats = buildDashboardStats(users, leadershipOnly, scenarios, now);
    assert.equal(stats.discoveryDimensions, null);
  });

  test("leaderboard ranks by average, scored-first", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    assert.deepEqual(
      stats.leaderboard.map((l) => l.displayName),
      ["Bob B", "Alice A", "Dave D"], // 100, 85, then no-sessions Dave last
    );
    const dave = stats.leaderboard.find((l) => l.displayName === "Dave D")!;
    assert.equal(dave.averageScore, null);
    assert.equal(dave.sessionsCompleted, 0);
  });

  test("level distribution uses the four real tiers with certified at top", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    assert.deepEqual(stats.levelDistribution, [
      { tier: "Beginner", count: 2 }, // Alice + Dave
      { tier: "Intermediate", count: 0 },
      { tier: "Advanced", count: 0 },
      { tier: "Certified", count: 1 }, // Bob (certified overrides advanced level)
    ]);
  });

  test("vertical breakdown counts completed sessions by scenario vertical", () => {
    const { users, sessions, scenarios } = fixtures();
    const stats = buildDashboardStats(users, sessions, scenarios, now);
    const byVertical = Object.fromEntries(stats.verticalBreakdown.map((v) => [v.vertical, v.count]));
    assert.equal(byVertical.auto_sales, 2); // Alice's two beginner consulting sessions
    assert.equal(byVertical.real_estate, 1); // Bob's completed advanced session
    assert.equal(byVertical.upset_customer_service, 1); // Alice's leadership session
  });

  test("empty office yields honest zero/null aggregates", () => {
    const stats = buildDashboardStats([], [], [], now);
    assert.equal(stats.kpis.teamAverageScore, null);
    assert.equal(stats.kpis.consultantCount, 0);
    assert.deepEqual(stats.scoreOverTime, []);
    assert.equal(stats.discoveryDimensions, null);
    assert.deepEqual(stats.leaderboard, []);
    assert.deepEqual(stats.verticalBreakdown, []);
    assert.equal(stats.totals.completed, 0);
  });
});

describe("manager dashboard HTTP endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let users: User[];
  let sessions: Session[];
  let scenarios: Scenario[];

  before(async () => {
    const app = express();
    app.use(express.json());
    registerManagerDashboardRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.close();
  });

  beforeEach(() => {
    const f = fixtures();
    users = f.users;
    sessions = f.sessions;
    scenarios = f.scenarios;
    (storage as any).getUser = async (id: number) => users.find((u) => u.id === id);
    (storage as any).listScenarios = async () => scenarios;
    (storage as any).listUsersByOffice = async (officeId: number) => users.filter((u) => u.officeId === officeId);
    (storage as any).listSessionsByOffice = async (officeId: number) => {
      const ids = users.filter((u) => u.officeId === officeId).map((u) => u.id);
      return sessions.filter((s) => ids.includes(s.userId));
    };
    // The office holds the paid Manager Dashboard add-on by default.
    (storage as any).getOffice = async (id: number) => ({ id, managerItemId: "si_dash" });
  });

  test("requires a requesterId", async () => {
    const res = await fetch(`${baseUrl}/api/manager/dashboard-stats`);
    assert.equal(res.status, 400);
  });

  test("rejects an unknown requester", async () => {
    const res = await fetch(`${baseUrl}/api/manager/dashboard-stats?requesterId=999`);
    assert.equal(res.status, 401);
  });

  test("rejects a plain consultant", async () => {
    const res = await fetch(`${baseUrl}/api/manager/dashboard-stats?requesterId=3`);
    assert.equal(res.status, 403);
  });

  test("allows the office manager and returns aggregates", async () => {
    const res = await fetch(`${baseUrl}/api/manager/dashboard-stats?requesterId=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kpis.consultantCount, 3);
    assert.ok(Array.isArray(body.leaderboard));
    assert.ok(Array.isArray(body.streaksAndRankings));
  });

  test("rejects an office without the Manager Dashboard add-on", async () => {
    (storage as any).getOffice = async (id: number) => ({ id, managerItemId: null });
    const res = await fetch(`${baseUrl}/api/manager/dashboard-stats?requesterId=1`);
    assert.equal(res.status, 403);
  });
});

// ===========================================================================
// Practice streaks + consultant mini dashboard.
// ===========================================================================

describe("computeStreak", () => {
  // Fixed "now" so the UTC-day math is deterministic. Today is 2026-03-10.
  const now = new Date("2026-03-10T12:00:00.000Z");
  const day = (d: string, score: number | null, id: number) =>
    mkSession({ id, userId: 3, scenarioId: 10, score, completedAt: `${d}T09:00:00.000Z` });

  test("a consultant with no sessions has streak 0", () => {
    assert.equal(computeStreak([], now), 0);
  });

  test("a qualifying session today gives a streak of at least 1", () => {
    const streak = computeStreak([day("2026-03-10", 80, 1)], now);
    assert.ok(streak >= 1);
    assert.equal(streak, 1);
  });

  test("consecutive qualifying days stack", () => {
    const sessions = [
      day("2026-03-10", 90, 1),
      day("2026-03-09", 75, 2),
      day("2026-03-08", 100, 3),
    ];
    assert.equal(computeStreak(sessions, now), 3);
  });

  test("a missed day resets the streak", () => {
    // Qualifying today and two days ago, but nothing yesterday (2026-03-09):
    // the gap breaks the run, so only today counts.
    const sessions = [day("2026-03-10", 90, 1), day("2026-03-08", 90, 2)];
    assert.equal(computeStreak(sessions, now), 1);
  });

  test("only yesterday still counts today (grace window)", () => {
    assert.equal(computeStreak([day("2026-03-09", 90, 1)], now), 1);
  });

  test("a full passed day with no practice resets to 0", () => {
    // Most recent qualifying day is two days ago: both today and yesterday
    // passed with no qualifying session.
    assert.equal(computeStreak([day("2026-03-08", 90, 1)], now), 0);
  });

  test("a session scored below the qualifying bar does not count", () => {
    assert.equal(STREAK_QUALIFYING_SCORE, 70);
    assert.equal(computeStreak([day("2026-03-10", 69, 1)], now), 0);
    // The bar is inclusive: exactly 70 qualifies.
    assert.equal(computeStreak([day("2026-03-10", 70, 2)], now), 1);
  });

  test("multiple qualifying sessions on one day count once", () => {
    const sessions = [day("2026-03-10", 80, 1), day("2026-03-10", 95, 2)];
    assert.equal(computeStreak(sessions, now), 1);
  });

  test("in-progress or unscored sessions never contribute", () => {
    const sessions = [
      mkSession({ id: 1, userId: 3, scenarioId: 10, score: null, status: "in_progress", completedAt: null, createdAt: "2026-03-10T09:00:00.000Z" }),
      mkSession({ id: 2, userId: 3, scenarioId: 10, score: null, status: "completed", completedAt: "2026-03-10T09:00:00.000Z" }),
    ];
    assert.equal(computeStreak(sessions, now), 0);
  });
});

describe("buildConsultantDashboard", () => {
  const now = new Date("2026-03-05T12:00:00.000Z");

  test("returns streak, peer rank, and certification progress", () => {
    const { users, sessions, scenarios } = fixtures();
    const alice = users.find((u) => u.username === "alice")!;
    const payload = buildConsultantDashboard(alice, users, sessions, scenarios, now);
    assert.equal(payload.entitled, true);
    // Alice has a qualifying (90) session on 2026-03-01 but nothing 03-02..03-05,
    // so multiple days have passed with no practice: streak resets to 0.
    assert.equal(payload.streak.current, 0);
    assert.equal(payload.streak.qualifyingScore, 70);
    // Ranked by average score: Bob (100) is #1, Alice (85) is #2 of three consultants.
    assert.equal(payload.rank.position, 2);
    assert.equal(payload.rank.outOf, 3);
    assert.equal(payload.rank.metric, "averageScore");
    assert.equal(payload.certification.level, "beginner");
    assert.equal(payload.certification.nextLevel, "intermediate");
    assert.equal(payload.certification.requiredSessions, 5);
  });

  test("a consultant with a fresh qualifying session shows a live streak", () => {
    const { users, scenarios } = fixtures();
    const alice = users.find((u) => u.username === "alice")!;
    const todaySession = mkSession({ id: 900, userId: alice.id, scenarioId: 10, score: 88, completedAt: "2026-03-05T08:00:00.000Z" });
    const payload = buildConsultantDashboard(alice, users, [todaySession], scenarios, now);
    assert.equal(payload.streak.current, 1);
  });
});
