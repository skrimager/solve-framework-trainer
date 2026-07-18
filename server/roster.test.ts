import { test, beforeEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerManagerRosterRoutes } from "./routes";
import type { User, Session, Scenario } from "@shared/schema";

// ===========================================================================
// Manager roster endpoints. Follows the opportunities.test.ts pattern: stub the
// `storage` methods with in-memory fixtures, register the real routes on a real
// express server, and assert over live HTTP responses.
// ===========================================================================

// Two offices so we can prove office-scoping isolates one manager from another's
// roster. Office 1 is the office under test; office 2 exists only to be excluded.
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
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    savedAt: null,
    ...partial,
  } as Session;
}

describe("manager roster HTTP endpoints", () => {
  let server: Server;
  let baseUrl: string;

  let users: User[];
  let sessions: Session[];
  let scenarios: Scenario[];

  before(async () => {
    const app = express();
    app.use(express.json());
    registerManagerRosterRoutes(app);
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
    // Two beginner consulting scenarios + one advanced, so qualifying-session
    // math can be exercised at a specific tier.
    scenarios = [
      { id: 10, difficulty: "beginner", track: "consulting", title: "Kicking Tires" } as Scenario,
      { id: 11, difficulty: "advanced", track: "consulting", title: "Hard Close" } as Scenario,
      { id: 12, difficulty: "beginner", track: "leadership", title: "Upset Customer" } as Scenario,
    ];

    users = [
      mkUser({ id: 1, role: "manager", username: "manager1" }),
      mkUser({ id: 2, role: "qa", username: "qa1" }),
      // Consultant with a mix of qualifying (>=85) and non-qualifying beginner sessions.
      mkUser({ id: 3, role: "consultant", username: "alice", displayName: "Alice A", currentLevel: "beginner" }),
      // Certified advanced consultant.
      mkUser({
        id: 4,
        role: "consultant",
        username: "bob",
        displayName: "Bob B",
        currentLevel: "advanced",
        consultingCertified: true,
        consultingCertifiedAt: "2026-02-02T00:00:00.000Z",
      }),
      // A consultant in a DIFFERENT office — must never appear in office 1's roster.
      mkUser({ id: 5, role: "consultant", officeId: OTHER_OFFICE_ID, username: "carol" }),
    ];

    sessions = [
      // Alice: 3 qualifying beginner sessions (90,88,86), 1 sub-bar (70), 1 in-progress.
      mkSession({ id: 100, userId: 3, scenarioId: 10, score: 90, completedAt: "2026-03-01T00:00:00.000Z" }),
      mkSession({ id: 101, userId: 3, scenarioId: 10, score: 88, completedAt: "2026-03-02T00:00:00.000Z" }),
      mkSession({ id: 102, userId: 3, scenarioId: 10, score: 86, completedAt: "2026-03-03T00:00:00.000Z" }),
      mkSession({ id: 103, userId: 3, scenarioId: 10, score: 70, completedAt: "2026-03-04T00:00:00.000Z" }),
      mkSession({ id: 104, userId: 3, scenarioId: 10, score: null, status: "in_progress", completedAt: null, createdAt: "2026-03-05T00:00:00.000Z" }),
      // Bob: one completed advanced session.
      mkSession({ id: 200, userId: 4, scenarioId: 11, score: 92, completedAt: "2026-04-01T00:00:00.000Z" }),
      // Carol (other office) — should be invisible to office 1.
      mkSession({ id: 300, userId: 5, scenarioId: 10, score: 99, completedAt: "2026-05-01T00:00:00.000Z" }),
    ];

    (storage as any).getUser = async (id: number) => users.find((u) => u.id === id);
    (storage as any).listScenarios = async () => scenarios;
    (storage as any).listUsersByOffice = async (officeId: number) => users.filter((u) => u.officeId === officeId);
    (storage as any).listSessionsByOffice = async (officeId: number) => {
      const ids = users.filter((u) => u.officeId === officeId).map((u) => u.id);
      return sessions.filter((s) => ids.includes(s.userId));
    };
    (storage as any).listSessionsByUser = async (userId: number) => sessions.filter((s) => s.userId === userId);
    (storage as any).listIndustryCertificationsByUserIds = async () => [];
    (storage as any).listIndustryCertificationsByUser = async () => [];
    (storage as any).listAcademyCreditsByOffice = async () => [];
    (storage as any).listAcademyCreditsByUser = async () => [];
    (storage as any).listRealConversationsByOffice = async () => [];
    (storage as any).listRealConversationsBySubjectRep = async () => [];
  });

  // --- Authorization ---

  test("requires a requesterId", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants`);
    assert.equal(res.status, 400);
  });

  test("rejects an unknown requester", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=999`);
    assert.equal(res.status, 401);
  });

  test("rejects a plain consultant (not manager/qa)", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=3`);
    assert.equal(res.status, 403);
  });

  test("rejects a manager from a different office", async () => {
    const other = mkUser({ id: 6, role: "manager", officeId: OTHER_OFFICE_ID });
    users.push(other);
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=6`);
    assert.equal(res.status, 403);
  });

  test("allows the office's own QA to view (shared manager/qa dashboard)", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=2`);
    assert.equal(res.status, 200);
  });

  // --- Roster contents ---

  test("returns only consultants of this office, excluding manager/qa and other offices", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=1`);
    const rows = await res.json();
    const usernames = rows.map((r: any) => r.username).sort();
    assert.deepEqual(usernames, ["alice", "bob"]);
  });

  test("computes qualifying sessions at the consultant's current tier", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=1`);
    const rows = await res.json();
    const alice = rows.find((r: any) => r.username === "alice");
    // 3 of Alice's beginner sessions cleared 85; the 70 and the in-progress do not.
    assert.equal(alice.qualifyingSessionsAtCurrentTier, 3);
    assert.equal(alice.requiredQualifyingSessions, 5);
  });

  test("computes completed count and average score over scored sessions only", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=1`);
    const rows = await res.json();
    const alice = rows.find((r: any) => r.username === "alice");
    // 4 completed (90,88,86,70); in-progress excluded. Avg = 334/4 = 83.5 -> 84.
    assert.equal(alice.totalSessionsCompleted, 4);
    assert.equal(alice.averageScore, 84);
  });

  test("reports the most recent activity date", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=1`);
    const rows = await res.json();
    const alice = rows.find((r: any) => r.username === "alice");
    // The in-progress session on 03-05 is the newest activity (uses createdAt).
    assert.equal(alice.lastSessionDate, "2026-03-05T00:00:00.000Z");
  });

  test("surfaces per-track certification status", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=1`);
    const rows = await res.json();
    const bob = rows.find((r: any) => r.username === "bob");
    assert.equal(bob.currentLevel, "advanced");
    assert.equal(bob.consultingCertified, true);
    assert.equal(bob.consultingCertifiedAt, "2026-02-02T00:00:00.000Z");
    assert.equal(bob.leadershipCertified, false);
  });

  test("consultant with no sessions has null average and zero counts", async () => {
    users.push(mkUser({ id: 7, role: "consultant", username: "dave", displayName: "Dave D" }));
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants?requesterId=1`);
    const rows = await res.json();
    const dave = rows.find((r: any) => r.username === "dave");
    assert.equal(dave.averageScore, null);
    assert.equal(dave.totalSessionsCompleted, 0);
    assert.equal(dave.qualifyingSessionsAtCurrentTier, 0);
    assert.equal(dave.lastSessionDate, null);
  });

  // --- Detail endpoint ---

  test("detail returns the consultant summary plus session history newest-first", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants/3?requesterId=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.consultant.username, "alice");
    assert.equal(body.sessions.length, 5);
    // Newest first: the 03-05 in-progress session leads.
    assert.equal(body.sessions[0].id, 104);
    assert.equal(body.sessions[0].scenarioTitle, "Kicking Tires");
    assert.equal(body.sessions[0].track, "consulting");
  });

  test("detail parses rubric JSON and tolerates malformed rubric", async () => {
    sessions.push(
      mkSession({ id: 105, userId: 3, scenarioId: 10, score: 80, rubricScores: '{"needsDiscovery":80}', completedAt: "2026-03-06T00:00:00.000Z" }),
      mkSession({ id: 106, userId: 3, scenarioId: 10, score: 80, rubricScores: "not json", completedAt: "2026-03-07T00:00:00.000Z" }),
    );
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants/3?requesterId=1`);
    const body = await res.json();
    const good = body.sessions.find((s: any) => s.id === 105);
    const bad = body.sessions.find((s: any) => s.id === 106);
    assert.deepEqual(good.rubricScores, { needsDiscovery: 80 });
    assert.equal(bad.rubricScores, null);
  });

  test("detail 404s for a user outside the office", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants/5?requesterId=1`);
    assert.equal(res.status, 404);
  });

  test("detail enforces the same manager/qa authorization", async () => {
    const res = await fetch(`${baseUrl}/api/offices/${OFFICE_ID}/consultants/3?requesterId=3`);
    assert.equal(res.status, 403);
  });
});
