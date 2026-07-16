import { test, beforeEach, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import { __setFetchForTests } from "./notifications";
import { hashPassword } from "./admin";
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
  isDeviceLimitReached,
  isIpLimitReached,
  countDemoSessionsInIpWindow,
  isVoiceUnlockedForDemo,
  isDisposableEmail,
  demoAbuseAnalytics,
  MAX_DEMO_SESSIONS_PER_DEVICE,
  MAX_DEMO_SESSIONS_PER_IP,
  IP_WINDOW_MS,
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

describe("device and IP cap helpers (pure)", () => {
  test("device limit trips only at or above the per-device cap", () => {
    assert.equal(isDeviceLimitReached(MAX_DEMO_SESSIONS_PER_DEVICE - 1), false);
    assert.equal(isDeviceLimitReached(MAX_DEMO_SESSIONS_PER_DEVICE), true);
    assert.equal(isDeviceLimitReached(MAX_DEMO_SESSIONS_PER_DEVICE + 3), true);
  });

  test("IP limit trips only at or above the per-IP cap", () => {
    assert.equal(isIpLimitReached(MAX_DEMO_SESSIONS_PER_IP - 1), false);
    assert.equal(isIpLimitReached(MAX_DEMO_SESSIONS_PER_IP), true);
    assert.equal(isIpLimitReached(MAX_DEMO_SESSIONS_PER_IP + 10), true);
  });

  test("allowlisted founder email bypasses both device and IP caps", () => {
    const email = "wadeskrimager@icloud.com";
    assert.equal(isDeviceLimitReached(MAX_DEMO_SESSIONS_PER_DEVICE + 50, email), false);
    assert.equal(isIpLimitReached(MAX_DEMO_SESSIONS_PER_IP + 50, email), false);
  });
});

describe("countDemoSessionsInIpWindow (rolling 30-day window)", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");

  test("counts sessions inside the window and excludes ones at/older than 30 days", () => {
    const sessions = [
      { createdAt: new Date(now - 1_000).toISOString() }, // just now: in
      { createdAt: new Date(now - IP_WINDOW_MS + 60_000).toISOString() }, // 30d - 1m: in
      { createdAt: new Date(now - IP_WINDOW_MS).toISOString() }, // exactly 30d: out
      { createdAt: new Date(now - IP_WINDOW_MS - 1).toISOString() }, // 31st day: out
    ];
    assert.equal(countDemoSessionsInIpWindow(sessions, now), 2);
  });

  test("a session from 31 days ago never blocks a fresh one", () => {
    const day31 = [{ createdAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() }];
    assert.equal(countDemoSessionsInIpWindow(day31, now), 0);
    assert.equal(isIpLimitReached(countDemoSessionsInIpWindow(day31, now)), false);
  });

  test("ignores unparseable timestamps", () => {
    assert.equal(countDemoSessionsInIpWindow([{ createdAt: "not-a-date" }], now), 0);
  });
});

describe("isVoiceUnlockedForDemo (cost containment: text default, voice on session 3)", () => {
  test("sessions 1 and 2 are text-only; session 3 unlocks voice", () => {
    assert.equal(isVoiceUnlockedForDemo(1), false);
    assert.equal(isVoiceUnlockedForDemo(2), false);
    assert.equal(isVoiceUnlockedForDemo(3), true);
  });

  test("allowlisted founder email always has voice, even on session 1", () => {
    assert.equal(isVoiceUnlockedForDemo(1, "wadeskrimager@icloud.com"), true);
  });
});

describe("isDisposableEmail", () => {
  test("flags a known disposable domain", () => {
    assert.equal(isDisposableEmail("someone@mailinator.com"), true);
  });

  test("allows an ordinary provider domain", () => {
    assert.equal(isDisposableEmail("dana@gmail.com"), false);
  });

  test("returns false for a malformed address with no domain", () => {
    assert.equal(isDisposableEmail("no-at-sign"), false);
  });
});

describe("demoAbuseAnalytics", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  function s(patch: Partial<DemoSession>): DemoSession {
    return {
      deviceFingerprint: null,
      ipAddress: null,
      email: "a@example.com",
      createdAt: new Date(now).toISOString(),
      ...patch,
    } as DemoSession;
  }

  test("surfaces a blocked device with its session count and distinct email count", () => {
    const sessions = [
      s({ deviceFingerprint: "fp1", email: "a@example.com" }),
      s({ deviceFingerprint: "fp1", email: "b@example.com" }),
      s({ deviceFingerprint: "fp1", email: "c@example.com" }),
      s({ deviceFingerprint: "fp2", email: "d@example.com" }),
    ];
    const a = demoAbuseAnalytics(sessions, now);
    assert.equal(a.uniqueDevices, 2);
    assert.equal(a.blockedDevices.length, 1);
    assert.equal(a.blockedDevices[0].fingerprint, "fp1");
    assert.equal(a.blockedDevices[0].sessions, 3);
    assert.equal(a.blockedDevices[0].emails, 3);
  });

  test("surfaces a blocked IP once it reaches the per-IP cap in the window", () => {
    const sessions = Array.from({ length: MAX_DEMO_SESSIONS_PER_IP }, (_, i) =>
      s({ ipAddress: "1.2.3.4", email: `e${i}@example.com` }),
    );
    const a = demoAbuseAnalytics(sessions, now);
    assert.equal(a.blockedIps.length, 1);
    assert.equal(a.blockedIps[0].ip, "1.2.3.4");
    assert.equal(a.blockedIps[0].sessions, MAX_DEMO_SESSIONS_PER_IP);
    assert.equal(a.blockedIps[0].emails, MAX_DEMO_SESSIONS_PER_IP);
  });

  test("does not flag devices/IPs below their caps", () => {
    const sessions = [
      s({ deviceFingerprint: "fp1", ipAddress: "9.9.9.9" }),
      s({ deviceFingerprint: "fp1", ipAddress: "9.9.9.9" }),
    ];
    const a = demoAbuseAnalytics(sessions, now);
    assert.equal(a.blockedDevices.length, 0);
    assert.equal(a.blockedIps.length, 0);
    assert.equal(a.totalSessions, 2);
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
    (storage as any).listDemoSessionsByFingerprint = async (fp: string) =>
      sessions.filter((s) => s.deviceFingerprint === fp);
    (storage as any).listDemoSessionsByIp = async (ip: string) =>
      sessions.filter((s) => s.ipAddress === ip);
    (storage as any).listDemoSignups = async () => signups;
    (storage as any).listDemoSessions = async () => sessions;
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
  // Same as post() but pins the client IP, so a test can exercise the durable
  // per-IP cap (multiple session starts that must all resolve to one IP).
  function postFromIp(path: string, body: unknown, ip: string) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  }
  function verifiedSignup(email: string, sessionsUsed = 0): DemoSignup {
    const row = {
      id: signups.length + 1,
      email: normalizeEmail(email),
      code: null,
      codeExpiresAt: null,
      verified: true,
      sessionsUsed,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup;
    signups.push(row);
    return row;
  }
  function seedSession(patch: Partial<DemoSession>): DemoSession {
    const row = {
      id: sessions.length + 1,
      signupId: 0,
      email: "seed@example.com",
      scenarioId: scenario.id,
      status: "in_progress",
      transcript: "[]",
      score: null,
      rubricScores: null,
      feedback: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      deviceFingerprint: null,
      ipAddress: null,
      sessionNumber: 1,
      ...patch,
    } as DemoSession;
    sessions.push(row);
    return row;
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

  // ---- Layer 3: disposable email blocked before any code is sent -----------
  test("request-code rejects a disposable domain before sending a code", async () => {
    let sent = false;
    __setFetchForTests(async () => {
      sent = true;
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    });
    const res = await post("/api/demo/request-code", { email: "throwaway@mailinator.com" });
    assert.equal(res.status, 400);
    assert.equal(sent, false, "no verification email for a disposable address");
    assert.equal(signups.length, 0, "no signup row created for a disposable address");
  });

  // ---- Verification gate: an unverified email cannot start a session -------
  test("an unverified email cannot start a session even with a signed token", async () => {
    signups.push({
      id: 1,
      email: "unverified@example.com",
      code: "111111",
      codeExpiresAt: codeExpiryFrom(Date.now()),
      verified: false,
      sessionsUsed: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup);
    const token = signDemoToken("unverified@example.com");
    const res = await post("/api/demo/session", { token });
    assert.equal(res.status, 401);
    assert.equal(sessions.length, 0);
  });

  // ---- Layer 1: same email across many devices is still capped by email ----
  test("the per-email cap holds across different devices (a new device does not reset it)", async () => {
    verifiedSignup("multidevice@example.com", MAX_DEMO_SESSIONS);
    const token = signDemoToken("multidevice@example.com");
    const res = await post("/api/demo/session", { token, fingerprint: "brand-new-device" });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.reason, "email");
    assert.equal(sessions.length, 0);
  });

  // ---- Layer 1: same device across many emails is capped by device --------
  test("a new email on an already-capped device is blocked by the device cap", async () => {
    const fp = "shared-device-fp";
    for (let i = 0; i < MAX_DEMO_SESSIONS_PER_DEVICE; i++) {
      seedSession({ deviceFingerprint: fp, email: `prev${i}@example.com`, ipAddress: "5.5.5.5" });
    }
    verifiedSignup("fresh@example.com", 0);
    const token = signDemoToken("fresh@example.com");
    const res = await post("/api/demo/session", { token, fingerprint: fp });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.reason, "device");
  });

  // ---- Layer 2: durable per-IP cap blocks the 7th session from one IP -----
  test("the 7th session from one IP is blocked by the durable per-IP cap", async () => {
    const ip = "203.0.113.7";
    // Six existing sessions from this IP, all inside the window.
    for (let i = 0; i < MAX_DEMO_SESSIONS_PER_IP; i++) {
      seedSession({ ipAddress: ip, email: `ip${i}@example.com` });
    }
    verifiedSignup("seventh@example.com", 0);
    const token = signDemoToken("seventh@example.com");
    // No fingerprint so the device cap can't interfere; email is fresh so the
    // email cap can't interfere. Only the IP cap should trip.
    const res = await postFromIp("/api/demo/session", { token }, ip);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.reason, "ip");
  });

  // ---- Allowlist bypass: founder email is never caught by device/IP caps ---
  test("an allowlisted founder email bypasses the device and IP caps", async () => {
    const founder = "wadeskrimager@icloud.com";
    const fp = "founder-device";
    const ip = "198.51.100.9";
    // Pre-load enough sessions to trip both device and IP caps for anyone else.
    for (let i = 0; i < MAX_DEMO_SESSIONS_PER_IP; i++) {
      seedSession({ deviceFingerprint: fp, ipAddress: ip, email: `x${i}@example.com` });
    }
    verifiedSignup(founder, MAX_DEMO_SESSIONS + 5);
    const token = signDemoToken(founder);
    const res = await postFromIp("/api/demo/session", { token, fingerprint: fp, scenario: "real_estate" }, ip);
    assert.equal(res.status, 200, "founder is never walled by fair-use caps");
    const body = await res.json();
    assert.ok(body.session);
    assert.equal(body.voiceEnabled, true, "founder always gets voice");
  });
});

// ===========================================================================
// Admin visibility: GET /api/admin/demo surfaces abuse-protection analytics
// ===========================================================================

describe("admin demo analytics endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let signups: DemoSignup[];
  let sessions: DemoSession[];

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
    (storage as any).listDemoSignups = async () => signups;
    (storage as any).listDemoSessions = async () => sessions;
    (storage as any).getAdminByUsername = async (username: string) =>
      username === "admin"
        ? { id: 1, username: "admin", passwordHash: hashPassword("pw") }
        : undefined;
  });

  async function loginCookie(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "pw" }),
    });
    return res.headers.get("set-cookie")!.split(";")[0];
  }

  test("returns blocked devices and IPs alongside the signup rows", async () => {
    const fp = "abusive-fp";
    const ip = "192.0.2.44";
    for (let i = 0; i < MAX_DEMO_SESSIONS_PER_DEVICE; i++) {
      sessions.push({
        id: i + 1,
        email: `churn${i}@example.com`,
        deviceFingerprint: fp,
        ipAddress: ip,
        createdAt: new Date().toISOString(),
      } as DemoSession);
    }
    signups.push({ id: 1, email: "churn0@example.com", verified: true, sessionsUsed: 3, createdAt: "2026-07-01T00:00:00.000Z", lastSentAt: null } as DemoSignup);

    const cookie = await loginCookie();
    const res = await fetch(`${baseUrl}/api/admin/demo`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.rows));
    assert.equal(body.analytics.blockedDevices.length, 1);
    assert.equal(body.analytics.blockedDevices[0].fingerprint, fp);
    assert.equal(body.analytics.blockedDevices[0].emails, MAX_DEMO_SESSIONS_PER_DEVICE);
    assert.equal(body.analytics.uniqueDevices, 1);
  });
});
