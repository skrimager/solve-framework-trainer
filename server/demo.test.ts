import { test, beforeEach, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import { __setFetchForTests } from "./notifications";
import {
  MAX_DEMO_SESSIONS,
  normalizeEmail,
  generateVerificationCode,
  codeExpiryFrom,
  isCodeValid,
  isSessionLimitReached,
  remainingSessions,
  isUnlimitedDemoEmail,
  healUnlimitedDemoUsage,
  signDemoToken,
  verifyDemoToken,
  ctaSeatQuestion,
  buildVerificationEmail,
} from "./demo";
import type { DemoSignup, DemoSession, Scenario, Contact } from "@shared/schema";

// ===========================================================================
// Pure unit tests (no DB, no HTTP)
// ===========================================================================

describe("normalizeEmail", () => {
  test("trims and lowercases so one address maps to one signup", () => {
    assert.equal(normalizeEmail("  Dana@Example.COM "), "dana@example.com");
  });
});

describe("generateVerificationCode", () => {
  test("always returns a zero-padded 6-digit string", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateVerificationCode();
      assert.match(code, /^\d{6}$/);
    }
  });
});

describe("isCodeValid", () => {
  const now = Date.parse("2026-07-05T12:00:00.000Z");

  test("accepts the exact code before expiry", () => {
    const signup = { code: "123456", codeExpiresAt: new Date(now + 60_000).toISOString() };
    assert.equal(isCodeValid(signup, "123456", now), true);
  });

  test("trims whitespace on the submitted code", () => {
    const signup = { code: "123456", codeExpiresAt: new Date(now + 60_000).toISOString() };
    assert.equal(isCodeValid(signup, " 123456 ", now), true);
  });

  test("rejects a wrong code", () => {
    const signup = { code: "123456", codeExpiresAt: new Date(now + 60_000).toISOString() };
    assert.equal(isCodeValid(signup, "000000", now), false);
  });

  test("rejects an expired code", () => {
    const signup = { code: "123456", codeExpiresAt: new Date(now - 1).toISOString() };
    assert.equal(isCodeValid(signup, "123456", now), false);
  });

  test("rejects when the code has been consumed (null)", () => {
    assert.equal(isCodeValid({ code: null, codeExpiresAt: null }, "123456", now), false);
  });
});

describe("session limit helpers", () => {
  test("limit is reached only at or above MAX", () => {
    assert.equal(isSessionLimitReached(MAX_DEMO_SESSIONS - 1), false);
    assert.equal(isSessionLimitReached(MAX_DEMO_SESSIONS), true);
    assert.equal(isSessionLimitReached(MAX_DEMO_SESSIONS + 1), true);
  });

  test("remaining never goes negative", () => {
    assert.equal(remainingSessions(0), MAX_DEMO_SESSIONS);
    assert.equal(remainingSessions(MAX_DEMO_SESSIONS), 0);
    assert.equal(remainingSessions(MAX_DEMO_SESSIONS + 5), 0);
  });

  test("isUnlimitedDemoEmail recognizes the founder's exempted email, case/whitespace-insensitively", () => {
    assert.equal(isUnlimitedDemoEmail("wadeskrimager@icloud.com"), true);
    assert.equal(isUnlimitedDemoEmail("  WadeSkrimager@ICloud.com  "), true);
    assert.equal(isUnlimitedDemoEmail("someoneelse@example.com"), false);
  });

  test("an exempted email is never limit-reached even far past MAX", () => {
    const email = "wadeskrimager@icloud.com";
    assert.equal(isSessionLimitReached(MAX_DEMO_SESSIONS, email), false);
    assert.equal(isSessionLimitReached(MAX_DEMO_SESSIONS + 50, email), false);
    assert.equal(isSessionLimitReached(0, email), false);
  });

  test("an exempted email always has Infinity remaining", () => {
    const email = "wadeskrimager@icloud.com";
    assert.equal(remainingSessions(0, email), Infinity);
    assert.equal(remainingSessions(MAX_DEMO_SESSIONS, email), Infinity);
    assert.equal(remainingSessions(MAX_DEMO_SESSIONS + 100, email), Infinity);
  });

  test("a non-exempted email is unaffected by the email param (same behavior as no email)", () => {
    const email = "someoneelse@example.com";
    assert.equal(isSessionLimitReached(MAX_DEMO_SESSIONS, email), true);
    assert.equal(remainingSessions(MAX_DEMO_SESSIONS, email), 0);
  });
});

describe("healUnlimitedDemoUsage", () => {
  function fakeStore(rows: Array<Pick<DemoSignup, "id" | "email" | "sessionsUsed">>) {
    const patches: Array<{ id: number; patch: Partial<DemoSignup> }> = [];
    const store = {
      async listDemoSignups() {
        return rows as DemoSignup[];
      },
      async updateDemoSignup(id: number, patch: Partial<DemoSignup>) {
        patches.push({ id, patch });
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
        return row as DemoSignup | undefined;
      },
    };
    return { store, patches };
  }

  test("resets an allowlisted email whose stored counter is at/over the cap", async () => {
    const { store, patches } = fakeStore([
      { id: 1, email: "wadeskrimager@icloud.com", sessionsUsed: MAX_DEMO_SESSIONS },
    ]);
    const reset = await healUnlimitedDemoUsage(store);
    assert.deepEqual(reset, ["wadeskrimager@icloud.com"]);
    assert.deepEqual(patches, [{ id: 1, patch: { sessionsUsed: 0 } }]);
  });

  test("matches the allowlist case/whitespace-insensitively", async () => {
    const { store } = fakeStore([
      { id: 7, email: "  WadeSkrimager@ICloud.com ", sessionsUsed: 5 },
    ]);
    const reset = await healUnlimitedDemoUsage(store);
    assert.equal(reset.length, 1);
  });

  test("leaves non-exempt emails untouched even when over the cap", async () => {
    const { store, patches } = fakeStore([
      { id: 2, email: "someoneelse@example.com", sessionsUsed: MAX_DEMO_SESSIONS + 2 },
    ]);
    const reset = await healUnlimitedDemoUsage(store);
    assert.deepEqual(reset, []);
    assert.equal(patches.length, 0);
  });

  test("is idempotent — an allowlisted row already at 0 is not rewritten", async () => {
    const { store, patches } = fakeStore([
      { id: 3, email: "wadeskrimager@icloud.com", sessionsUsed: 0 },
    ]);
    const reset = await healUnlimitedDemoUsage(store);
    assert.deepEqual(reset, []);
    assert.equal(patches.length, 0);
  });
});

describe("demo token", () => {
  const now = Date.parse("2026-07-05T12:00:00.000Z");

  test("round-trips a normalized email", () => {
    const token = signDemoToken("Dana@Example.com", now);
    const payload = verifyDemoToken(token, now + 1000);
    assert.equal(payload?.email, "dana@example.com");
  });

  test("rejects a tampered token", () => {
    const token = signDemoToken("dana@example.com", now);
    assert.equal(verifyDemoToken(token + "x", now + 1000), null);
  });

  test("rejects an expired token", () => {
    const token = signDemoToken("dana@example.com", now);
    // 1h + 1ms later
    assert.equal(verifyDemoToken(token, now + 60 * 60 * 1000 + 1), null);
  });

  test("rejects undefined / malformed input", () => {
    assert.equal(verifyDemoToken(undefined, now), null);
    assert.equal(verifyDemoToken("nodot", now), null);
  });
});

describe("ctaSeatQuestion", () => {
  test("uses 'consultants' for the default/consulting track", () => {
    assert.equal(ctaSeatQuestion(), "How many users or consultants do you want on your team?");
    assert.equal(ctaSeatQuestion("consulting"), "How many users or consultants do you want on your team?");
  });

  test("uses 'managers' for the leadership track", () => {
    assert.equal(ctaSeatQuestion("leadership"), "How many users or managers do you want on your team?");
  });
});

describe("buildVerificationEmail", () => {
  test("subject and body carry the code", () => {
    const { subject, html } = buildVerificationEmail("987654");
    assert.match(subject, /987654/);
    assert.match(html, /987654/);
    assert.match(html, /10 minutes/);
  });
});

// ===========================================================================
// HTTP endpoint tests (bare express + monkeypatched storage)
// ===========================================================================

describe("public demo endpoints", () => {
  let server: Server;
  let baseUrl: string;

  let signups: DemoSignup[];
  let sessions: DemoSession[];
  let leads: Contact[];
  let scenario: Scenario;

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
    leads = [];
    scenario = {
      id: 7,
      slug: "real-estate-demo-buyer-30-days",
      title: "Demo",
      vertical: "real_estate",
      difficulty: "beginner",
      active: false,
      briefing: "b",
      description: "d",
      customerPersona: "p",
      gender: "female",
    } as unknown as Scenario;

    process.env.RESEND_API_KEY = "re_test_key";
    __setFetchForTests(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));

    (storage as any).getScenarioBySlug = async (slug: string) =>
      slug === scenario.slug ? scenario : undefined;
    (storage as any).getScenario = async (id: number) => (id === scenario.id ? scenario : undefined);
    (storage as any).getDemoSignupByEmail = async (email: string) =>
      signups.find((s) => s.email === email);
    (storage as any).createDemoSignup = async (row: any) => {
      const created = { id: signups.length + 1, ...row } as DemoSignup;
      signups.push(created);
      return created;
    };
    (storage as any).updateDemoSignup = async (id: number, patch: any) => {
      const s = signups.find((x) => x.id === id);
      if (!s) return undefined;
      Object.assign(s, patch);
      return s;
    };
    (storage as any).createDemoSession = async (row: any) => {
      const created = { id: sessions.length + 1, ...row } as DemoSession;
      sessions.push(created);
      return created;
    };
    (storage as any).getDemoSession = async (id: number) => sessions.find((s) => s.id === id);
    (storage as any).updateDemoSession = async (id: number, patch: any) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return undefined;
      Object.assign(s, patch);
      return s;
    };
    (storage as any).createLead = async (row: any) => {
      const created = { id: leads.length + 1, ...row } as Contact;
      leads.push(created);
      return created;
    };
  });

  afterEach(() => {
    __setFetchForTests(null);
    delete process.env.RESEND_API_KEY;
  });

  let ipCounter = 0;
  function freshIp(): string {
    ipCounter += 1;
    return `10.9.0.${ipCounter}`;
  }
  function post(path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify(body),
    });
  }

  test("request-code creates a signup and 'sends' a code", async () => {
    const res = await post("/api/demo/request-code", { email: "New@Example.com" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(signups.length, 1);
    // normalized + code stored + not yet verified
    assert.equal(signups[0].email, "new@example.com");
    assert.match(signups[0].code!, /^\d{6}$/);
    assert.equal(signups[0].verified, false);
    assert.equal(body.remaining, MAX_DEMO_SESSIONS);
  });

  test("request-code short-circuits (no code) once the email hit the limit", async () => {
    signups.push({
      id: 1,
      email: "used@example.com",
      code: null,
      codeExpiresAt: null,
      verified: true,
      sessionsUsed: MAX_DEMO_SESSIONS,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup);
    let sent = false;
    __setFetchForTests(async () => {
      sent = true;
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    });
    const res = await post("/api/demo/request-code", { email: "used@example.com" });
    const body = await res.json();
    assert.equal(body.limitReached, true);
    assert.equal(sent, false, "should not email a code when the limit is reached");
  });

  test("request-code rejects an invalid email", async () => {
    const res = await post("/api/demo/request-code", { email: "not-an-email" });
    assert.equal(res.status, 400);
  });

  test("verify with a wrong code returns 400 and no token", async () => {
    signups.push({
      id: 1,
      email: "v@example.com",
      code: "111111",
      codeExpiresAt: codeExpiryFrom(Date.now()),
      verified: false,
      sessionsUsed: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup);
    const res = await post("/api/demo/verify", { email: "v@example.com", code: "000000" });
    assert.equal(res.status, 400);
  });

  test("verify with the right code marks verified, consumes the code, and issues a token", async () => {
    signups.push({
      id: 1,
      email: "v@example.com",
      code: "222222",
      codeExpiresAt: codeExpiryFrom(Date.now()),
      verified: false,
      sessionsUsed: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup);
    const res = await post("/api/demo/verify", { email: "v@example.com", code: "222222" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verified, true);
    assert.ok(body.token);
    assert.equal(verifyDemoToken(body.token)?.email, "v@example.com");
    assert.equal(signups[0].verified, true);
    assert.equal(signups[0].code, null, "code is single-use / consumed on verify");
  });

  test("verify succeeds but withholds a token once the limit is reached", async () => {
    signups.push({
      id: 1,
      email: "v@example.com",
      code: "333333",
      codeExpiresAt: codeExpiryFrom(Date.now()),
      verified: false,
      sessionsUsed: MAX_DEMO_SESSIONS,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup);
    const res = await post("/api/demo/verify", { email: "v@example.com", code: "333333" });
    const body = await res.json();
    assert.equal(body.verified, true);
    assert.equal(body.limitReached, true);
    assert.equal(body.token, undefined);
  });

  test("starting a session requires a valid demo token", async () => {
    const res = await post("/api/demo/session", { token: "bogus" });
    assert.equal(res.status, 401);
  });

  test("starting a session is blocked once the email hit the limit", async () => {
    signups.push({
      id: 1,
      email: "full@example.com",
      code: null,
      codeExpiresAt: null,
      verified: true,
      sessionsUsed: MAX_DEMO_SESSIONS,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup);
    const token = signDemoToken("full@example.com");
    const res = await post("/api/demo/session", { token });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.limitReached, true);
    // usage was NOT incremented and no session row was created
    assert.equal(signups[0].sessionsUsed, MAX_DEMO_SESSIONS);
    assert.equal(sessions.length, 0);
  });

  test("lead capture creates a consulting contact folding in the team-size answer", async () => {
    const res = await post("/api/demo/lead", {
      name: "Dana",
      email: "Lead@Example.com",
      company: "Acme",
      teamSize: "8",
      message: "Interested",
    });
    assert.equal(res.status, 201);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].type, "consulting");
    assert.equal(leads[0].source, "role_play");
    assert.equal(leads[0].email, "lead@example.com");
    assert.match(leads[0].message!, /consultants/);
    assert.match(leads[0].message!, /8/);
    assert.match(leads[0].message!, /Interested/);
  });
});
