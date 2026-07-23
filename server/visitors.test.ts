import { test, beforeEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import { hashPassword } from "./admin";
import { bulkDeleteVisitorsSchema } from "./visitors";
import type { AdminUser } from "@shared/schema";

// ===========================================================================
// Pure unit tests (no DB, no HTTP)
// ===========================================================================

describe("bulkDeleteVisitorsSchema", () => {
  test("accepts a non-empty list of positive ids", () => {
    assert.equal(bulkDeleteVisitorsSchema.safeParse({ ids: [1, 2, 3] }).success, true);
  });
  test("rejects an empty list", () => {
    assert.equal(bulkDeleteVisitorsSchema.safeParse({ ids: [] }).success, false);
  });
  test("rejects non-positive or non-integer ids", () => {
    assert.equal(bulkDeleteVisitorsSchema.safeParse({ ids: [0] }).success, false);
    assert.equal(bulkDeleteVisitorsSchema.safeParse({ ids: [1.5] }).success, false);
    assert.equal(bulkDeleteVisitorsSchema.safeParse({ ids: [-2] }).success, false);
  });
  test("rejects unknown keys (strict)", () => {
    assert.equal(bulkDeleteVisitorsSchema.safeParse({ ids: [1], all: true }).success, false);
  });
});

// ===========================================================================
// HTTP integration tests: real Express app + in-memory storage patch.
// ===========================================================================

describe("admin visitors delete HTTP routes", () => {
  const ADMIN_USER = "Solve Framework";
  const ADMIN_PASS = "Sooners@1031";

  let server: Server;
  let baseUrl: string;

  let admins: AdminUser[];
  let visitors: { id: number }[];

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
    admins = [{ id: 1, username: ADMIN_USER, passwordHash: hashPassword(ADMIN_PASS), createdAt: "2026-01-01" }];
    visitors = [{ id: 1 }, { id: 2 }, { id: 3 }];

    (storage as any).getAdminByUsername = async (u: string) => admins.find((a) => a.username === u);
    (storage as any).deleteVisitorPageViews = async (ids: number[]) => {
      const before = visitors.length;
      visitors = visitors.filter((v) => !ids.includes(v.id));
      return before - visitors.length;
    };
    (storage as any).deleteAllVisitorPageViews = async () => {
      const count = visitors.length;
      visitors = [];
      return count;
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

  test("POST /api/admin/visitors/bulk-delete removes selected rows and reports the count", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/visitors/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ ids: [1, 3] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deletedCount, 2);
    assert.deepEqual(visitors.map((v) => v.id), [2]);
  });

  test("bulk-delete rejects an empty id list with 400", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/visitors/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(res.status, 400);
  });

  test("DELETE /api/admin/visitors/all clears every row and reports the count", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/visitors/all`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deletedCount, 3);
    assert.equal(visitors.length, 0);
  });

  test("both delete routes reject unauthenticated requests", async () => {
    const cases: [string, string][] = [
      ["POST", "/api/admin/visitors/bulk-delete"],
      ["DELETE", "/api/admin/visitors/all"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} should be 401 without a session`);
    }
  });
});
