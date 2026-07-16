import { test, beforeEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import {
  hashPassword,
  verifyPassword,
  signAdminSession,
  verifyAdminSession,
  toCsv,
  csvCell,
  computeSalesRow,
  summarizeSales,
  calculateSeatMRR,
  RateLimiter,
} from "./admin";
import type { AdminUser, Lead, VisitorPageView, Office, User } from "@shared/schema";

// ===========================================================================
// Pure unit tests (mirror billing.test.ts: no DB, no HTTP)
// ===========================================================================

describe("password hashing", () => {
  test("hash round-trips and rejects the wrong password", () => {
    const stored = hashPassword("Sooners@1031");
    assert.ok(stored.includes(":"));
    assert.equal(verifyPassword("Sooners@1031", stored), true);
    assert.equal(verifyPassword("wrong", stored), false);
  });

  test("two hashes of the same password differ (random salt)", () => {
    assert.notEqual(hashPassword("x"), hashPassword("x"));
  });

  test("verify tolerates malformed stored value", () => {
    assert.equal(verifyPassword("x", "garbage"), false);
  });
});

describe("admin session token", () => {
  test("sign then verify returns the payload", () => {
    const token = signAdminSession(7, "Solve Framework");
    const payload = verifyAdminSession(token);
    assert.ok(payload);
    assert.equal(payload!.adminId, 7);
    assert.equal(payload!.username, "Solve Framework");
  });

  test("rejects a tampered token", () => {
    const token = signAdminSession(1, "a");
    assert.equal(verifyAdminSession(token + "x"), null);
    assert.equal(verifyAdminSession(token.replace(/.$/, "0")), null);
  });

  test("rejects an expired token", () => {
    const past = Date.now() - 1000 * 60 * 60 * 24; // signed a day ago
    const token = signAdminSession(1, "a", past);
    assert.equal(verifyAdminSession(token), null);
  });

  test("rejects undefined / empty", () => {
    assert.equal(verifyAdminSession(undefined), null);
    assert.equal(verifyAdminSession(""), null);
  });
});

describe("CSV export", () => {
  test("csvCell quotes and escapes as needed", () => {
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell("a,b"), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(42), "42");
  });

  test("toCsv produces a header + escaped rows", () => {
    const csv = toCsv(
      [
        { key: "name", header: "Name" },
        { key: "note", header: "Note" },
      ],
      [
        { name: "Ada", note: "hello, world" },
        { name: "Bob", note: null },
      ],
    );
    const lines = csv.split("\n");
    assert.equal(lines[0], "Name,Note");
    assert.equal(lines[1], 'Ada,"hello, world"');
    assert.equal(lines[2], "Bob,");
  });

  test("toCsv with no rows still emits the header", () => {
    const csv = toCsv([{ key: "a", header: "A" }], []);
    assert.equal(csv, "A");
  });
});

describe("sales aggregation", () => {
  function office(overrides: Partial<Office> = {}): Office {
    return {
      id: 1,
      name: "Acme",
      inviteCode: "ACME1234",
      createdAt: "2026-01-01",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      subscriptionStatus: "active",
      managerItemId: null,
      seatItemId: null,
      activeSeatCount: 0,
      ...overrides,
    };
  }

  test("calculateSeatMRR is flat-per-tier with the founder-confirmed totals", () => {
    assert.equal(calculateSeatMRR(1), 49); // Team
    assert.equal(calculateSeatMRR(5), 245); // Team, 5 × $49
    assert.equal(calculateSeatMRR(6), 270); // Office, 6 × $45
    assert.equal(calculateSeatMRR(20), 900); // Office, 20 × $45
    assert.equal(calculateSeatMRR(21), 861); // Company, 21 × $41
    assert.equal(calculateSeatMRR(35), 1435); // Company, 35 × $41
  });

  test("flat-per-tier cliff is intentional: 21 seats costs LESS than 20 (confirmed, not a bug)", () => {
    // Crossing 20 (Office) → 21 (Company) drops every seat to $41, so the larger
    // office is cheaper. Founder was told and chose to keep this. Asserting the
    // property documents it rather than silently "fixing" it with graduated math.
    assert.ok(calculateSeatMRR(21) < calculateSeatMRR(20));
  });

  test("Enterprise (36+) has no self-serve seat MRR", () => {
    assert.equal(calculateSeatMRR(36), 0);
    assert.equal(calculateSeatMRR(100), 0);
  });

  test("active office with NO dashboard add-on = seats only, $0 dashboard", () => {
    const row = computeSalesRow(office({ activeSeatCount: 3, managerItemId: null }));
    assert.equal(row.active, true);
    assert.equal(row.seatCount, 3);
    assert.equal(row.seatsMrr, 147); // 3 × $49 (Team)
    assert.equal(row.managerMrr, 0); // add-on not active
    assert.equal(row.mrr, 147);
  });

  test("dashboard MRR is billed at the office's CURRENT tier and moves with the tier", () => {
    // Team tier (3 seats): dashboard is $249.
    const team = computeSalesRow(office({ activeSeatCount: 3, managerItemId: "si_dash" }));
    assert.equal(team.seatsMrr, 147); // 3 × $49
    assert.equal(team.managerMrr, 249);
    assert.equal(team.mrr, 396);
    // Office tier (8 seats): the SAME add-on now bills at the $389 Office rate.
    const officeTier = computeSalesRow(office({ activeSeatCount: 8, managerItemId: "si_dash" }));
    assert.equal(officeTier.seatsMrr, 360); // 8 × $45
    assert.equal(officeTier.managerMrr, 389);
    assert.equal(officeTier.mrr, 749);
  });

  test("inactive office contributes zero MRR", () => {
    const row = computeSalesRow(office({ subscriptionStatus: "past_due", activeSeatCount: 5, managerItemId: "si_dash" }));
    assert.equal(row.active, false);
    assert.equal(row.mrr, 0);
  });

  test("Enterprise office is flagged and excluded from the standard MRR formula", () => {
    const row = computeSalesRow(office({ activeSeatCount: 40, managerItemId: "si_dash" }));
    assert.equal(row.isEnterprise, true);
    assert.equal(row.seatsMrr, 0);
    assert.equal(row.managerMrr, 0);
    assert.equal(row.mrr, 0);
  });

  test("summarizeSales totals across offices and counts Enterprise separately", () => {
    const { rows, totalMrr, activeOffices, enterpriseOffices } = summarizeSales([
      office({ id: 1, activeSeatCount: 1 }), // Team, seats only → $49
      office({ id: 2, subscriptionStatus: "canceled", activeSeatCount: 9 }), // inactive → $0
      office({ id: 3, activeSeatCount: 40 }), // Enterprise → excluded from MRR
    ]);
    assert.equal(rows.length, 3);
    assert.equal(activeOffices, 2); // office 3 is active but Enterprise
    assert.equal(enterpriseOffices, 1);
    assert.equal(totalMrr, 49); // only office 1 contributes
  });
});

describe("RateLimiter", () => {
  test("allows up to the limit then blocks within the window", () => {
    const rl = new RateLimiter(2, 1000);
    assert.equal(rl.check("ip", 0), true);
    assert.equal(rl.check("ip", 100), true);
    assert.equal(rl.check("ip", 200), false);
    // new window
    assert.equal(rl.check("ip", 1200), true);
  });

  test("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1000);
    assert.equal(rl.check("a", 0), true);
    assert.equal(rl.check("b", 0), true);
    assert.equal(rl.check("a", 0), false);
  });
});

// ===========================================================================
// HTTP integration tests: real Express app + in-memory storage patch.
// Exercises login/session/cookie/guard, public endpoints, and CSV end-to-end
// without booting seed() or touching Postgres.
// ===========================================================================

describe("admin + public HTTP routes", () => {
  const ADMIN_USER = "Solve Framework";
  const ADMIN_PASS = "Sooners@1031";

  let server: Server;
  let baseUrl: string;

  let admins: AdminUser[];
  let leads: Lead[];
  let views: VisitorPageView[];
  let offices: Office[];
  let users: User[];

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
    admins = [
      { id: 1, username: ADMIN_USER, passwordHash: hashPassword(ADMIN_PASS), createdAt: "2026-01-01" },
    ];
    leads = [];
    views = [];
    offices = [
      {
        id: 1, name: "Acme", inviteCode: "ACME1", createdAt: "2026-01-01",
        stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", subscriptionStatus: "active",
        managerItemId: null, seatItemId: null, activeSeatCount: 2,
      },
    ];
    users = [
      {
        id: 1, officeId: 1, username: "manager1", password: "x", role: "manager",
        displayName: "Manager One", currentLevel: "beginner", seatActive: true, isDemoAccount: false,
      },
    ];

    (storage as any).getAdminByUsername = async (u: string) => admins.find((a) => a.username === u);
    (storage as any).createLead = async (l: any) => {
      const row = { id: leads.length + 1, ...l };
      leads.push(row);
      return row;
    };
    (storage as any).listLeads = async () => [...leads].reverse();
    (storage as any).updateLeadStatus = async (id: number, status: string) => {
      const l = leads.find((x) => x.id === id);
      if (!l) return undefined;
      l.status = status;
      return l;
    };
    (storage as any).createVisitorPageView = async (v: any) => {
      const row = { id: views.length + 1, ...v };
      views.push(row);
      return row;
    };
    (storage as any).listVisitorPageViews = async () => [...views].reverse();
    (storage as any).listOffices = async () => offices;
    (storage as any).listUsers = async () => users;
    (storage as any).getOffice = async (id: number) => offices.find((o) => o.id === id);
    (storage as any).updateOffice = async (id: number, patch: Partial<Office>) => {
      const o = offices.find((x) => x.id === id);
      if (!o) return undefined;
      Object.assign(o, patch);
      return o;
    };
    (storage as any).listUsersByOffice = async (officeId: number) =>
      users.filter((u) => u.officeId === officeId);
    (storage as any).listAllAcademyCredits = async () => [];
    (storage as any).updateUser = async (id: number, patch: Partial<User>) => {
      const u = users.find((x) => x.id === id);
      if (!u) return undefined;
      Object.assign(u, patch);
      return u;
    };
  });

  // Each public POST uses a distinct forwarded IP so the per-IP rate limiter
  // (a module-scope singleton) doesn't bleed across independent test cases.
  let ipCounter = 0;
  function freshIp(): string {
    ipCounter += 1;
    return `10.0.0.${ipCounter}`;
  }
  async function postPublic(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp(), ...extraHeaders },
      body: JSON.stringify(body),
    });
  }

  // --- helpers ---
  async function login(pass = ADMIN_PASS): Promise<string | null> {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USER, password: pass }),
    });
    if (!res.ok) return null;
    const setCookie = res.headers.get("set-cookie");
    return setCookie ? setCookie.split(";")[0] : null;
  }

  test("admin login succeeds with correct credentials and sets the session cookie", async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /solve_admin_session=/);
    assert.match(cookie, /HttpOnly/i);
  });

  test("admin login fails with a wrong password (401, no cookie)", async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USER, password: "nope" }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  test("admin data routes reject a request with no session (401)", async () => {
    for (const path of ["/api/admin/me", "/api/admin/visitors", "/api/admin/leads", "/api/admin/users", "/api/admin/sales"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401, `${path} should be 401 without a session`);
    }
  });

  test("a non-admin (forged/garbage) cookie cannot access admin routes", async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { cookie: "solve_admin_session=not.a.valid.token" },
    });
    assert.equal(res.status, 401);
  });

  test("a valid session reaches /api/admin/me", async () => {
    const cookie = await login();
    assert.ok(cookie);
    const res = await fetch(`${baseUrl}/api/admin/me`, { headers: { cookie: cookie! } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, ADMIN_USER);
  });

  test("lead submission works and shows up in the admin Leads view", async () => {
    const submit = await postPublic("/api/leads", { name: "Dana", email: "dana@example.com", company: "Dana Co", message: "interested" });
    assert.equal(submit.status, 201);

    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/leads`, { headers: { cookie: cookie! } });
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].name, "Dana");
    assert.equal(body.rows[0].email, "dana@example.com");
    assert.equal(body.rows[0].status, "new");
  });

  test("lead submission rejects a missing email (400)", async () => {
    const res = await postPublic("/api/leads", { name: "NoEmail" });
    assert.equal(res.status, 400);
  });

  test("lead status can be updated inline", async () => {
    await postPublic("/api/leads", { name: "Eve", email: "eve@example.com" });
    const cookie = await login();
    const patch = await fetch(`${baseUrl}/api/admin/leads/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: cookie! },
      body: JSON.stringify({ status: "contacted" }),
    });
    assert.equal(patch.status, 200);
    assert.equal(leads[0].status, "contacted");
  });

  test("visit tracking works and shows up in the admin Visitors view", async () => {
    const submit = await postPublic("/api/track-visit", { path: "/pricing", referrer: "https://google.com", visitorToken: "tok-123" });
    assert.equal(submit.status, 201);

    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/visitors`, { headers: { cookie: cookie! } });
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].path, "/pricing");
    assert.equal(body.rows[0].referrer, "https://google.com");
  });

  test("CSV export produces a valid header + row for each admin table", async () => {
    // seed one lead + one visit
    await fetch(`${baseUrl}/api/leads`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CSV, Tester", email: "csv@example.com", message: 'has "quotes"' }),
    });
    await fetch(`${baseUrl}/api/track-visit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/", visitorToken: "t" }),
    });
    const cookie = await login();

    const checks: Record<string, string> = {
      leads: "Name",
      visitors: "Path",
      users: "Username",
      sales: "Office",
    };
    for (const [section, headerContains] of Object.entries(checks)) {
      const res = await fetch(`${baseUrl}/api/admin/${section}?format=csv`, { headers: { cookie: cookie! } });
      assert.equal(res.status, 200, `${section} csv status`);
      assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
      assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
      const text = await res.text();
      const lines = text.split("\n");
      assert.ok(lines[0].includes(headerContains), `${section} header should contain ${headerContains}`);
      assert.ok(lines.length >= 2, `${section} csv should have at least one data row`);
    }

    // The escaped lead field must round-trip correctly in the CSV.
    const leadsCsv = await (await fetch(`${baseUrl}/api/admin/leads?format=csv`, { headers: { cookie: cookie! } })).text();
    assert.ok(leadsCsv.includes('"CSV, Tester"'));
    assert.ok(leadsCsv.includes('"has ""quotes"""'));
  });

  test("grant-demo-access requires an admin session (401)", async () => {
    const res = await fetch(`${baseUrl}/api/admin/offices/1/grant-demo-access`, { method: "POST" });
    assert.equal(res.status, 401);
  });

  test("grant-demo-access unlocks the office and marks every user demo (Stripe-free)", async () => {
    // Start locked out with a paying (non-demo) user, mimicking a real office.
    offices[0].subscriptionStatus = "incomplete";
    users[0].isDemoAccount = false;
    users[0].seatActive = false;
    users.push({
      id: 2, officeId: 1, username: "consultant1", password: "x", role: "consultant",
      displayName: "Consultant One", currentLevel: "beginner", seatActive: false, isDemoAccount: false,
    });

    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/offices/1/grant-demo-access`, {
      method: "POST", headers: { cookie: cookie! },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.usersUpdated, 2);
    assert.equal(offices[0].subscriptionStatus, "active");
    for (const u of users) {
      assert.equal(u.isDemoAccount, true);
      assert.equal(u.seatActive, true);
    }
    // No Stripe fields are ever touched.
    assert.equal(offices[0].stripeCustomerId, "cus_1");
    assert.equal(offices[0].stripeSubscriptionId, "sub_1");
  });

  test("grant-demo-access is idempotent (calling twice is harmless)", async () => {
    const cookie = await login();
    const url = `${baseUrl}/api/admin/offices/1/grant-demo-access`;
    const first = await fetch(url, { method: "POST", headers: { cookie: cookie! } });
    const second = await fetch(url, { method: "POST", headers: { cookie: cookie! } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(offices[0].subscriptionStatus, "active");
    assert.equal(users[0].isDemoAccount, true);
    assert.equal(users[0].seatActive, true);
  });

  test("grant-demo-access returns 404 for an unknown office", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/offices/999/grant-demo-access`, {
      method: "POST", headers: { cookie: cookie! },
    });
    assert.equal(res.status, 404);
  });

  test("revoke-demo-access reverses a grant", async () => {
    const cookie = await login();
    await fetch(`${baseUrl}/api/admin/offices/1/grant-demo-access`, {
      method: "POST", headers: { cookie: cookie! },
    });
    const res = await fetch(`${baseUrl}/api/admin/offices/1/revoke-demo-access`, {
      method: "POST", headers: { cookie: cookie! },
    });
    assert.equal(res.status, 200);
    assert.equal(offices[0].subscriptionStatus, "incomplete");
    assert.equal(users[0].isDemoAccount, false);
    assert.equal(users[0].seatActive, false);
  });

  test("CORS headers are returned for an allowed marketing origin", async () => {
    const res = await fetch(`${baseUrl}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "https://www.solveframework.com" },
      body: JSON.stringify({ name: "Origin", email: "o@example.com" }),
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://www.solveframework.com");
  });
});
