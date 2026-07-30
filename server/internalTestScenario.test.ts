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
  INTERNAL_TEST_ACCOUNT_USERNAME,
  INTERNAL_TEST_SUV_SLUG,
  INTERNAL_TEST_SUV_SOURCE_SLUG,
  isInternalTestScenario,
  isInternalTestUser,
  internalTestUsername,
} from "./internalTestScenario";
import { scenarios as seedScenarios, ensureInternalTestAccount } from "./seed";
import { getVoiceForScenario } from "./voices";
import type { InsertOffice, InsertScenario, Office, Scenario, Session, User } from "@shared/schema";

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
// Seeded internal test account
// ===========================================================================

describe("the seeded Testdummy account", () => {
  const OFFICE_NAME = "Internal Test Office";

  let offices: Office[];
  let usersByName: Map<string, User>;
  let createdUsers: any[];
  let createdOffices: InsertOffice[];

  const originals = {
    getUserByUsername: (storage as any).getUserByUsername,
    listOffices: (storage as any).listOffices,
    createOffice: (storage as any).createOffice,
    createUser: (storage as any).createUser,
    getOfficeByInviteCode: (storage as any).getOfficeByInviteCode,
  };

  beforeEach(() => {
    offices = [];
    usersByName = new Map();
    createdUsers = [];
    createdOffices = [];

    (storage as any).getUserByUsername = async (username: string) => usersByName.get(username);
    (storage as any).listOffices = async () => offices;
    (storage as any).getOfficeByInviteCode = async () => undefined;
    (storage as any).createOffice = async (o: InsertOffice) => {
      createdOffices.push(o);
      const row = { ...o, id: 900 + offices.length } as Office;
      offices.push(row);
      return row;
    };
    (storage as any).createUser = async (u: any) => {
      createdUsers.push(u);
      const row = { ...u, id: 700 + createdUsers.length } as User;
      usersByName.set(u.username, row);
      return row;
    };
  });

  afterEach(() => {
    Object.assign(storage as any, originals);
  });

  test("the seeded username is the literal the gate is documented with", () => {
    assert.equal(INTERNAL_TEST_ACCOUNT_USERNAME, "Testdummy");
  });

  test("creates a real, non-demo consultant that can hold a seat", async () => {
    await ensureInternalTestAccount();

    assert.equal(createdUsers.length, 1);
    const user = createdUsers[0];
    assert.equal(user.username, "Testdummy");
    assert.equal(user.password, "TestDummy@Solve");
    assert.equal(user.role, "consultant");
    // Not a demo account, so it hits checkSeatAccess and the practice cap like a
    // paying customer does; seatActive so those gates actually let it practise.
    assert.equal(user.isDemoAccount, false);
    assert.equal(user.seatActive, true);
  });

  test("puts it in its own office, never the publicly-listed Demo Office", async () => {
    await ensureInternalTestAccount();

    assert.equal(createdOffices.length, 1);
    assert.equal(createdOffices[0].name, OFFICE_NAME);
    // /api/public/demo-dashboard serves the Demo Office roster unauthenticated.
    assert.notEqual(createdOffices[0].inviteCode, "DEMO2024");
    assert.equal(createdUsers[0].officeId, offices[0].id);
    // Both office gates in checkSeatAccess must pass or the account cannot practise.
    assert.equal(createdOffices[0].status, "active");
    assert.equal(createdOffices[0].subscriptionStatus, "active");
  });

  test("does not commit its invite code: each fresh seed mints a random one", async () => {
    await ensureInternalTestAccount();
    const first = createdOffices[0].inviteCode;

    offices = [];
    usersByName = new Map();
    createdOffices = [];
    await ensureInternalTestAccount();

    assert.notEqual(createdOffices[0].inviteCode, first);
  });

  test("is idempotent: re-seeding an already-seeded database is a no-op", async () => {
    await ensureInternalTestAccount();
    await ensureInternalTestAccount();
    await ensureInternalTestAccount();

    assert.equal(createdUsers.length, 1, "duplicate Testdummy users were created");
    assert.equal(createdOffices.length, 1, "duplicate internal offices were created");
  });

  test("leaves an existing Testdummy alone, wherever it already lives", async () => {
    // A live database may already hold the account in some other office, or with
    // a rotated password. Re-seeding must never resurrect the committed default.
    usersByName.set("Testdummy", { id: 12, username: "Testdummy", officeId: 4 } as User);

    await ensureInternalTestAccount();

    assert.equal(createdUsers.length, 0);
    assert.equal(createdOffices.length, 0);
  });

  test("reuses the internal office instead of adding a second one", async () => {
    offices = [{ id: 42, name: OFFICE_NAME } as Office];

    await ensureInternalTestAccount();

    assert.equal(createdOffices.length, 0);
    assert.equal(createdUsers[0].officeId, 42);
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
    // Only reached by non-demo users, i.e. the Testdummy cases below: an active
    // office so checkSeatAccess turns on seatActive alone.
    (storage as any).getOffice = async () => ({ id: 1, status: "active", subscriptionStatus: "active" });
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

  // --- The configuration this actually ships with ---
  //
  // Everything above uses a placeholder username to prove nothing is hardcoded.
  // These use the literal "Testdummy" and the real seeded account shape, so the
  // exact value that goes into INTERNAL_TEST_USERNAME on Render is covered.

  const TESTDUMMY_USER_ID = 501;
  const CASE_VARIANT_USER_ID = 502;

  const withTestdummySeeded = () => {
    process.env.INTERNAL_TEST_USERNAME = "Testdummy";
    users = [
      // isDemoAccount: false and seatActive: true, exactly as seed.ts creates it.
      mkUser({ id: TESTDUMMY_USER_ID, username: "Testdummy", isDemoAccount: false, seatActive: true }),
      mkUser({ id: NORMAL_USER_ID, username: "alice" }),
      mkUser({ id: CASE_VARIANT_USER_ID, username: "testdummy" }),
    ];
  };

  test("INTERNAL_TEST_USERNAME=Testdummy shows the scenario to the seeded account", async () => {
    withTestdummySeeded();
    const slugs = await slugsFrom(`?requesterId=${TESTDUMMY_USER_ID}`);
    assert.ok(
      slugs.includes(INTERNAL_TEST_SUV_SLUG),
      "Testdummy could not see the internal test scenario",
    );
    assert.ok(slugs.includes(INTERNAL_TEST_SUV_SOURCE_SLUG));
  });

  test("INTERNAL_TEST_USERNAME=Testdummy hides the scenario from everybody else", async () => {
    withTestdummySeeded();
    // Anonymous, an ordinary consultant, and a case-variant near miss of the
    // configured name all get the unchanged catalog.
    for (const query of [
      "",
      `?requesterId=${NORMAL_USER_ID}`,
      `?requesterId=${CASE_VARIANT_USER_ID}`,
    ]) {
      assert.deepEqual(await slugsFrom(query), [INTERNAL_TEST_SUV_SOURCE_SLUG], `leaked via "${query}"`);
    }
  });

  test("the seeded account can actually start the internal scenario, seat gate included", async () => {
    withTestdummySeeded();
    // Non-demo, so unlike every case above this genuinely runs checkSeatAccess.
    // Proves the seeded shape (real consultant + seatActive + active office) is
    // sufficient to run a pilot, not just to see the card.
    const res = await startSession(TESTDUMMY_USER_ID, INTERNAL_SCENARIO_ID);
    assert.equal(res.status, 200);
    assert.equal(created.length, 1);
    assert.equal(created[0].userId, TESTDUMMY_USER_ID);
    assert.equal(created[0].scenarioId, INTERNAL_SCENARIO_ID);
  });

  test("a case-variant of Testdummy is refused the internal scenario", async () => {
    withTestdummySeeded();
    const res = await startSession(CASE_VARIANT_USER_ID, INTERNAL_SCENARIO_ID);
    assert.equal(res.status, 403);
    assert.equal(created.length, 0);
  });
});
