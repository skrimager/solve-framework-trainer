import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import type { Scenario, Session, User } from "@shared/schema";
import { scenarios as seededScenarios } from "./seed";
import { computeScoreCacheHash, RUBRIC_VERSION } from "./llm";
import { registerRoutes } from "./routes";
import { storage } from "./storage";

// This is an in-memory integration test of the real completion handler. The
// score cache avoids an OpenAI call while exercising the same route that stamps
// versions in production.
describe("scenario and rubric versioning", () => {
  let server: Server;
  let baseUrl: string;
  let scenarioRows: Scenario[];
  let sessionRows: Session[];

  const originals: Record<string, unknown> = {};
  const storageMethods = [
    "getOfficeByInviteCode",
    "getAdminByUsername",
    "listUsers",
    "getUserByUsername",
    "listOffices",
    "listScenarios",
    "updateScenario",
    "listDemoSignups",
    "updateDemoSignup",
    "createScenario",
    "createSession",
    "getSession",
    "getScenario",
    "getScoreCacheEntry",
    "updateSession",
    "getCertificationAttemptByScenarioSession",
    "getUser",
    "listSessionsByUser",
  ];

  const user = {
    id: 901,
    officeId: 1,
    username: "versioning-test-user",
    password: "test",
    role: "consultant",
    displayName: "Versioning Test User",
    currentLevel: "beginner",
    leadershipLevel: "beginner",
    seatActive: true,
    isDemoAccount: false,
    consultingCertified: false,
    consultingCertifiedAt: null,
    leadershipCertified: false,
    leadershipCertifiedAt: null,
  } as User;

  before(async () => {
    for (const method of storageMethods) {
      originals[method] = (storage as any)[method];
    }

    // Keep registerRoutes' production seed idempotent and entirely in-memory.
    (storage as any).getOfficeByInviteCode = async () => ({ id: 1, subscriptionStatus: "active" });
    (storage as any).getAdminByUsername = async () => ({ id: 1 });
    (storage as any).listUsers = async () => [user];
    (storage as any).getUserByUsername = async () => user;
    (storage as any).listOffices = async () => [{ id: 1, name: "Test Office" }];
    (storage as any).listDemoSignups = async () => [];
    (storage as any).updateDemoSignup = async () => undefined;
    (storage as any).listScenarios = async () => seededScenarios as Scenario[];
    (storage as any).updateScenario = async () => undefined;

    const app = express();
    app.use(express.json());
    await registerRoutes(createServer(app), app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    // All seed slugs are present so route registration does not attempt to add
    // product data. The versioned scenario is then created through storage.
    scenarioRows = seededScenarios.map((row, index) => ({
      ...row,
      id: index + 1,
      version: 1,
    })) as Scenario[];
    sessionRows = [];

    (storage as any).listScenarios = async () => scenarioRows;
    (storage as any).createScenario = async (input: Partial<Scenario>) => {
      const created = {
        ...input,
        id: 9900 + scenarioRows.length,
        version: input.version ?? 1,
      } as Scenario;
      scenarioRows.push(created);
      return created;
    };
    (storage as any).updateScenario = async (id: number, patch: Partial<Scenario>) => {
      const scenario = scenarioRows.find((row) => row.id === id);
      if (!scenario) return undefined;
      Object.assign(scenario, patch);
      return scenario;
    };
    (storage as any).getScenario = async (id: number) => scenarioRows.find((row) => row.id === id);

    (storage as any).createSession = async (input: Partial<Session>) => {
      const created = {
        ...input,
        id: 8800 + sessionRows.length,
        scenarioVersion: null,
        rubricVersion: null,
      } as Session;
      sessionRows.push(created);
      return created;
    };
    (storage as any).getSession = async (id: number) => sessionRows.find((row) => row.id === id);
    (storage as any).updateSession = async (id: number, patch: Partial<Session>) => {
      const session = sessionRows.find((row) => row.id === id);
      if (!session) return undefined;
      Object.assign(session, patch);
      return session;
    };
    (storage as any).getCertificationAttemptByScenarioSession = async () => undefined;
    (storage as any).getUser = async (id: number) => (id === user.id ? user : undefined);
    (storage as any).listSessionsByUser = async (userId: number) =>
      sessionRows.filter((session) => session.userId === userId);

    const cacheHash = computeScoreCacheHash([], "beginner", "consulting", null);
    (storage as any).getScoreCacheEntry = async (contentHash: string) =>
      contentHash === cacheHash
        ? {
            id: 1,
            contentHash,
            rubric: JSON.stringify({
              needsDiscovery: 80,
              objectionPrevention: 80,
              trustBuilding: 80,
              naturalClose: 80,
              relationshipContinuity: 80,
            }),
            feedback: "Cached test score",
            overall: 80,
            track: "consulting",
            difficulty: "beginner",
            transactionType: null,
            transcript: "[]",
            createdAt: "2026-08-09T00:00:00.000Z",
          }
        : undefined;
  });

  after(() => {
    server?.close();
    for (const [method, original] of Object.entries(originals)) {
      (storage as any)[method] = original;
    }
  });

  test("stamps completed sessions and preserves the original scenario version", async () => {
    const scenario = await storage.createScenario({
      slug: "versioning-test-scenario",
      title: "Versioning test scenario",
      vertical: "auto_sales",
      track: "consulting",
      description: "Test-only scenario",
      customerPersona: "Test customer",
      personaCore: "Test customer",
      personalityVariants: "[]",
      motivationVariants: "[]",
      objectionPool: "[]",
      gender: "female",
      difficulty: "beginner",
      briefing: "",
      active: true,
      version: 1,
    } as any);
    assert.equal(scenario.version, 1);

    const first = await storage.createSession({
      userId: user.id,
      scenarioId: scenario.id,
      status: "in_progress",
      personaVariant: null,
      transcript: "[]",
      score: null,
      rubricScores: null,
      feedback: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      completedAt: null,
    } as any);

    const complete = (sessionId: number) =>
      fetch(`${baseUrl}/api/sessions/${sessionId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });

    assert.equal((await complete(first.id)).status, 200);
    const completedFirst = await storage.getSession(first.id);
    assert.equal(completedFirst?.scenarioVersion, 1);
    assert.equal(completedFirst?.rubricVersion, RUBRIC_VERSION);

    await storage.updateScenario(scenario.id, { version: 2 });
    const second = await storage.createSession({
      ...first,
      id: undefined,
      createdAt: "2026-08-09T00:01:00.000Z",
      completedAt: null,
      status: "in_progress",
      score: null,
      rubricScores: null,
      feedback: null,
      scenarioVersion: null,
      rubricVersion: null,
    } as any);

    assert.equal((await complete(second.id)).status, 200);
    const completedSecond = await storage.getSession(second.id);
    assert.equal(completedSecond?.scenarioVersion, 2);
    assert.equal(completedSecond?.rubricVersion, RUBRIC_VERSION);

    const refetchedFirst = await storage.getSession(first.id);
    assert.equal(refetchedFirst?.scenarioVersion, 1);
    assert.equal(refetchedFirst?.rubricVersion, RUBRIC_VERSION);
  });
});
