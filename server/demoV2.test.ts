// Tests for the public demo flow: the no-repeat picker, the six demo scenarios,
// the four worked no-repeat examples over real HTTP (now at /api/demo/*), the
// gating that keeps those six out of real trainee training, and scoring parity
// with a real beginner session.
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes, isDemoOnlyScenario, realTrainingScenarios } from "./routes";
import { __setFetchForTests } from "./notifications";
import { normalizeEmail, signDemoToken, MAX_DEMO_SESSIONS } from "./demo";
import {
  DEMO_V2_INDUSTRIES,
  DEMO_V2_SLUGS,
  DEMO_V2_ALL_SLUGS,
  industryForSlug,
  isDemoV2Industry,
  pickNextV2Scenario,
  type DemoV2ScenarioOption,
} from "./demoV2";
import { scenarios } from "./seed";
import { personaVariantSeed } from "./personaVariants";
import {
  scoreTranscript,
  computeConsultingOverall,
  scenarioTrack,
  ADVANCE_THRESHOLD,
  closeExpectationForTransactionType,
  type ScoreResponder,
  type ScoreCacheStore,
} from "./llm";
import type {
  DemoSignup,
  DemoSession,
  Scenario,
  ScoreCache,
  InsertScoreCache,
  RubricScores,
  TranscriptMessage,
} from "@shared/schema";

// ===========================================================================
// pickNextV2Scenario (pure)
// ===========================================================================

// A synthetic pool with ids that do NOT ascend in industry order, so a test that
// passes cannot be relying on "lowest id overall" by accident.
const POOL: DemoV2ScenarioOption[] = [
  { id: 41, slug: "demo-v2-auto-1", industry: "auto" },
  { id: 42, slug: "demo-v2-auto-2", industry: "auto" },
  { id: 43, slug: "demo-v2-auto-3", industry: "auto" },
  { id: 11, slug: "demo-v2-re-1", industry: "real_estate" },
  { id: 12, slug: "demo-v2-re-2", industry: "real_estate" },
  { id: 13, slug: "demo-v2-re-3", industry: "real_estate" },
];

function idsFor(industry: "auto" | "real_estate"): number[] {
  return POOL.filter((o) => o.industry === industry).map((o) => o.id);
}

describe("pickNextV2Scenario", () => {
  test("a first-time visitor gets the first scenario in the industry's fixed order", () => {
    assert.equal(pickNextV2Scenario("auto", [], POOL).slug, "demo-v2-auto-1");
    assert.equal(pickNextV2Scenario("real_estate", [], POOL).slug, "demo-v2-re-1");
  });

  test("scenarios already seen are excluded", () => {
    const picked = pickNextV2Scenario("real_estate", [{ scenarioId: 11 }], POOL);
    assert.equal(picked.slug, "demo-v2-re-2");
  });

  test("three picks in one industry yield three distinct scenarios", () => {
    const seen: { scenarioId: number }[] = [];
    const picks: number[] = [];
    for (let i = 0; i < 3; i++) {
      const choice = pickNextV2Scenario("auto", seen, POOL);
      picks.push(choice.id);
      seen.push({ scenarioId: choice.id });
    }
    assert.equal(new Set(picks).size, 3);
    assert.deepEqual([...picks].sort(), [...idsFor("auto")].sort());
  });

  test("industry scoping: Auto history never narrows the Real Estate pool", () => {
    const allAutoSeen = idsFor("auto").map((id) => ({ scenarioId: id }));
    // Every Auto scenario is used up, yet Real Estate still starts from scratch.
    assert.equal(pickNextV2Scenario("real_estate", allAutoSeen, POOL).slug, "demo-v2-re-1");
  });

  test("industry scoping: Real Estate history never narrows the Auto pool", () => {
    const allReSeen = idsFor("real_estate").map((id) => ({ scenarioId: id }));
    assert.equal(pickNextV2Scenario("auto", allReSeen, POOL).slug, "demo-v2-auto-1");
  });

  test("the same history yields the same pick (deterministic, no randomness)", () => {
    const history = [{ scenarioId: 11 }];
    const a = pickNextV2Scenario("real_estate", history, POOL);
    const b = pickNextV2Scenario("real_estate", history, POOL);
    assert.equal(a.id, b.id);
  });

  test("exhaustion fallback: all seen returns the least recently used, not an error", () => {
    // Oldest first: re-3 was used first, so it is the least recent.
    const history = [{ scenarioId: 13 }, { scenarioId: 11 }, { scenarioId: 12 }];
    const picked = pickNextV2Scenario("real_estate", history, POOL);
    assert.equal(picked.id, 13);
  });

  test("exhaustion fallback tracks the MOST recent use of a repeated scenario", () => {
    // re-1 appears first but was also used last, so it must not be chosen.
    const history = [{ scenarioId: 11 }, { scenarioId: 12 }, { scenarioId: 13 }, { scenarioId: 11 }];
    const picked = pickNextV2Scenario("real_estate", history, POOL);
    assert.equal(picked.id, 12);
  });

  test("exhaustion fallback still respects industry scoping", () => {
    const history = idsFor("auto").map((id) => ({ scenarioId: id }));
    const picked = pickNextV2Scenario("auto", history, POOL);
    assert.equal(picked.industry, "auto");
  });

  test("a shrunken pool (one scenario deactivated) degrades to a repeat, never a throw", () => {
    const shrunk = POOL.filter((o) => o.slug !== "demo-v2-re-3");
    const history = [{ scenarioId: 11 }, { scenarioId: 12 }];
    const picked = pickNextV2Scenario("real_estate", history, shrunk);
    assert.equal(picked.id, 11);
  });

  test("an empty industry pool throws rather than returning the wrong industry", () => {
    const autoOnly = POOL.filter((o) => o.industry === "auto");
    assert.throws(() => pickNextV2Scenario("real_estate", [], autoOnly));
  });

  test("v1 (flow = null) history is not passed in, so it cannot exclude anything", () => {
    // The route filters to flow === 'v2' before calling the picker; this asserts
    // the picker's contract, that only what it is given constrains it.
    assert.equal(pickNextV2Scenario("real_estate", [], POOL).slug, "demo-v2-re-1");
  });
});

describe("demo v2 industry metadata", () => {
  test("exactly Auto and Real Estate are offered", () => {
    assert.deepEqual(DEMO_V2_INDUSTRIES.map((o) => o.key), ["auto", "real_estate"]);
  });

  test("every option has visitor-facing copy", () => {
    for (const option of DEMO_V2_INDUSTRIES) {
      assert.ok(option.label.length > 0);
      assert.ok(option.blurb.length > 0);
    }
  });

  test("industryForSlug maps every declared slug and rejects anything else", () => {
    for (const slug of DEMO_V2_SLUGS.auto) assert.equal(industryForSlug(slug), "auto");
    for (const slug of DEMO_V2_SLUGS.real_estate) assert.equal(industryForSlug(slug), "real_estate");
    assert.equal(industryForSlug("real-estate-demo-buyer-30-days"), null);
  });

  test("isDemoV2Industry rejects arbitrary input", () => {
    assert.equal(isDemoV2Industry("auto"), true);
    assert.equal(isDemoV2Industry("real_estate"), true);
    assert.equal(isDemoV2Industry("apartment_rental"), false);
    assert.equal(isDemoV2Industry(undefined), false);
  });

  test("three scenarios per industry, matching the three-session cap", () => {
    assert.equal(DEMO_V2_SLUGS.auto.length, MAX_DEMO_SESSIONS);
    assert.equal(DEMO_V2_SLUGS.real_estate.length, MAX_DEMO_SESSIONS);
  });
});

// ===========================================================================
// The six seeded scenarios
// ===========================================================================

describe("demo v2 seeded scenarios", () => {
  const rows = new Map(scenarios.filter((s) => DEMO_V2_ALL_SLUGS.includes(s.slug)).map((s) => [s.slug, s]));

  test("all six slugs exist in the seed portfolio", () => {
    assert.equal(rows.size, 6);
    for (const slug of DEMO_V2_ALL_SLUGS) assert.ok(rows.has(slug), `missing ${slug}`);
  });

  test("all six are beginner difficulty", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      assert.equal(rows.get(slug)!.difficulty, "beginner", slug);
    }
  });

  test("all six are active, because they are the live demo content", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      assert.equal(rows.get(slug)!.active, true, slug);
    }
  });

  // active:true is what USED to keep these out of real training, so the guard has
  // to be somewhere else now. These two tests are the ones that would catch a
  // regression leaking demo content to paying trainees.
  test("all six are flagged demo-only, so active:true is not the only gate", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      assert.equal(isDemoOnlyScenario(slug), true, slug);
    }
  });

  test("realTrainingScenarios drops all six while keeping ordinary active scenarios", () => {
    const kept = realTrainingScenarios(
      scenarios.map((s) => ({ slug: s.slug, active: s.active ?? false })),
    );
    for (const slug of DEMO_V2_ALL_SLUGS) {
      assert.equal(kept.some((s) => s.slug === slug), false, `${slug} leaked into the trainee pool`);
    }
    // A sanity check on the filter itself: a normal active training scenario in
    // one of the same two verticals is still offered.
    assert.ok(kept.some((s) => s.slug === "auto-sales-tech-worker-upgrade"));
    assert.ok(kept.length > 50, "the real training pool should be essentially untouched");
  });

  test("verticals match the industry they are offered under", () => {
    for (const slug of DEMO_V2_SLUGS.auto) assert.equal(rows.get(slug)!.vertical, "auto_sales", slug);
    for (const slug of DEMO_V2_SLUGS.real_estate) assert.equal(rows.get(slug)!.vertical, "real_estate", slug);
  });

  test("real estate rows carry re_buyer_agent; auto rows carry no transaction type", () => {
    for (const slug of DEMO_V2_SLUGS.real_estate) {
      assert.equal(rows.get(slug)!.transactionType, "re_buyer_agent", slug);
    }
    // The transactionType enum has no automotive member (see shared/schema.ts),
    // so auto rows leave it null exactly like the existing auto scenarios.
    for (const slug of DEMO_V2_SLUGS.auto) {
      assert.equal(rows.get(slug)!.transactionType ?? null, null, slug);
    }
  });

  test("all six resolve to the consulting track used by the discovery rubric", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      assert.equal(scenarioTrack(rows.get(slug)!.track), "consulting", slug);
    }
  });

  test("each has a persona variant seed with populated pools", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      const variant = personaVariantSeed[slug];
      assert.ok(variant, `missing persona variant for ${slug}`);
      assert.ok(variant.core.length > 500, `${slug} core is too thin`);
      assert.ok(variant.personalities.length >= 3, slug);
      assert.ok(variant.motivations.length >= 3, slug);
      assert.ok(variant.objections.length >= 3, slug);
    }
  });

  test("the seed merge pass stamps personaCore and the variation pools onto the rows", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      const row = rows.get(slug)!;
      assert.equal(row.personaCore, personaVariantSeed[slug].core, slug);
      assert.deepEqual(JSON.parse(row.personalityVariants as string), personaVariantSeed[slug].personalities);
      assert.deepEqual(JSON.parse(row.motivationVariants as string), personaVariantSeed[slug].motivations);
      assert.deepEqual(JSON.parse(row.objectionPool as string), personaVariantSeed[slug].objections);
    }
  });

  test("every persona states its opening stance and keeps the hidden need hidden", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      const core = personaVariantSeed[slug].core;
      assert.match(core, /Your opening stance:/, slug);
      assert.match(core, /do not volunteer it upfront/, slug);
      assert.match(core, /never mention you are an AI/, slug);
    }
  });

  test("every persona volunteers exactly one problem the trainee can lean into or skip", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      const core = personaVariantSeed[slug].core;
      assert.match(core, /The one thing you DO volunteer early, unprompted:/, slug);
    }
  });

  test("every persona defines the branch for good versus shallow discovery", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      assert.match(personaVariantSeed[slug].core, /The designed outcome \(keep this fixed\):/, slug);
    }
  });

  test("the six hidden motivations are all distinct", () => {
    const motivations = DEMO_V2_ALL_SLUGS.flatMap((slug) => personaVariantSeed[slug].motivations);
    assert.equal(new Set(motivations).size, motivations.length);
  });

  test("no persona reuses another's opening stance", () => {
    const openings = DEMO_V2_ALL_SLUGS.map(
      (slug) => personaVariantSeed[slug].core.match(/Your opening stance: (.*)/)?.[1] ?? slug,
    );
    assert.equal(new Set(openings).size, 6);
  });

  test("the v1 demo scenarios are untouched and still reachable by their own slugs", () => {
    const v1 = scenarios.filter((s) => s.slug === "real-estate-demo-buyer-30-days" || s.slug === "auto-sales-tech-worker-upgrade");
    assert.equal(v1.length, 2);
  });
});

// ===========================================================================
// HTTP: the four worked no-repeat examples
// ===========================================================================

describe("demo v2 endpoints", () => {
  let server: Server;
  let baseUrl: string;

  let signups: DemoSignup[];
  let sessions: DemoSession[];
  let scenarioRows: Scenario[];

  before(async () => {
    const app = express();
    app.use(express.json());
    registerPublicAndAdminRoutes(app);
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
    signups = [];
    sessions = [];
    // Ids are deliberately not in slug order so a passing assertion cannot be an
    // artifact of the pool happening to be sorted.
    scenarioRows = [
      { id: 91, slug: "demo-v2-auto-1", vertical: "auto_sales" },
      { id: 93, slug: "demo-v2-auto-2", vertical: "auto_sales" },
      { id: 92, slug: "demo-v2-auto-3", vertical: "auto_sales" },
      { id: 55, slug: "demo-v2-re-1", vertical: "real_estate" },
      { id: 54, slug: "demo-v2-re-2", vertical: "real_estate" },
      { id: 56, slug: "demo-v2-re-3", vertical: "real_estate" },
    ].map(
      (row) =>
        ({
          ...row,
          title: `Scenario ${row.slug}`,
          difficulty: "beginner",
          active: true,
          briefing: "b",
          description: "d",
          customerPersona: "p",
          personaCore: "core",
          gender: "female",
          track: "consulting",
          transactionType: row.vertical === "real_estate" ? "re_buyer_agent" : null,
        }) as unknown as Scenario,
    );

    process.env.RESEND_API_KEY = "re_test_key";
    __setFetchForTests(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));

    (storage as any).getScenarioBySlug = async (slug: string) => scenarioRows.find((s) => s.slug === slug);
    (storage as any).getScenario = async (id: number) => scenarioRows.find((s) => s.id === id);
    (storage as any).getDemoSignupByEmail = async (email: string) => signups.find((s) => s.email === email);
    (storage as any).updateDemoSignup = async (id: number, patch: any) => {
      const row = signups.find((x) => x.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    };
    (storage as any).createDemoSession = async (row: any) => {
      const created = { id: sessions.length + 1, ...row } as DemoSession;
      sessions.push(created);
      return created;
    };
    (storage as any).getDemoSession = async (id: number) => sessions.find((s) => s.id === id);
    (storage as any).updateDemoSession = async (id: number, patch: any) => {
      const row = sessions.find((x) => x.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    };
    // Ordered by ascending id, matching the real implementation, because the
    // exhaustion fallback depends on chronological ordering.
    (storage as any).listDemoSessionsBySignup = async (signupId: number) =>
      sessions.filter((s) => s.signupId === signupId).sort((a, b) => a.id - b.id);
    (storage as any).listDemoSessionsByFingerprint = async (fp: string) =>
      sessions.filter((s) => s.deviceFingerprint === fp);
    (storage as any).listDemoSessionsByIp = async (ip: string) => sessions.filter((s) => s.ipAddress === ip);
  });

  afterEach(() => {
    __setFetchForTests(null);
    delete process.env.RESEND_API_KEY;
  });

  // Each request gets a fresh IP so the per-IP cap and the shared rate limiter
  // never interfere with a no-repeat assertion.
  let ipCounter = 0;
  function post(path: string, body: unknown) {
    ipCounter += 1;
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `10.30.0.${ipCounter}` },
      body: JSON.stringify(body),
    });
  }

  function verifiedSignup(email: string): DemoSignup {
    const row = {
      id: signups.length + 1,
      email: normalizeEmail(email),
      code: null,
      codeExpiresAt: null,
      verified: true,
      sessionsUsed: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup;
    signups.push(row);
    return row;
  }

  // Runs a sequence of industry choices for one email and returns the scenario id
  // handed back for each. The LLM opening call fails without an API key and is
  // swallowed by the route, exactly as it is in the v1 tests, so the session is
  // created with an empty transcript and the pick is still observable.
  async function runSequence(email: string, choices: ("auto" | "real_estate")[]): Promise<number[]> {
    verifiedSignup(email);
    const token = signDemoToken(email);
    const picks: number[] = [];
    for (const industry of choices) {
      const res = await post("/api/demo/session", { token, industry });
      assert.equal(res.status, 200, `start failed for ${industry}`);
      const body = await res.json();
      picks.push(body.scenario.id);
      assert.equal(body.industry, industry);
    }
    return picks;
  }

  test("options are served from the server, not hardcoded in the client", async () => {
    const res = await fetch(`${baseUrl}/api/demo/options`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.options.map((o: any) => o.key), ["auto", "real_estate"]);
  });

  test("worked example 1: RE, RE, RE yields three distinct Real Estate scenarios", async () => {
    const picks = await runSequence("re3@example.com", ["real_estate", "real_estate", "real_estate"]);
    assert.equal(new Set(picks).size, 3, `expected 3 distinct, got ${picks.join(",")}`);
    for (const id of picks) {
      assert.equal(scenarioRows.find((s) => s.id === id)!.vertical, "real_estate");
    }
  });

  test("worked example 2: Auto, Auto, Auto yields three distinct Auto scenarios", async () => {
    const picks = await runSequence("auto3@example.com", ["auto", "auto", "auto"]);
    assert.equal(new Set(picks).size, 3, `expected 3 distinct, got ${picks.join(",")}`);
    for (const id of picks) {
      assert.equal(scenarioRows.find((s) => s.id === id)!.vertical, "auto_sales");
    }
  });

  test("worked example 3: RE, Auto, RE keeps the two Real Estate picks distinct", async () => {
    const picks = await runSequence("mixed-re@example.com", ["real_estate", "auto", "real_estate"]);
    assert.notEqual(picks[0], picks[2]);
    assert.equal(scenarioRows.find((s) => s.id === picks[1])!.vertical, "auto_sales");
  });

  test("worked example 4: Auto, RE, Auto keeps the two Auto picks distinct", async () => {
    const picks = await runSequence("mixed-auto@example.com", ["auto", "real_estate", "auto"]);
    assert.notEqual(picks[0], picks[2]);
    assert.equal(scenarioRows.find((s) => s.id === picks[1])!.vertical, "real_estate");
  });

  test("every v2 session row is tagged flow = v2", async () => {
    await runSequence("tagged@example.com", ["auto", "real_estate"]);
    assert.equal(sessions.length, 2);
    for (const row of sessions) assert.equal((row as any).flow, "v2");
  });

  test("legacy v1 sessions (flow null) do not shrink the v2 pool", async () => {
    const signup = verifiedSignup("hadv1@example.com");
    // A pre-existing v1 session on the same email, on a v2 scenario id.
    sessions.push({
      id: 1,
      signupId: signup.id,
      email: signup.email,
      scenarioId: 55,
      status: "completed",
      transcript: "[]",
      sessionNumber: 1,
      flow: null,
    } as unknown as DemoSession);

    const token = signDemoToken("hadv1@example.com");
    const res = await post("/api/demo/session", { token, industry: "real_estate" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.scenario.id, 55, "the v1 row must not have been treated as seen");
  });

  test("a missing or invalid industry is rejected before any usage is spent", async () => {
    verifiedSignup("badindustry@example.com");
    const token = signDemoToken("badindustry@example.com");
    for (const industry of [undefined, "", "apartment_rental"]) {
      const res = await post("/api/demo/session", { token, industry });
      assert.equal(res.status, 400);
    }
    assert.equal(sessions.length, 0);
    assert.equal(signups[0].sessionsUsed, 0);
  });

  test("an unverified token is rejected", async () => {
    const res = await post("/api/demo/session", { token: "bogus", industry: "auto" });
    assert.equal(res.status, 401);
  });

  test("the per-email cap still blocks a fourth conversation", async () => {
    const signup = verifiedSignup("capped@example.com");
    signup.sessionsUsed = MAX_DEMO_SESSIONS;
    const token = signDemoToken("capped@example.com");
    const res = await post("/api/demo/session", { token, industry: "auto" });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.limitReached, true);
    assert.equal(body.reason, "email");
    assert.equal(sessions.length, 0);
  });

  test("usage is incremented at start, so a refresh cannot buy a fourth run", async () => {
    await runSequence("counted@example.com", ["auto"]);
    assert.equal(signups[0].sessionsUsed, 1);
  });

  test("the completeness gate returns 409 on a conversation with no recommendation", async () => {
    const signup = verifiedSignup("gate@example.com");
    const token = signDemoToken("gate@example.com");
    sessions.push({
      id: 1,
      signupId: signup.id,
      email: signup.email,
      scenarioId: 91,
      status: "in_progress",
      // No consultant turn at all, so hasProposedRecommendation short-circuits to
      // false with no API call.
      transcript: JSON.stringify([{ role: "customer", content: "What's your best price?", timestamp: "2026-07-01T00:00:00.000Z" }]),
      sessionNumber: 1,
      flow: "v2",
    } as unknown as DemoSession);

    const res = await post("/api/demo/session/1/complete", { token });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.incomplete, true);
    // Nothing was scored or persisted.
    assert.equal(sessions[0].status, "in_progress");
    assert.equal(sessions[0].score, undefined);
  });

  test("a session belonging to another signup is not readable", async () => {
    verifiedSignup("owner@example.com");
    const other = verifiedSignup("other@example.com");
    sessions.push({
      id: 1,
      signupId: other.id,
      email: other.email,
      scenarioId: 91,
      status: "in_progress",
      transcript: "[]",
      sessionNumber: 1,
      flow: "v2",
    } as unknown as DemoSession);
    const token = signDemoToken("owner@example.com");
    const res = await fetch(`${baseUrl}/api/demo/session/1?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 404);
  });

  // ---- The swap: /api/demo/* is this flow, /api/demo-v2/* is gone ----------
  // A request with a token but no industry proves WHICH handler answered: the
  // retired single-scenario route accepted that body and 401'd on the bad token,
  // whereas this flow validates the industry choice first and 400s.
  test("/api/demo/session is served by the industry-choice flow, not the retired one", async () => {
    const res = await post("/api/demo/session", { token: "bogus" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /Auto Sales or Real Estate/);
  });

  test("the old parallel /api/demo-v2/* prefix no longer resolves", async () => {
    const token = signDemoToken("gone@example.com");
    for (const path of [
      "/api/demo-v2/options",
      "/api/demo-v2/session",
      "/api/demo-v2/session/1",
      "/api/demo-v2/session/1/message",
      "/api/demo-v2/session/1/complete",
    ]) {
      const res = await post(path, { token, industry: "auto" });
      assert.equal(res.status, 404, `${path} should be gone`);
    }
  });

  // The three flow-agnostic routes stay in server/routes.ts and must survive the
  // retired session routes being unmounted around them. Their behavior is covered
  // in demo.test.ts; all this asserts is that they are still mounted, by sending a
  // body each one rejects at validation (400) rather than 404s on.
  test("the shared code, verify and lead routes still answer under /api/demo", async () => {
    for (const path of ["/api/demo/request-code", "/api/demo/verify", "/api/demo/lead"]) {
      const res = await post(path, {});
      assert.equal(res.status, 400, `${path} should still be mounted`);
    }
  });
});

// ===========================================================================
// Scoring parity with a real beginner session
// ===========================================================================
// A direct unit test against the real scoreTranscript with an injected responder
// and an in-memory cache, rather than a live API-key-consuming integration test:
// it proves the v2 arguments produce byte-identical scoring to a real beginner
// session without spending tokens or making the suite network-dependent.

function makeInMemoryCache(): ScoreCacheStore {
  const rows = new Map<string, ScoreCache>();
  let nextId = 1;
  return {
    async getScoreCacheEntry(contentHash: string) {
      return rows.get(contentHash);
    },
    async createScoreCacheEntry(entry: InsertScoreCache) {
      const row = { id: nextId++, ...entry } as ScoreCache;
      rows.set(entry.contentHash, row);
      return row;
    },
  };
}

// Returns fixed sub-scores so the assertions isolate the scoring math from model
// variance. Two shapes: a shallow run and a genuine-discovery run.
function responderReturning(payload: Record<string, unknown>): ScoreResponder {
  return (async () => JSON.stringify(payload)) as ScoreResponder;
}

function turn(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: "2026-01-01T00:00:00.000Z" };
}

const SHALLOW_TRANSCRIPT = [
  turn("customer", "Just tell me your best out-the-door price on that silver SUV."),
  turn("consultant", "I can do 31,500 out the door."),
  turn("customer", "That's still more than I wanted."),
  turn("consultant", "It's the best I can do. Want it?"),
];

const GENUINE_TRANSCRIPT = [
  turn("customer", "Just tell me your best out-the-door price on that silver SUV."),
  turn("consultant", "Happy to get there. Before I do, what are you driving now and what has it been like?"),
  turn("customer", "My last one nickel and dimed me to death. Five shop visits in fourteen months."),
  turn("consultant", "That sounds expensive in more ways than one. What do you use the vehicle for?"),
  turn("customer", "I install flooring. My tools live in it, so every day it's on a lift I don't get paid."),
  turn("consultant", "So what you actually need is something that will not put you off the road. Let me walk you through this one's service history and the warranty, then we can talk numbers against that."),
  turn("customer", "Now that's a conversation I'll have."),
  turn("consultant", "Let's get you in Thursday to drive it and I'll have the records printed."),
];

const SHALLOW_SUBSCORES = {
  needsDiscovery: 40,
  objectionPrevention: 40,
  trustBuilding: 50,
  naturalClose: 40,
  relationshipContinuity: 30,
  closeOutcome: "no_commitment",
  feedback: "Went straight to price without learning anything.",
};

const GENUINE_SUBSCORES = {
  needsDiscovery: 90,
  objectionPrevention: 90,
  trustBuilding: 90,
  naturalClose: 90,
  relationshipContinuity: 90,
  closeOutcome: "scheduled_next_step",
  feedback: "Real discovery, then a recommendation built on it.",
};

describe("demo v2 scoring parity with a real beginner session", () => {
  const autoRow = scenarios.find((s) => s.slug === "demo-v2-auto-1")!;
  const reRow = scenarios.find((s) => s.slug === "demo-v2-re-1")!;

  test("an Auto v2 scenario scores identically to a real beginner consulting session", async () => {
    const responder = responderReturning(GENUINE_SUBSCORES);
    // The v2 route's exact call: (transcript, scenario.difficulty, track, scenario.transactionType).
    const v2 = await scoreTranscript(
      GENUINE_TRANSCRIPT,
      autoRow.difficulty,
      scenarioTrack(autoRow.track),
      autoRow.transactionType,
      { responder, cache: makeInMemoryCache() },
    );
    // A real beginner consulting session with no transaction type.
    const real = await scoreTranscript(GENUINE_TRANSCRIPT, "beginner", "consulting", null, {
      responder,
      cache: makeInMemoryCache(),
    });
    assert.deepEqual(v2, real);
  });

  test("a Real Estate v2 scenario scores identically to a real re_buyer_agent beginner session", async () => {
    const responder = responderReturning(GENUINE_SUBSCORES);
    const v2 = await scoreTranscript(
      GENUINE_TRANSCRIPT,
      reRow.difficulty,
      scenarioTrack(reRow.track),
      reRow.transactionType,
      { responder, cache: makeInMemoryCache() },
    );
    const real = await scoreTranscript(GENUINE_TRANSCRIPT, "beginner", "consulting", "re_buyer_agent", {
      responder,
      cache: makeInMemoryCache(),
    });
    assert.deepEqual(v2, real);
  });

  test("the score cache still short-circuits: identical input, one API call", async () => {
    let calls = 0;
    const responder = (async () => {
      calls += 1;
      return JSON.stringify(GENUINE_SUBSCORES);
    }) as ScoreResponder;
    const cache = makeInMemoryCache();
    const first = await scoreTranscript(GENUINE_TRANSCRIPT, "beginner", "consulting", null, { responder, cache });
    const second = await scoreTranscript(GENUINE_TRANSCRIPT, "beginner", "consulting", null, { responder, cache });
    assert.equal(calls, 1);
    assert.deepEqual(first, second);
  });

  test("a shallow run scores well below the 85 standard", async () => {
    const { overall } = await scoreTranscript(SHALLOW_TRANSCRIPT, "beginner", "consulting", null, {
      responder: responderReturning(SHALLOW_SUBSCORES),
      cache: makeInMemoryCache(),
    });
    assert.ok(overall < ADVANCE_THRESHOLD, `shallow run should not qualify, got ${overall}`);
  });

  test("a genuine-discovery run can reach the 80s at beginner", async () => {
    const { overall } = await scoreTranscript(GENUINE_TRANSCRIPT, "beginner", "consulting", null, {
      responder: responderReturning(GENUINE_SUBSCORES),
      cache: makeInMemoryCache(),
    });
    assert.ok(overall >= 80, `genuine run should reach the 80s, got ${overall}`);
  });

  test("beginner leniency is the same 3-point nudge these scenarios inherit, not a lower bar", () => {
    const borderline: RubricScores = {
      needsDiscovery: 82,
      objectionPrevention: 78,
      trustBuilding: 85,
      naturalClose: 85,
      relationshipContinuity: 85,
    };
    const expectation = closeExpectationForTransactionType(reRow.transactionType);
    const beginner = computeConsultingOverall(borderline, "client_agreed", "beginner", expectation);
    const intermediate = computeConsultingOverall(borderline, "client_agreed", "intermediate", expectation);
    assert.ok(beginner >= intermediate, "leniency must never lower a score");
    // The bar is still 85: leniency alone cannot manufacture a qualifying run.
    assert.ok(beginner < ADVANCE_THRESHOLD, `leniency should not reach the bar, got ${beginner}`);
  });

  test("an excellent beginner run on a v2 scenario still qualifies on its own merit", () => {
    const excellent: RubricScores = {
      needsDiscovery: 92,
      objectionPrevention: 90,
      trustBuilding: 92,
      naturalClose: 90,
      relationshipContinuity: 90,
    };
    const expectation = closeExpectationForTransactionType(reRow.transactionType);
    const score = computeConsultingOverall(excellent, "client_agreed", "beginner", expectation);
    assert.ok(score >= ADVANCE_THRESHOLD, `expected >= ${ADVANCE_THRESHOLD}, got ${score}`);
  });
});
