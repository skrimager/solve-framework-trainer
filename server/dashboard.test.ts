import { test, beforeEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import {
  registerManagerDashboardRoutes,
  registerConsultantDashboardRoutes,
  buildDashboardStats,
  computeStreak,
  buildConsultantDashboard,
  STREAK_QUALIFYING_SCORE,
  buildCommandCenterExtras,
  computeTeamHealthScore,
  computeScoreDistribution,
  computeConversationOutcomes,
  computeAlerts,
  filterAcknowledgedAlerts,
  buildLiveFeed,
  computePopularScenarios,
  computeAchievements,
  percentDelta,
  defaultDashboardWidgetConfig,
  resolveDashboardWidgetConfig,
  DASHBOARD_WIDGET_KEYS,
  resolveDashboardPeriod,
} from "./routes";
import type { User, Session, Scenario } from "@shared/schema";
import { USER_SESSION_COOKIE, signUserSession } from "./userSession";

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
    (storage as any).listAcademyCreditsByOffice = async () => [];
  });

  function dashboardFetch(url: string, init?: RequestInit, userId = 1) {
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        cookie: `${USER_SESSION_COOKIE}=${encodeURIComponent(signUserSession(userId))}`,
      },
    });
  }

  test("rejects a caller with no verified session even when it supplies a manager requesterId", async () => {

    const res = await fetch(`${baseUrl}/api/manager/dashboard-stats?requesterId=1`);
    assert.equal(res.status, 401);
  });

  test("rejects a plain consultant", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats`, undefined, 3);
    assert.equal(res.status, 403);
  });

  test("allows the office manager and returns aggregates", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kpis.consultantCount, 3);
    assert.ok(Array.isArray(body.leaderboard));
    assert.ok(Array.isArray(body.streaksAndRankings));
  });

  test("rejects an office without the Manager Dashboard add-on", async () => {
    (storage as any).getOffice = async (id: number) => ({ id, managerItemId: null });
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats`);
    assert.equal(res.status, 403);
  });

  test("a demo manager sees full stats even when the office lacks the add-on", async () => {
    // The founder's live sales-demo office is billing-active but never bought the
    // dashboard add-on (managerItemId null). Its demo manager must still get 200.
    users.find((u) => u.id === 1)!.isDemoAccount = true;
    (storage as any).getOffice = async (id: number) => ({ id, managerItemId: null });
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kpis.consultantCount, 3);
    assert.ok(Array.isArray(body.streaksAndRankings));
  });

  test("omitting since/until falls back to the historical trailing 7-day window", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period.days, 7);
    assert.equal(body.period.label, "This week");
    assert.ok(typeof body.period.since === "string");
    assert.ok(typeof body.period.until === "string");
  });

  test("an explicit since/until narrows the period and scopes practiceSessionsThisPeriod", async () => {
    // Fixtures' completed sessions land 2026-03-01..03. A since/until window
    // covering only 2026-03-01 should see just Alice's first session (id 100).
    const res = await dashboardFetch(
      `${baseUrl}/api/manager/dashboard-stats?since=2026-03-01T00:00:00.000Z&until=2026-03-01T23:59:59.999Z`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period.label, "Custom range");
    assert.equal(body.kpis.practiceSessionsThisPeriod, 1);
  });

  test("a wider since/until captures more sessions than the 7-day default", async () => {
    const wide = await dashboardFetch(
      `${baseUrl}/api/manager/dashboard-stats?since=2026-01-01T00:00:00.000Z&until=2026-04-01T00:00:00.000Z`,
    );
    const wideBody = await wide.json();
    const narrow = await dashboardFetch(
      `${baseUrl}/api/manager/dashboard-stats?since=2026-03-01T00:00:00.000Z&until=2026-03-01T23:59:59.999Z`,
    );
    const narrowBody = await narrow.json();
    assert.ok(wideBody.kpis.practiceSessionsThisPeriod >= narrowBody.kpis.practiceSessionsThisPeriod);
  });

  test("an unparseable since falls back to the default 7-day window instead of erroring", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats?since=not-a-date`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period.days, 7);
    assert.equal(body.period.label, "This week");
  });

  test("returns the office's earliest session timestamp for the client's all-time preset", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats`);
    const body = await res.json();
    // Fixtures' earliest session (by createdAt) is id 100 on 2026-03-01.
    assert.equal(body.earliestSessionAt, "2026-03-01T00:00:00.000Z");
  });

  test("an office with no sessions yet returns a null earliestSessionAt", async () => {
    sessions.length = 0;
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-stats`);
    const body = await res.json();
    assert.equal(body.earliestSessionAt, null);
  });
});

describe("resolveDashboardPeriod", () => {
  const now = new Date("2026-03-08T00:00:00.000Z");

  test("defaults to a trailing 7-day window ending now when since/until are omitted", () => {
    const period = resolveDashboardPeriod(undefined, undefined, now);
    assert.equal(period.days, 7);
    assert.equal(period.label, "This week");
    assert.equal(period.until.getTime(), now.getTime());
    assert.equal(period.since.getTime(), now.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  test("an explicit since with no until defaults until to now", () => {
    const since = "2026-01-01T00:00:00.000Z";
    const period = resolveDashboardPeriod(since, undefined, now);
    assert.equal(period.since.toISOString(), since);
    assert.equal(period.until.getTime(), now.getTime());
    assert.equal(period.label, "Custom range");
  });

  test("an explicit since and until define the window exactly, and days spans the range", () => {
    const since = "2026-02-01T00:00:00.000Z";
    const until = "2026-03-03T00:00:00.000Z";
    const period = resolveDashboardPeriod(since, until, now);
    assert.equal(period.since.toISOString(), since);
    assert.equal(period.until.toISOString(), until);
    assert.equal(period.days, 30); // Feb 1 -> Mar 3
  });

  test("all-time (an early since like an office's earliest session) resolves to a wide multi-month span", () => {
    const since = "2026-01-05T00:00:00.000Z"; // e.g. office's earliest session
    const period = resolveDashboardPeriod(since, undefined, now);
    assert.ok(period.days >= 60);
    assert.equal(period.since.toISOString(), since);
  });

  test("an unparseable since falls back to the default window", () => {
    const period = resolveDashboardPeriod("not-a-date", undefined, now);
    assert.equal(period.days, 7);
    assert.equal(period.label, "This week");
  });

  test("an unparseable until is ignored in favor of now, while a valid since is kept", () => {
    const since = "2026-01-01T00:00:00.000Z";
    const period = resolveDashboardPeriod(since, "not-a-date", now);
    assert.equal(period.since.toISOString(), since);
    assert.equal(period.until.getTime(), now.getTime());
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

describe("consultant dashboard HTTP endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let users: User[];
  let sessions: Session[];
  let scenarios: Scenario[];

  before(async () => {
    const app = express();
    app.use(express.json());
    registerConsultantDashboardRoutes(app);
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

  test("an entitled office returns the full payload", async () => {
    const res = await fetch(`${baseUrl}/api/consultant/dashboard?requesterId=3`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entitled, true);
    assert.ok(body.streak);
    assert.ok(body.rank);
  });

  test("a non-demo office without the add-on gets the clean locked-out empty state", async () => {
    (storage as any).getOffice = async (id: number) => ({ id, managerItemId: null });
    const res = await fetch(`${baseUrl}/api/consultant/dashboard?requesterId=3`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entitled, false);
    assert.equal(body.streak, undefined, "no streak data leaks when not entitled");
  });

  test("a demo consultant is entitled even when the office lacks the add-on", async () => {
    users.find((u) => u.id === 3)!.isDemoAccount = true;
    (storage as any).getOffice = async (id: number) => ({ id, managerItemId: null });
    const res = await fetch(`${baseUrl}/api/consultant/dashboard?requesterId=3`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entitled, true);
    assert.ok(body.streak);
  });
});

// ===========================================================================
// Command Center widgets: pure helpers (percentDelta, team health score,
// score distribution, conversation outcomes, alerts, live feed, popular
// scenarios, achievements) and the widget-config resolve/default helpers.
// ===========================================================================

describe("percentDelta", () => {
  test("computes a rounded percent change", () => {
    assert.equal(percentDelta(114, 100), 14);
    assert.equal(percentDelta(86, 100), -14);
  });

  test("returns 0 when both current and previous are zero", () => {
    assert.equal(percentDelta(0, 0), 0);
  });

  test("returns null when there is no baseline to compare against", () => {
    assert.equal(percentDelta(5, 0), null);
  });
});

describe("computeTeamHealthScore", () => {
  test("weights quality 50%, completion 30%, activity 20%", () => {
    const score = computeTeamHealthScore({ teamAverageScore: 80, completionRate: 80, activityRate: 80 });
    assert.equal(score, 80);
  });

  test("re-normalizes weights when a signal is missing", () => {
    // Only teamAverageScore (100) and completionRate (0) present -> weights 0.5/0.3
    // renormalized to 5/8 and 3/8 -> (100*5 + 0*3)/8 = 62.5 -> rounds to 63.
    const score = computeTeamHealthScore({ teamAverageScore: 100, completionRate: 0, activityRate: null });
    assert.equal(score, 63);
  });

  test("returns null when every signal is missing", () => {
    assert.equal(computeTeamHealthScore({ teamAverageScore: null, completionRate: null, activityRate: null }), null);
  });
});

describe("computeScoreDistribution", () => {
  test("buckets scores into fixed bands with percentages", () => {
    const dist = computeScoreDistribution([55, 65, 65, 75, 85, 85, 85, 95]);
    assert.deepEqual(dist.map((d) => d.band), ["0-59", "60-69", "70-79", "80-89", "90-100"]);
    const byBand = Object.fromEntries(dist.map((d) => [d.band, d]));
    assert.equal(byBand["0-59"].count, 1);
    assert.equal(byBand["60-69"].count, 2);
    assert.equal(byBand["80-89"].count, 3);
    assert.equal(byBand["80-89"].percent, 38); // 3/8 -> 37.5 -> rounds to 38
  });

  test("returns zero counts and zero percentages for an empty score list", () => {
    const dist = computeScoreDistribution([]);
    assert.ok(dist.every((d) => d.count === 0 && d.percent === 0));
    assert.equal(dist.length, 5);
  });
});

describe("computeConversationOutcomes", () => {
  test("buckets completed+high-score as Successful, completed+lower-score as Converted", () => {
    const sessions = [
      { status: "completed", score: 90 },
      { status: "completed", score: 70 },
      { status: "completed", score: null },
      { status: "in_progress", score: null },
      { status: "saved", score: null },
    ] as any;
    const outcomes = computeConversationOutcomes(sessions);
    const byOutcome = Object.fromEntries(outcomes.map((o) => [o.outcome, o.count]));
    assert.equal(byOutcome.Successful, 1);
    assert.equal(byOutcome.Converted, 1);
    assert.equal(byOutcome["No Outcome"], 1);
    assert.equal(byOutcome["In Progress"], 2);
  });
});

describe("computeAlerts", () => {
  const now = new Date("2026-03-20T00:00:00.000Z");

  test("flags a seat-active consultant who has gone quiet", () => {
    const consultants = [mkUser({ id: 3, role: "consultant", seatActive: true })];
    const sessionsByUser = new Map<number, Session[]>([
      [3, [mkSession({ id: 1, userId: 3, scenarioId: 10, score: 90, completedAt: "2026-02-01T00:00:00.000Z" })]],
    ]);
    const alerts = computeAlerts(consultants, sessionsByUser, now);
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].reasons.includes("inactive"));
  });

  test("flags a consultant whose recent average has dropped below the qualifying bar", () => {
    const consultants = [mkUser({ id: 3, role: "consultant", seatActive: true })];
    const sessionsByUser = new Map<number, Session[]>([
      [
        3,
        [
          mkSession({ id: 1, userId: 3, scenarioId: 10, score: 50, completedAt: "2026-03-19T00:00:00.000Z" }),
          mkSession({ id: 2, userId: 3, scenarioId: 10, score: 40, completedAt: "2026-03-18T00:00:00.000Z" }),
        ],
      ],
    ]);
    const alerts = computeAlerts(consultants, sessionsByUser, now);
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].reasons.includes("lowScore"));
    assert.ok(!alerts[0].reasons.includes("inactive"));
  });

  test("does not flag a seatless consultant or a healthy active one", () => {
    const consultants = [
      mkUser({ id: 3, role: "consultant", seatActive: false }),
      mkUser({ id: 4, role: "consultant", seatActive: true }),
    ];
    const sessionsByUser = new Map<number, Session[]>([
      [4, [mkSession({ id: 1, userId: 4, scenarioId: 10, score: 95, completedAt: "2026-03-19T00:00:00.000Z" })]],
    ]);
    const alerts = computeAlerts(consultants, sessionsByUser, now);
    assert.deepEqual(alerts, []);
  });

  test("suppresses an acknowledged alert until a newer relevant completed session supersedes it", () => {
    const alerts = [{ id: 3, displayName: "Alice A", reasons: ["inactive", "lowScore"] as const }];
    const acknowledgement = {
      id: 1,
      officeId: OFFICE_ID,
      consultantId: 3,
      reason: "lowScore",
      acknowledgedBy: 1,
      acknowledgedAt: "2026-03-10T00:00:00.000Z",
    } as any;
    const beforeNewScore = new Map<number, Session[]>([[
      3,
      [mkSession({ id: 1, userId: 3, scenarioId: 10, score: 40, completedAt: "2026-03-09T00:00:00.000Z" })],
    ]]);
    assert.deepEqual(filterAcknowledgedAlerts(alerts, beforeNewScore, [acknowledgement]), [
      { id: 3, displayName: "Alice A", reasons: ["inactive"] },
    ]);

    const afterNewScore = new Map<number, Session[]>([[
      3,
      [mkSession({ id: 2, userId: 3, scenarioId: 10, score: 40, completedAt: "2026-03-11T00:00:00.000Z" })],
    ]]);
    assert.deepEqual(filterAcknowledgedAlerts(alerts, afterNewScore, [acknowledgement]), alerts);
  });

  test("keeps a low-score acknowledgement active after a newer unscored completed session", () => {
    const alerts = [{ id: 3, displayName: "Alice A", reasons: ["lowScore"] as const }];
    const acknowledgement = {
      id: 1,
      officeId: OFFICE_ID,
      consultantId: 3,
      reason: "lowScore",
      acknowledgedBy: 1,
      acknowledgedAt: "2026-03-10T00:00:00.000Z",
    } as any;
    const sessionsByUser = new Map<number, Session[]>([[
      3,
      [mkSession({ id: 2, userId: 3, scenarioId: 10, score: null, completedAt: "2026-03-11T00:00:00.000Z" })],
    ]]);

    assert.deepEqual(filterAcknowledgedAlerts(alerts, sessionsByUser, [acknowledgement]), []);
  });

  test("supersedes an inactive acknowledgement after any newer completed session", () => {
    const alerts = [{ id: 3, displayName: "Alice A", reasons: ["inactive"] as const }];
    const acknowledgement = {
      id: 1,
      officeId: OFFICE_ID,
      consultantId: 3,
      reason: "inactive",
      acknowledgedBy: 1,
      acknowledgedAt: "2026-03-10T00:00:00.000Z",
    } as any;
    const sessionsByUser = new Map<number, Session[]>([[
      3,
      [mkSession({ id: 2, userId: 3, scenarioId: 10, score: null, completedAt: "2026-03-11T00:00:00.000Z" })],
    ]]);

    assert.deepEqual(filterAcknowledgedAlerts(alerts, sessionsByUser, [acknowledgement]), alerts);
  });
});

describe("buildLiveFeed", () => {
  test("includes certifications and completed sessions sorted newest first", () => {
    const { scenarios } = fixtures();
    const users = [
      mkUser({ id: 3, role: "consultant", displayName: "Alice A", consultingCertifiedAt: "2026-03-04T00:00:00.000Z" }),
    ];
    const sessions = [
      mkSession({ id: 100, userId: 3, scenarioId: 10, score: 95, completedAt: "2026-03-05T00:00:00.000Z" }),
      mkSession({ id: 101, userId: 3, scenarioId: 10, score: 60, completedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    const feed = buildLiveFeed(users, sessions, scenarios);
    assert.equal(feed.length, 3);
    assert.equal(feed[0].type, "high_score"); // 03-05, score 95
    assert.equal(feed[0].sessionId, 100);
    assert.equal(feed[1].type, "certification"); // 03-04
    assert.equal(feed[1].sessionId, null); // certifications have no backing session
    assert.equal(feed[2].type, "session_completed"); // 03-01
    assert.equal(feed[2].sessionId, 101);
  });

  test("respects the limit", () => {
    const { scenarios } = fixtures();
    const users = [mkUser({ id: 3, role: "consultant", displayName: "Alice A" })];
    const sessions = Array.from({ length: 20 }, (_, i) =>
      mkSession({ id: 100 + i, userId: 3, scenarioId: 10, score: 50, completedAt: `2026-03-${(i % 28) + 1}T00:00:00.000Z` }),
    );
    const feed = buildLiveFeed(users, sessions, scenarios, 5);
    assert.equal(feed.length, 5);
  });
});

describe("computePopularScenarios", () => {
  test("ranks by session count and reports the average score per scenario", () => {
    const { scenarios } = fixtures();
    const sessions = [
      mkSession({ id: 1, userId: 3, scenarioId: 10, score: 80, completedAt: "2026-03-01T00:00:00.000Z" }),
      mkSession({ id: 2, userId: 4, scenarioId: 10, score: 90, completedAt: "2026-03-02T00:00:00.000Z" }),
      mkSession({ id: 3, userId: 3, scenarioId: 11, score: 70, completedAt: "2026-03-03T00:00:00.000Z" }),
    ];
    const popular = computePopularScenarios(sessions, scenarios, 5);
    assert.equal(popular[0].scenarioId, 10);
    assert.equal(popular[0].sessionCount, 2);
    assert.equal(popular[0].averageScore, 85);
    assert.equal(popular[1].scenarioId, 11);
  });

  test("excludes in-progress sessions from both the count and the average", () => {
    const { scenarios } = fixtures();
    const sessions = [
      mkSession({ id: 1, userId: 3, scenarioId: 10, score: null, status: "in_progress", completedAt: null, createdAt: "2026-03-01T00:00:00.000Z" }),
    ];
    const popular = computePopularScenarios(sessions, scenarios, 5);
    assert.deepEqual(popular, []);
  });
});

describe("computeAchievements", () => {
  const now = new Date("2026-03-20T00:00:00.000Z");

  test("derives Gold/Silver Achiever badges from real certification timestamps", () => {
    const consultants = [
      mkUser({ id: 3, role: "consultant", displayName: "Alice A", consultingCertifiedAt: "2026-03-01T00:00:00.000Z" }),
      mkUser({ id: 4, role: "consultant", displayName: "Bob B", leadershipCertifiedAt: "2026-03-02T00:00:00.000Z" }),
    ];
    const sessionsByUser = new Map<number, Session[]>();
    const badges = computeAchievements(consultants, sessionsByUser, [], now);
    const kinds = badges.map((b) => b.badge);
    assert.ok(kinds.includes("gold_achiever"));
    assert.ok(kinds.includes("silver_achiever"));
  });

  test("awards exactly one Top Performer badge to the #1 leaderboard entry", () => {
    const consultants = [mkUser({ id: 3, role: "consultant", displayName: "Alice A" })];
    const leaderboard = [
      { id: 3, displayName: "Alice A", averageScore: 95 },
      { id: 4, displayName: "Bob B", averageScore: 80 },
    ];
    const badges = computeAchievements(consultants, new Map(), leaderboard, now);
    const topPerformers = badges.filter((b) => b.badge === "top_performer");
    assert.equal(topPerformers.length, 1);
    assert.equal(topPerformers[0].userId, 3);
  });

  test("awards Role Play Master only at or above the session threshold", () => {
    const consultant = mkUser({ id: 3, role: "consultant", displayName: "Alice A" });
    const sessions = Array.from({ length: 25 }, (_, i) =>
      mkSession({ id: 100 + i, userId: 3, scenarioId: 10, score: 80, completedAt: "2026-03-01T00:00:00.000Z" }),
    );
    const sessionsByUser = new Map<number, Session[]>([[3, sessions]]);
    const badges = computeAchievements([consultant], sessionsByUser, [], now);
    assert.ok(badges.some((b) => b.badge === "role_play_master"));
  });
});

describe("dashboard widget config helpers", () => {
  test("the default config marks every known widget visible", () => {
    const cfg = defaultDashboardWidgetConfig();
    for (const key of DASHBOARD_WIDGET_KEYS) {
      assert.equal(cfg[key], true);
    }
  });

  test("null/unset saved config resolves to all-visible defaults", () => {
    assert.deepEqual(resolveDashboardWidgetConfig(null), defaultDashboardWidgetConfig());
    assert.deepEqual(resolveDashboardWidgetConfig(undefined), defaultDashboardWidgetConfig());
  });

  test("malformed JSON falls back to defaults rather than throwing", () => {
    assert.deepEqual(resolveDashboardWidgetConfig("{not json"), defaultDashboardWidgetConfig());
  });

  test("a saved partial config overrides only the keys it specifies", () => {
    const saved = JSON.stringify({ alerts: false, liveFeed: false });
    const cfg = resolveDashboardWidgetConfig(saved);
    assert.equal(cfg.alerts, false);
    assert.equal(cfg.liveFeed, false);
    assert.equal(cfg.teamHealth, true); // untouched key still defaults to visible
  });

  test("a widget key unknown at save time (future-proofing) is ignored, not crashed on", () => {
    const saved = JSON.stringify({ someFutureWidget: false, alerts: false });
    const cfg = resolveDashboardWidgetConfig(saved);
    assert.equal(cfg.alerts, false);
    assert.equal((cfg as any).someFutureWidget, undefined);
  });
});

describe("buildCommandCenterExtras (pure aggregation)", () => {
  const now = new Date("2026-03-08T00:00:00.000Z"); // one week after fixtures' data

  test("returns all top-level widget sections", () => {
    const { users, sessions, scenarios } = fixtures();
    const extras = buildCommandCenterExtras(users, sessions, scenarios, now);
    assert.ok(extras.teamHealth);
    assert.ok(extras.conversations);
    assert.ok(extras.completionRate);
    assert.ok(extras.certifications);
    assert.ok(Array.isArray(extras.alerts));
    assert.ok(Array.isArray(extras.liveFeed));
    assert.ok(Array.isArray(extras.performanceOverTime));
    assert.ok(Array.isArray(extras.scoreDistribution));
    assert.ok(Array.isArray(extras.conversationOutcomes));
    assert.ok(Array.isArray(extras.popularScenarios));
    assert.ok(Array.isArray(extras.achievements));
    assert.ok(extras.summaryStrip);
  });

  test("team health score is a 0-100 composite with a defined shape", () => {
    const { users, sessions, scenarios } = fixtures();
    const extras = buildCommandCenterExtras(users, sessions, scenarios, now);
    assert.ok(extras.teamHealth.score === null || (extras.teamHealth.score! >= 0 && extras.teamHealth.score! <= 100));
  });

  test("conversations count matches completed sessions within the trailing period", () => {
    const { users, sessions, scenarios } = fixtures();
    const extras = buildCommandCenterExtras(users, sessions, scenarios, now);
    // now = 2026-03-08; fixtures' 4 completed sessions all fall 2026-03-01..03,
    // which is within 7 days of 2026-03-08.
    assert.equal(extras.conversations.count, 4);
    assert.equal(extras.conversations.sparkline.length, 8); // periodSince..now inclusive, UTC days
  });

  test("summary strip reports real aggregates from the same fixtures", () => {
    const { users, sessions, scenarios } = fixtures();
    const extras = buildCommandCenterExtras(users, sessions, scenarios, now);
    assert.equal(extras.summaryStrip.totalSessions, sessions.length);
    assert.equal(extras.summaryStrip.teamMembersActive, 2); // Alice + Bob (Dave seatless)
    assert.equal(extras.summaryStrip.certificationsTotal, 1); // Bob
  });

  test("an empty office yields honest empty/null aggregates, not crashes", () => {
    const extras = buildCommandCenterExtras([], [], [], now);
    assert.equal(extras.teamHealth.score, null);
    assert.equal(extras.conversations.count, 0);
    assert.deepEqual(extras.alerts, []);
    assert.deepEqual(extras.liveFeed, []);
    assert.deepEqual(extras.achievements, []);
    assert.equal(extras.summaryStrip.totalSessions, 0);
  });
});

describe("command center + widget-config HTTP endpoints", () => {
  let server: Server;
  let baseUrl: string;
  let users: User[];
  let sessions: Session[];
  let scenarios: Scenario[];
  let officeRecord: { id: number; managerItemId: string | null; dashboardWidgetConfig: string | null };

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
    officeRecord = { id: OFFICE_ID, managerItemId: "si_dash", dashboardWidgetConfig: null };
    (storage as any).getUser = async (id: number) => users.find((u) => u.id === id);
    (storage as any).listScenarios = async () => scenarios;
    (storage as any).listUsersByOffice = async (officeId: number) => users.filter((u) => u.officeId === officeId);
    (storage as any).listSessionsByOffice = async (officeId: number) => {
      const ids = users.filter((u) => u.officeId === officeId).map((u) => u.id);
      return sessions.filter((s) => ids.includes(s.userId));
    };
    (storage as any).listAcademyCreditsByOffice = async () => [];
    (storage as any).getOffice = async (id: number) => (id === officeRecord.id ? officeRecord : undefined);
    (storage as any).updateOffice = async (id: number, patch: Partial<typeof officeRecord>) => {
      if (id !== officeRecord.id) return undefined;
      officeRecord = { ...officeRecord, ...patch };
      return officeRecord;
    };
    (storage as any).getSession = async (id: number) => sessions.find((s) => s.id === id);
    (storage as any).getScenario = async (id: number) => scenarios.find((s) => s.id === id);
    (storage as any).listActiveAlertAcknowledgements = async () => [];
    (storage as any).listCoachingMessagesBySession = async () => [];
  });

  function dashboardFetch(url: string, init?: RequestInit, userId = 1) {
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        cookie: `${USER_SESSION_COOKIE}=${encodeURIComponent(signUserSession(userId))}`,
      },
    });
  }

  test("GET dashboard-command-center requires manager/qa role", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-command-center`, undefined, 3);
    assert.equal(res.status, 403);
  });

  test("GET dashboard-command-center returns widget data plus the default widget config", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-command-center`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.teamHealth);
    assert.deepEqual(body.widgetConfig, defaultDashboardWidgetConfig());
  });

  test("GET dashboard-command-center hides an active acknowledged alert", async () => {
    (storage as any).listActiveAlertAcknowledgements = async () => [{
      id: 1,
      officeId: OFFICE_ID,
      consultantId: 3,
      reason: "lowScore",
      acknowledgedBy: 1,
      acknowledgedAt: "2026-03-03T00:00:00.000Z",
    }];
    sessions = [
      mkSession({ id: 100, userId: 3, scenarioId: 10, score: 40, completedAt: "2026-03-02T00:00:00.000Z" }),
    ];

    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-command-center`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const alice = body.alerts.find((alert: any) => alert.id === 3);
    assert.deepEqual(alice?.reasons, ["inactive"]);
  });

  test("POST alerts/acknowledge writes a manager-scoped acknowledgement", async () => {
    let created: any;
    (storage as any).createAlertAcknowledgement = async (acknowledgement: any) => {
      created = { id: 11, ...acknowledgement };
      return created;
    };

    const res = await dashboardFetch(`${baseUrl}/api/manager/alerts/acknowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consultantId: 3, reason: "inactive" }),
    });
    assert.equal(res.status, 201);
    assert.equal(created.officeId, OFFICE_ID);
    assert.equal(created.consultantId, 3);
    assert.equal(created.acknowledgedBy, 1);
    assert.equal(created.reason, "inactive");
  });

  test("GET conversations returns the completed-session list for the selected range", async () => {
    const res = await dashboardFetch(
      `${baseUrl}/api/manager/dashboard-command-center/conversations?since=2026-03-01T00:00:00.000Z&until=2026-03-01T23:59:59.999Z`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessions.length, 1);
    assert.deepEqual(body.sessions[0], {
      consultantName: "Alice A",
      scenarioTitle: "Kicking Tires",
      score: 90,
      completedAt: "2026-03-01T00:00:00.000Z",
      sessionId: 100,
    });
  });

  test("GET certifications returns earned tracks for the selected range", async () => {
    const res = await dashboardFetch(
      `${baseUrl}/api/manager/dashboard-command-center/certifications?since=2026-02-01T00:00:00.000Z&until=2026-02-03T23:59:59.999Z`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.certifications, [{
      consultantName: "Bob B",
      track: "consulting",
      certifiedAt: "2026-02-02T00:00:00.000Z",
    }]);
  });

  test("an explicit since/until makes the performance-over-time series span the full selected range, not just 7 days", async () => {
    // Fixtures' sessions run 2026-03-01..04; a since/until spanning Jan-Apr
    // must produce far more than the old hardcoded 8-day (7-day + today) series.
    const res = await dashboardFetch(
      `${baseUrl}/api/manager/dashboard-command-center?since=2026-01-01T00:00:00.000Z&until=2026-04-01T00:00:00.000Z`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.performanceOverTime.length > 8, "expected the day-by-day series to cover the full multi-month range");
  });

  test("a narrow since/until still returns a day-by-day series clipped to that exact range", async () => {
    const res = await dashboardFetch(
      `${baseUrl}/api/manager/dashboard-command-center?since=2026-03-01T00:00:00.000Z&until=2026-03-02T23:59:59.999Z`,
    );
    const body = await res.json();
    assert.equal(body.performanceOverTime.length, 2);
  });

  test("omitting since/until keeps the old 7-day-trailing conversations sparkline length", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-command-center`);
    const body = await res.json();
    assert.equal(body.conversations.sparkline.length, 8); // periodSince..now inclusive, UTC days
  });

  test("GET dashboard-widget-config returns saved defaults when nothing is stored", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-widget-config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.widgetConfig, defaultDashboardWidgetConfig());
  });

  test("PUT dashboard-widget-config persists a toggle and GET reflects it", async () => {
    const putRes = await dashboardFetch(`${baseUrl}/api/manager/dashboard-widget-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgetConfig: { alerts: false, liveFeed: false } }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.widgetConfig.alerts, false);
    assert.equal(putBody.widgetConfig.liveFeed, false);
    assert.equal(putBody.widgetConfig.teamHealth, true);

    const getRes = await dashboardFetch(`${baseUrl}/api/manager/dashboard-widget-config`);
    const getBody = await getRes.json();
    assert.equal(getBody.widgetConfig.alerts, false);
    assert.equal(officeRecord.dashboardWidgetConfig, JSON.stringify(putBody.widgetConfig));
  });

  test("PUT dashboard-widget-config merges onto the existing saved config instead of overwriting it", async () => {
    officeRecord.dashboardWidgetConfig = JSON.stringify({ ...defaultDashboardWidgetConfig(), alerts: false });
    const putRes = await dashboardFetch(`${baseUrl}/api/manager/dashboard-widget-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgetConfig: { liveFeed: false } }),
    });
    const putBody = await putRes.json();
    assert.equal(putBody.widgetConfig.alerts, false, "previously saved toggle survives an unrelated PUT");
    assert.equal(putBody.widgetConfig.liveFeed, false);
  });

  test("PUT dashboard-widget-config rejects a non-manager", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-widget-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgetConfig: { alerts: false } }),
    }, 3);
    assert.equal(res.status, 403);
  });

  test("PUT dashboard-widget-config rejects a malformed body", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/dashboard-widget-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgetConfig: "nope" }),
    });
    assert.equal(res.status, 400);
  });

  test("GET manager/session/:id requires manager/qa role", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/session/100`, undefined, 3);
    assert.equal(res.status, 403);
  });

  test("GET manager/session/:id returns full detail for a session in the requester's own office", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/session/100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.consultantName, "Alice A");
    assert.equal(body.scenarioTitle, "Kicking Tires");
    assert.equal(body.score, 90);
    assert.ok(body.rubricScores);
    assert.equal(body.rubricScores.trustBuilding, 90);
    assert.equal(body.completedAt, "2026-03-01T00:00:00.000Z");
  });

  test("GET manager/session/:id includes parsed transcript and active coaching messages", async () => {
    const session = sessions.find((item) => item.id === 100)!;
    session.transcript = JSON.stringify([
      { role: "customer", content: "I need help with a vehicle.", timestamp: "2026-03-01T00:00:00.000Z" },
      { role: "consultant", content: "What matters most to you?", timestamp: "2026-03-01T00:00:30.000Z" },
    ]);
    (storage as any).listCoachingMessagesBySession = async (sessionId: number) => [
      { id: 50, sessionId, userId: 3, role: "coach", content: "Ask one more discovery question.", cleared: false, createdAt: "2026-03-01T00:01:00.000Z" },
    ];

    const res = await dashboardFetch(`${baseUrl}/api/manager/session/100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.transcript, [
      { role: "customer", content: "I need help with a vehicle.", timestamp: "2026-03-01T00:00:00.000Z" },
      { role: "consultant", content: "What matters most to you?", timestamp: "2026-03-01T00:00:30.000Z" },
    ]);
    assert.equal(body.coachingMessages.length, 1);
    assert.equal(body.coachingMessages[0].content, "Ask one more discovery question.");
  });

  test("GET manager/session/:id 404s for a session in a different office", async () => {
    // Session 100 belongs to Alice (office 1). A manager from a different
    // office must never be able to view it, even by guessing the id.
    const otherManager = mkUser({ id: 900, role: "manager", officeId: OTHER_OFFICE_ID, username: "othermgr" });
    users.push(otherManager);
    (storage as any).getOffice = async (id: number) =>
      id === officeRecord.id ? officeRecord : id === OTHER_OFFICE_ID ? { id: OTHER_OFFICE_ID, managerItemId: "si_dash_2" } : undefined;

    const res = await dashboardFetch(`${baseUrl}/api/manager/session/100`, undefined, 900);
    assert.equal(res.status, 404);
  });

  test("GET manager/session/:id 404s for a session id that does not exist", async () => {
    const res = await dashboardFetch(`${baseUrl}/api/manager/session/999999`);
    assert.equal(res.status, 404);
  });
});
