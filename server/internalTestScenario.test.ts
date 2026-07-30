// The internal test scenario: a real practice scenario that must be invisible to
// and unstartable by everyone except one configured internal account, in both
// staging and production.
//
// Two layers are covered. The pure layer proves the slug set, the username gate
// and the realTrainingScenarios choke point behave correctly (including the
// fail-closed default). The HTTP layer mounts the real routes on a bare express
// app, in the style of roster.test.ts, and proves the listing, the detail
// endpoint and session creation all agree with that gate over the wire.
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import {
  registerScenarioAndSessionRoutes,
  realTrainingScenarios,
  scenariosVisibleTo,
} from "./routes";
import {
  INTERNAL_TEST_SUV_SLUG,
  INTERNAL_TEST_SUV_SOURCE_SLUG,
  isInternalTestScenario,
  isInternalTestUser,
  internalTestUsername,
} from "./internalTestScenario";
import { scenarios as seedScenarios } from "./seed";
import { getVoiceForScenario } from "./voices";
import type { InsertScenario, Scenario, Session, User } from "@shared/schema";

const INTERNAL_USERNAME = "wade.internal";

// Ids are arbitrary and differ between environments on purpose: nothing in the
// implementation may key off them.
const INTERNAL_USER_ID = 77;
const NORMAL_USER_ID = 3;
const UNKNOWN_USER_ID = 4242;
const INTERNAL_SCENARIO_ID = 910;
const NORMAL_SCENARIO_ID = 10;

function mkUser(partial: Partial<User> & { id: number; username: string }): User {
  return {
    officeId: 1,
    password: "x",
    role: "consultant",
    displayName: `User ${partial.id}`,
    currentLevel: "beginner",
    leadershipLevel: "beginner",
    seatActive: true,
    // Demo accounts bypass the seat gate and the practice cap, which keeps these
    // tests focused on visibility instead of re-testing billing.
    isDemoAccount: true,
    consultingCertified: false,
    consultingCertifiedAt: null,
    leadershipCertified: false,
    leadershipCertifiedAt: null,
    ...partial,
  } as User;
}

function mkScenario(partial: Partial<Scenario> & { id: number; slug: string }): Scenario {
  return {
    title: `Scenario ${partial.id}`,
    vertical: "auto_sales",
    track: "consulting",
    difficulty: "beginner",
    active: true,
    briefing: "",
    description: "",
    customerPersona: "",
    personaCore: "",
    personalityVariants: "[]",
    motivationVariants: "[]",
    objectionPool: "[]",
    gender: "female",
    ...partial,
  } as Scenario;
}

// ===========================================================================
// Pure gate
// ===========================================================================

describe("internal test scenario gate (pure)", () => {
  const originalUsername = process.env.INTERNAL_TEST_USERNAME;

  afterEach(() => {
    if (originalUsername === undefined) delete process.env.INTERNAL_TEST_USERNAME;
    else process.env.INTERNAL_TEST_USERNAME = originalUsername;
  });

  test("recognises the internal test slug and nothing else", () => {
    assert.equal(isInternalTestScenario(INTERNAL_TEST_SUV_SLUG), true);
    assert.equal(isInternalTestScenario(INTERNAL_TEST_SUV_SOURCE_SLUG), false);
    assert.equal(isInternalTestScenario("auto-sales-skeptical-negotiator"), false);
  });

  test("no user qualifies when INTERNAL_TEST_USERNAME is unset", () => {
    delete process.env.INTERNAL_TEST_USERNAME;
    assert.equal(internalTestUsername(), null);
    // The fail-closed default: even a plausible-looking internal username is
    // rejected, so the scenario cannot leak before the account is configured.
    assert.equal(isInternalTestUser(mkUser({ id: 1, username: "consultant" })), false);
    assert.equal(isInternalTestUser(mkUser({ id: 1, username: INTERNAL_USERNAME })), false);
  });

  test("a blank or whitespace-only INTERNAL_TEST_USERNAME is treated as unset", () => {
    process.env.INTERNAL_TEST_USERNAME = "   ";
    assert.equal(internalTestUsername(), null);
    assert.equal(isInternalTestUser(mkUser({ id: 1, username: "   " })), false);
  });

  test("matches the configured username exactly, never a near miss", () => {
    process.env.INTERNAL_TEST_USERNAME = INTERNAL_USERNAME;
    assert.equal(isInternalTestUser(mkUser({ id: 1, username: INTERNAL_USERNAME })), true);
    assert.equal(isInternalTestUser(mkUser({ id: 2, username: "Wade.Internal" })), false);
    assert.equal(isInternalTestUser(mkUser({ id: 3, username: `${INTERNAL_USERNAME}2` })), false);
    assert.equal(isInternalTestUser(null), false);
  });

  test("realTrainingScenarios drops the internal test scenario for every pool", () => {
    process.env.INTERNAL_TEST_USERNAME = INTERNAL_USERNAME;
    const kept = realTrainingScenarios([
      { slug: INTERNAL_TEST_SUV_SLUG, active: true },
      { slug: INTERNAL_TEST_SUV_SOURCE_SLUG, active: true },
    ]);
    // No user argument exists here on purpose: the random vertical draw, the
    // certification expert picker and manager scenario coverage all flow through
    // this function, and none of them should ever surface internal content.
    assert.deepEqual(kept.map((s) => s.slug), [INTERNAL_TEST_SUV_SOURCE_SLUG]);
  });

  test("scenariosVisibleTo adds it back only for the internal account", () => {
    process.env.INTERNAL_TEST_USERNAME = INTERNAL_USERNAME;
    const all = [
      { slug: INTERNAL_TEST_SUV_SLUG, active: true },
      { slug: INTERNAL_TEST_SUV_SOURCE_SLUG, active: true },
    ];
    const forInternal = scenariosVisibleTo(all, mkUser({ id: 1, username: INTERNAL_USERNAME }));
    assert.ok(forInternal.some((s) => s.slug === INTERNAL_TEST_SUV_SLUG));

    for (const requester of [mkUser({ id: 2, username: "alice" }), null, undefined]) {
      const visible = scenariosVisibleTo(all, requester);
      assert.deepEqual(visible.map((s) => s.slug), [INTERNAL_TEST_SUV_SOURCE_SLUG]);
    }
  });

  test("an inactive internal test row stays hidden even from the internal account", () => {
    process.env.INTERNAL_TEST_USERNAME = INTERNAL_USERNAME;
    const visible = scenariosVisibleTo(
      [{ slug: INTERNAL_TEST_SUV_SLUG, active: false }],
      mkUser({ id: 1, username: INTERNAL_USERNAME }),
    );
    assert.deepEqual(visible, []);
  });
});

// ===========================================================================
// Seed content
// ===========================================================================

describe("the seeded internal test scenario", () => {
  const row = seedScenarios.find((s) => s.slug === INTERNAL_TEST_SUV_SLUG);
  const source = seedScenarios.find((s) => s.slug === INTERNAL_TEST_SUV_SOURCE_SLUG);

  test("exists exactly once, active, with the internal-labelled title", () => {
    assert.ok(row, `${INTERNAL_TEST_SUV_SLUG} is missing from the seed catalog`);
    assert.equal(seedScenarios.filter((s) => s.slug === INTERNAL_TEST_SUV_SLUG).length, 1);
    assert.equal(row!.title, "[Internal Test] Growing Family Needs More Room");
    assert.equal(row!.active, true);
  });

  test("is a verbatim clone of the Priya SUV scenario apart from slug and title", () => {
    assert.ok(source);
    // Everything that shapes the roleplay must match byte for byte, otherwise a
    // pilot run against the clone is not comparable to the real scenario.
    const carriedOver: Array<keyof InsertScenario> = [
      "customerPersona",
      "personaCore",
      "personalityVariants",
      "motivationVariants",
      "objectionPool",
      "gender",
      "difficulty",
      "briefing",
      "vertical",
    ];
    for (const field of carriedOver) {
      assert.equal(row![field], source![field], `${String(field)} diverged from the source scenario`);
    }
    assert.ok(row!.personaCore && row!.personaCore.length > 0, "personaCore was never stamped");
  });

  test("uses the same voice as the scenario it clones", () => {
    assert.equal(
      getVoiceForScenario(INTERNAL_TEST_SUV_SLUG, row!.gender),
      getVoiceForScenario(INTERNAL_TEST_SUV_SOURCE_SLUG, source!.gender),
    );
  });
});

// ===========================================================================
// HTTP
// ===========================================================================

describe("internal test scenario over HTTP", () => {
  let server: Server;
  let baseUrl: string;

  let users: User[];
  let scenarioRows: Scenario[];
  let created: Array<Partial<Session>>;

  const originalUsername = process.env.INTERNAL_TEST_USERNAME;

  before(async () => {
    const app = express();
    app.use(express.json());
    registerScenarioAndSessionRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.close();
    if (originalUsername === undefined) delete process.env.INTERNAL_TEST_USERNAME;
    else process.env.INTERNAL_TEST_USERNAME = originalUsername;
  });

  beforeEach(() => {
    process.env.INTERNAL_TEST_USERNAME = INTERNAL_USERNAME;

    users = [
      mkUser({ id: INTERNAL_USER_ID, username: INTERNAL_USERNAME }),
      mkUser({ id: NORMAL_USER_ID, username: "alice" }),
    ];
    scenarioRows = [
      mkScenario({ id: NORMAL_SCENARIO_ID, slug: INTERNAL_TEST_SUV_SOURCE_SLUG }),
      mkScenario({ id: INTERNAL_SCENARIO_ID, slug: INTERNAL_TEST_SUV_SLUG }),
    ];
    created = [];

    (storage as any).getUser = async (id: number) => users.find((u) => u.id === id);
    (storage as any).listScenarios = async () => scenarioRows;
    (storage as any).getScenario = async (id: number) => scenarioRows.find((s) => s.id === id);
    (storage as any).listSessionsByUser = async () => [];
    (storage as any).clearCoachingMessagesForUser = async () => {};
    (storage as any).createSession = async (s: Partial<Session>) => {
      const row = { ...s, id: 5000 + created.length };
      created.push(row);
      return row;
    };
  });

  const slugsFrom = async (query: string) => {
    const res = await fetch(`${baseUrl}/api/scenarios${query}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as Scenario[]).map((s) => s.slug);
  };

  // --- GET /api/scenarios ---

  test("excludes the internal test scenario for an unauthenticated request", async () => {
    assert.deepEqual(await slugsFrom(""), [INTERNAL_TEST_SUV_SOURCE_SLUG]);
  });

  test("excludes it for a normal consultant who does identify themselves", async () => {
    assert.deepEqual(
      await slugsFrom(`?requesterId=${NORMAL_USER_ID}`),
      [INTERNAL_TEST_SUV_SOURCE_SLUG],
    );
  });

  test("includes it for the internal account", async () => {
    const slugs = await slugsFrom(`?requesterId=${INTERNAL_USER_ID}`);
    assert.ok(slugs.includes(INTERNAL_TEST_SUV_SLUG));
    assert.ok(slugs.includes(INTERNAL_TEST_SUV_SOURCE_SLUG));
  });

  test("hides it from the internal account too when no internal username is configured", async () => {
    delete process.env.INTERNAL_TEST_USERNAME;
    assert.deepEqual(
      await slugsFrom(`?requesterId=${INTERNAL_USER_ID}`),
      [INTERNAL_TEST_SUV_SOURCE_SLUG],
    );
  });

  test("401s on an unknown requesterId, matching the requesterId convention", async () => {
    const res = await fetch(`${baseUrl}/api/scenarios?requesterId=${UNKNOWN_USER_ID}`);
    assert.equal(res.status, 401);
  });

  test("the ?track= filter still applies on top of the internal listing", async () => {
    assert.deepEqual(await slugsFrom(`?requesterId=${INTERNAL_USER_ID}&track=leadership`), []);
  });

  // --- GET /api/scenarios/:id ---

  test("404s the internal scenario by id for an unauthenticated request", async () => {
    const res = await fetch(`${baseUrl}/api/scenarios/${INTERNAL_SCENARIO_ID}`);
    assert.equal(res.status, 404);
  });

  test("404s the internal scenario by id for a normal consultant guessing the id", async () => {
    const res = await fetch(
      `${baseUrl}/api/scenarios/${INTERNAL_SCENARIO_ID}?requesterId=${NORMAL_USER_ID}`,
    );
    assert.equal(res.status, 404);
  });

  test("returns the internal scenario by id for the internal account", async () => {
    const res = await fetch(
      `${baseUrl}/api/scenarios/${INTERNAL_SCENARIO_ID}?requesterId=${INTERNAL_USER_ID}`,
    );
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Scenario).slug, INTERNAL_TEST_SUV_SLUG);
  });

  test("ordinary scenarios still resolve by id with no requesterId at all", async () => {
    const res = await fetch(`${baseUrl}/api/scenarios/${NORMAL_SCENARIO_ID}`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Scenario).slug, INTERNAL_TEST_SUV_SOURCE_SLUG);
  });

  // --- POST /api/sessions ---

  const startSession = (userId: number, scenarioId: number) =>
    fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, scenarioId }),
    });

  test("refuses to start the internal scenario for a normal consultant", async () => {
    const res = await startSession(NORMAL_USER_ID, INTERNAL_SCENARIO_ID);
    assert.equal(res.status, 403);
    assert.equal(created.length, 0);
  });

  test("refuses to start the internal scenario when no internal username is configured", async () => {
    delete process.env.INTERNAL_TEST_USERNAME;
    const res = await startSession(INTERNAL_USER_ID, INTERNAL_SCENARIO_ID);
    assert.equal(res.status, 403);
    assert.equal(created.length, 0);
  });

  test("starts the internal scenario for the internal account", async () => {
    const res = await startSession(INTERNAL_USER_ID, INTERNAL_SCENARIO_ID);
    assert.equal(res.status, 200);
    assert.equal(created.length, 1);
    assert.equal(created[0].scenarioId, INTERNAL_SCENARIO_ID);
    assert.equal(created[0].userId, INTERNAL_USER_ID);
  });

  test("ordinary session creation is unaffected", async () => {
    const res = await startSession(NORMAL_USER_ID, NORMAL_SCENARIO_ID);
    assert.equal(res.status, 200);
    assert.equal(created.length, 1);
    assert.equal(created[0].scenarioId, NORMAL_SCENARIO_ID);
  });
});
