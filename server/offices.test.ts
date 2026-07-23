import { test, beforeEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import { hashPassword } from "./admin";
import {
  officeHasLiveStripeSubscription,
  officeIsPayingCustomer,
  filterOfficesByArchive,
  runOfficeCascade,
  OFFICE_ARCHIVE_VIEWS,
  OfficeDeleteBlockedError,
} from "./offices";
import type { AdminUser, Office } from "@shared/schema";

// ===========================================================================
// Pure unit tests (no DB, no HTTP)
// ===========================================================================

describe("officeHasLiveStripeSubscription", () => {
  test("true only with a subscription id AND a paid-up status", () => {
    assert.equal(officeHasLiveStripeSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" }), true);
    assert.equal(officeHasLiveStripeSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "trialing" }), true);
  });
  test("false for a canceled/incomplete subscription even if an id lingers", () => {
    assert.equal(officeHasLiveStripeSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "canceled" }), false);
    assert.equal(officeHasLiveStripeSubscription({ stripeSubscriptionId: "sub_1", subscriptionStatus: "incomplete" }), false);
  });
  test("false for a demo/free office (active status, no Stripe id)", () => {
    assert.equal(officeHasLiveStripeSubscription({ stripeSubscriptionId: null, subscriptionStatus: "active" }), false);
  });
});

describe("officeIsPayingCustomer", () => {
  const freeOffice = { stripeSubscriptionId: null, subscriptionStatus: "active" };
  test("paying via a live Stripe subscription", () => {
    assert.equal(officeIsPayingCustomer({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" }, []), true);
  });
  test("paying via any real paid-seat user", () => {
    assert.equal(officeIsPayingCustomer(freeOffice, [{ seatActive: true, isDemoAccount: false }]), true);
  });
  test("NOT paying: free office with only demo/seat-inactive users", () => {
    assert.equal(
      officeIsPayingCustomer(freeOffice, [
        { seatActive: true, isDemoAccount: true },
        { seatActive: false, isDemoAccount: false },
      ]),
      false,
    );
  });
});

describe("filterOfficesByArchive", () => {
  const rows = [
    { archivedAt: null },
    { archivedAt: "2026-07-10T00:00:00.000Z" },
    { archivedAt: null },
  ];
  test("active (default view) hides archived", () => {
    assert.equal(filterOfficesByArchive(rows, "active").length, 2);
  });
  test("archived returns only archived", () => {
    assert.equal(filterOfficesByArchive(rows, "archived").length, 1);
  });
  test("all returns everything", () => {
    assert.equal(filterOfficesByArchive(rows, "all").length, 3);
  });
  test("exposes the three supported views", () => {
    assert.deepEqual([...OFFICE_ARCHIVE_VIEWS], ["active", "archived", "all"]);
  });
});

describe("runOfficeCascade", () => {
  test("deletes users first, detaches audit rows, office row last", async () => {
    const order: string[] = [];
    await runOfficeCascade(3, {
      deleteUsers: async () => { order.push("users"); },
      deleteAcademyCredits: async () => { order.push("credits"); },
      deleteRealConversations: async () => { order.push("real-convos"); },
      detachPaidOfficeSignups: async () => { order.push("detach-signups"); },
      detachBillingEvents: async () => { order.push("detach-billing"); },
      deleteOfficeRow: async () => { order.push("office"); },
    });
    assert.deepEqual(order, [
      "users",
      "credits",
      "real-convos",
      "detach-signups",
      "detach-billing",
      "office",
    ]);
  });
});

describe("migration 0026", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "migrations/0026_offices_archive.sql"), "utf8");
  test("adds a nullable archived_at column to offices", () => {
    assert.match(sql, /ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "archived_at" text/);
    assert.doesNotMatch(sql, /"archived_at" text NOT NULL/);
  });
  test("is recorded in the drizzle journal", () => {
    const journal = readFileSync(path.resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8");
    assert.match(journal, /"tag": "0026_offices_archive"/);
  });
});

// ===========================================================================
// HTTP integration tests: real Express app + in-memory storage patch.
// ===========================================================================

describe("admin office archive/delete HTTP routes", () => {
  const ADMIN_USER = "Solve Framework";
  const ADMIN_PASS = "Sooners@1031";

  let server: Server;
  let baseUrl: string;

  let admins: AdminUser[];
  let offices: Office[];

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

  function office(overrides: Partial<Office>): Office {
    return {
      id: 1,
      name: "Test Office",
      inviteCode: `inv-${overrides.id ?? 1}`,
      createdAt: "2026-01-01",
      status: "active",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: "incomplete",
      managerItemId: null,
      seatItemId: null,
      activeSeatCount: 0,
      archivedAt: null,
      ...overrides,
    } as Office;
  }

  beforeEach(() => {
    admins = [{ id: 1, username: ADMIN_USER, passwordHash: hashPassword(ADMIN_PASS), createdAt: "2026-01-01" }];
    offices = [
      office({ id: 1, name: "Free Test Office", archivedAt: null }),
      office({ id: 2, name: "Paying Office", stripeSubscriptionId: "sub_1", subscriptionStatus: "active", archivedAt: null }),
      office({ id: 3, name: "Archived Office", archivedAt: "2026-07-10T00:00:00.000Z" }),
    ];

    (storage as any).getAdminByUsername = async (u: string) => admins.find((a) => a.username === u);
    (storage as any).listOffices = async () => offices;
    (storage as any).listAllAcademyCredits = async () => [];
    (storage as any).archiveOffice = async (id: number) => {
      const o = offices.find((x) => x.id === id);
      if (!o) return undefined;
      o.archivedAt = "2026-07-23T00:00:00.000Z";
      return o;
    };
    (storage as any).unarchiveOffice = async (id: number) => {
      const o = offices.find((x) => x.id === id);
      if (!o) return undefined;
      o.archivedAt = null;
      return o;
    };
    // Mirrors storage.deleteOffice: paying customers are archive-only (blocked),
    // non-paying test offices are removed.
    (storage as any).deleteOffice = async (id: number) => {
      const o = offices.find((x) => x.id === id);
      if (!o) return false;
      if (officeIsPayingCustomer(o, [])) {
        throw new OfficeDeleteBlockedError(
          "This office has an active subscription or paying users and cannot be deleted. Archive it instead.",
        );
      }
      offices = offices.filter((x) => x.id !== id);
      return true;
    };
  });

  async function login(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    return setCookie.split(";")[0];
  }

  test("GET /api/admin/sales defaults to active offices (archived hidden)", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/sales`, { headers: { cookie } });
    const body = await res.json();
    assert.deepEqual(body.rows.map((r: any) => r.officeId).sort(), [1, 2]);
  });

  test("GET /api/admin/sales?archived=archived returns only archived offices", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/sales?archived=archived`, { headers: { cookie } });
    const body = await res.json();
    assert.deepEqual(body.rows.map((r: any) => r.officeId), [3]);
    assert.ok(body.rows[0].archivedAt);
  });

  test("POST /api/admin/offices/:id/archive stamps archivedAt", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/offices/1/archive`, { method: "POST", headers: { cookie } });
    assert.equal(res.status, 200);
    assert.ok(offices.find((o) => o.id === 1)!.archivedAt);
  });

  test("POST /api/admin/offices/:id/unarchive clears archivedAt", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/offices/3/unarchive`, { method: "POST", headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(offices.find((o) => o.id === 3)!.archivedAt, null);
  });

  test("DELETE /api/admin/offices/:id removes a non-paying test office", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/offices/1`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(offices.find((o) => o.id === 1), undefined);
  });

  test("DELETE is blocked with 409 and a reason for a real paying customer", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/offices/2`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.message, /cannot be deleted/i);
    // The paying office is untouched.
    assert.ok(offices.find((o) => o.id === 2));
  });

  test("DELETE on a missing office is 404", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/offices/999`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 404);
  });

  test("archive, unarchive and delete all reject unauthenticated requests", async () => {
    const cases: [string, string][] = [
      ["POST", "/api/admin/offices/1/archive"],
      ["POST", "/api/admin/offices/1/unarchive"],
      ["DELETE", "/api/admin/offices/1"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} should be 401 without a session`);
    }
  });
});
