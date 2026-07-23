import { test, beforeEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import { hashPassword } from "./admin";
import {
  userIsPaying,
  checkUserDeletable,
  runUserCascade,
  UserDeleteBlockedError,
} from "./users";
import type { AdminUser, User } from "@shared/schema";

// ===========================================================================
// Pure unit tests (no DB, no HTTP)
// ===========================================================================

describe("userIsPaying", () => {
  test("a seat-active, non-demo user is paying", () => {
    assert.equal(userIsPaying({ seatActive: true, isDemoAccount: false }), true);
  });
  test("a demo account is never paying, even when seat-active", () => {
    assert.equal(userIsPaying({ seatActive: true, isDemoAccount: true }), false);
  });
  test("a seat-inactive user is not paying", () => {
    assert.equal(userIsPaying({ seatActive: false, isDemoAccount: false }), false);
  });
});

describe("checkUserDeletable", () => {
  test("blocks a real paid seat with a clear reason", () => {
    const res = checkUserDeletable(
      { role: "consultant", seatActive: true, isDemoAccount: false },
      { otherManagerCount: 0 },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /active paid seat/i);
  });
  test("blocks the last remaining manager of an office", () => {
    const res = checkUserDeletable(
      { role: "manager", seatActive: false, isDemoAccount: false },
      { otherManagerCount: 0 },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /only manager/i);
  });
  test("allows a non-paying, non-manager test user", () => {
    const res = checkUserDeletable(
      { role: "consultant", seatActive: false, isDemoAccount: false },
      { otherManagerCount: 0 },
    );
    assert.equal(res.ok, true);
  });
  test("allows a manager when another manager remains", () => {
    const res = checkUserDeletable(
      { role: "manager", seatActive: false, isDemoAccount: false },
      { otherManagerCount: 1 },
    );
    assert.equal(res.ok, true);
  });
  test("allows a seat-active demo/QA account (test seat, not a paid seat)", () => {
    const res = checkUserDeletable(
      { role: "consultant", seatActive: true, isDemoAccount: true },
      { otherManagerCount: 0 },
    );
    assert.equal(res.ok, true);
  });
});

describe("runUserCascade", () => {
  test("runs the FK-safe steps in dependency order, user row last", async () => {
    const order: string[] = [];
    await runUserCascade(9, {
      deleteCoachingMessages: async () => { order.push("coaching"); },
      deleteCertificationAttempts: async () => { order.push("cert-attempts"); },
      deleteIndustryCertifications: async () => { order.push("industry-certs"); },
      deleteAcademyCredits: async () => { order.push("credits"); },
      deleteRealConversations: async () => { order.push("real-convos"); },
      deleteMonthlyLifecycleEmails: async () => { order.push("emails"); },
      deleteSessions: async () => { order.push("sessions"); },
      deleteUserRow: async () => { order.push("user"); },
    });
    assert.deepEqual(order, [
      "coaching",
      "cert-attempts",
      "industry-certs",
      "credits",
      "real-convos",
      "emails",
      "sessions",
      "user",
    ]);
  });
});

// ===========================================================================
// HTTP integration tests: real Express app + in-memory storage patch.
// ===========================================================================

describe("admin user delete HTTP routes", () => {
  const ADMIN_USER = "Solve Framework";
  const ADMIN_PASS = "Sooners@1031";

  let server: Server;
  let baseUrl: string;

  let admins: AdminUser[];
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
    admins = [{ id: 1, username: ADMIN_USER, passwordHash: hashPassword(ADMIN_PASS), createdAt: "2026-01-01" }];
    users = [];

    (storage as any).getAdminByUsername = async (u: string) => admins.find((a) => a.username === u);
    // The route delegates the guard + cascade to storage.deleteUser, so the stub
    // reproduces its guard contract (paying user / last manager blocked) and the
    // net effect (row removed) for the allowed path.
    (storage as any).deleteUser = async (id: number) => {
      const user = users.find((u) => u.id === id);
      if (!user) return false;
      if (userIsPaying(user)) {
        throw new UserDeleteBlockedError(
          "This user has an active paid seat and cannot be deleted. Downgrade or archive their office instead.",
        );
      }
      const otherManagers = users.filter((u) => u.officeId === user.officeId && u.role === "manager" && u.id !== id);
      if (user.role === "manager" && otherManagers.length === 0) {
        throw new UserDeleteBlockedError(
          "This is the only manager for their office. Reassign or delete the office first.",
        );
      }
      users = users.filter((u) => u.id !== id);
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

  function user(overrides: Partial<User>): User {
    return {
      id: 1,
      officeId: 1,
      username: "u",
      password: "x",
      role: "consultant",
      displayName: "Test User",
      currentLevel: "beginner",
      leadershipLevel: "beginner",
      seatActive: false,
      seatActivatedAt: null,
      isDemoAccount: false,
      consultingCertified: false,
      consultingCertifiedAt: null,
      leadershipCertified: false,
      leadershipCertifiedAt: null,
      ...overrides,
    } as User;
  }

  test("DELETE /api/admin/users/:id removes a non-paying test user", async () => {
    users = [user({ id: 1, seatActive: false }), user({ id: 2, role: "manager" })];
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/users/1`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(users.find((u) => u.id === 1), undefined);
  });

  test("DELETE is blocked with 409 and a reason for a real paid seat", async () => {
    users = [user({ id: 1, seatActive: true, isDemoAccount: false })];
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/users/1`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.message, /active paid seat/i);
    // The user is untouched.
    assert.ok(users.find((u) => u.id === 1));
  });

  test("DELETE is blocked with 409 for the last manager of an office", async () => {
    users = [user({ id: 1, role: "manager", seatActive: false })];
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/users/1`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.message, /only manager/i);
    assert.ok(users.find((u) => u.id === 1));
  });

  test("DELETE on a missing user is 404", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/users/999`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 404);
  });

  test("DELETE rejects an unauthenticated request", async () => {
    const res = await fetch(`${baseUrl}/api/admin/users/1`, { method: "DELETE" });
    assert.equal(res.status, 401);
  });
});
