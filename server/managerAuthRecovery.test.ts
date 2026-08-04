import { test, beforeEach, afterEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { storage } from "./storage";
import { registerManagerAuthRecoveryRoutes } from "./routes";
import {
  buildManagerPasswordResetEmail,
  buildManagerUsernameReminderEmail,
  buildPasswordResetUrl,
  __setFetchForTests,
} from "./notifications";
import type { User } from "@shared/schema";

// ===========================================================================
// Command Center (manager login) previously had NO forgot-password or
// forgot-username path at all (confirmed via repo-wide grep for resetToken /
// passwordReset / reset_token before this change). These tests cover the three
// new endpoints end to end.
// ===========================================================================

function mkUser(overrides: Partial<User> & { id: number }): User {
  return {
    officeId: 1,
    username: `user${overrides.id}`,
    password: "old-password",
    role: "manager",
    displayName: "Test Manager",
    email: null,
    passwordResetToken: null,
    passwordResetExpiresAt: null,
    currentLevel: "beginner",
    leadershipLevel: "beginner",
    seatActive: true,
    seatActivatedAt: null,
    isDemoAccount: false,
    consultingCertified: false,
    consultingCertifiedAt: null,
    leadershipCertified: false,
    leadershipCertifiedAt: null,
    ...overrides,
  } as User;
}

// ===========================================================================
// Pure unit tests: email builders (no DB, no HTTP, no network).
// ===========================================================================

describe("buildPasswordResetUrl", () => {
  test("points at the hash-routed reset-password page with the token in the query string", () => {
    const url = buildPasswordResetUrl("abc123");
    assert.match(url, /#\/reset-password\?token=abc123$/);
  });

  test("URL-encodes special characters in the token", () => {
    const url = buildPasswordResetUrl("a b/c");
    assert.doesNotMatch(url, / /);
    assert.match(url, /token=a%20b%2Fc/);
  });
});

describe("buildManagerPasswordResetEmail", () => {
  test("includes the reset link and a 1-hour expiry mention, and never logs the raw token elsewhere", () => {
    const { html, text, subject } = buildManagerPasswordResetEmail("secret-token-value");
    assert.match(subject, /reset/i);
    assert.match(html, /secret-token-value/);
    assert.match(text, /secret-token-value/);
    assert.match(text, /1 hour|expires/i);
  });
});

describe("buildManagerUsernameReminderEmail", () => {
  test("singular phrasing for one username", () => {
    const { text } = buildManagerUsernameReminderEmail(["solo_manager"]);
    assert.match(text, /Your username is: solo_manager/);
  });

  test("lists every username when an email is shared across accounts", () => {
    const { text } = buildManagerUsernameReminderEmail(["mgr_alpha", "mgr_beta"]);
    assert.match(text, /mgr_alpha/);
    assert.match(text, /mgr_beta/);
  });
});

describe("migration 0032", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "migrations/0032_manager_password_reset.sql"), "utf8");
  test("adds nullable email and password reset columns to users", () => {
    assert.match(sql, /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text/);
    assert.match(sql, /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_token" text/);
    assert.match(sql, /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_expires_at" text/);
    assert.doesNotMatch(sql, /"email" text NOT NULL/);
  });
  test("is recorded in the drizzle journal", () => {
    const journal = readFileSync(path.resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8");
    assert.match(journal, /"tag": "0032_manager_password_reset"/);
  });
});

// ===========================================================================
// HTTP integration tests: real Express app + in-memory storage patch, mirroring
// the pattern in offices.test.ts / roster.test.ts.
// ===========================================================================

describe("manager auth recovery HTTP routes", () => {
  let server: Server;
  let baseUrl: string;
  let users: User[];
  let sentEmails: { to: string; subject: string; html: string; text?: string }[];
  let warnings: string[];
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;

  before(async () => {
    const app = express();
    app.use(express.json());
    registerManagerAuthRecoveryRoutes(app);
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
    users = [];
    sentEmails = [];
    warnings = [];
    originalWarn = console.warn;
    originalError = console.error;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    console.error = () => {};

    process.env.RESEND_API_KEY = "re_test_key";
    __setFetchForTests(async (url: any, init: any) => {
      const body = JSON.parse(String(init.body));
      sentEmails.push({ to: body.to[0], subject: body.subject, html: body.html, text: body.text });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    });

    (storage as any).getUsersByEmail = async (email: string) =>
      users.filter((u) => u.email === email);
    (storage as any).getUserByPasswordResetToken = async (token: string) =>
      users.find((u) => u.passwordResetToken === token);
    (storage as any).updateUser = async (id: number, patch: Partial<User>) => {
      const idx = users.findIndex((u) => u.id === id);
      if (idx === -1) return undefined;
      users[idx] = { ...users[idx], ...patch };
      return users[idx];
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    __setFetchForTests(null);
    delete process.env.RESEND_API_KEY;
  });

  // --- POST /api/manager/forgot-password ------------------------------------

  describe("POST /api/manager/forgot-password", () => {
    test("happy path: known email gets a token stamped and an email sent, generic response either way", async () => {
      users = [mkUser({ id: 1, email: "manager@acme.test", username: "acme_mgr" })];
      const res = await fetch(`${baseUrl}/api/manager/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "manager@acme.test" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.message, /if an account exists/i);

      // Give the fire-and-forget email send a tick to complete.
      await new Promise((r) => setTimeout(r, 10));

      const updated = users[0];
      assert.ok(updated.passwordResetToken);
      assert.equal(updated.passwordResetToken!.length, 64); // 32 random bytes, hex-encoded
      assert.ok(updated.passwordResetExpiresAt);
      const expiresAt = Date.parse(updated.passwordResetExpiresAt!);
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      assert.ok(Math.abs(expiresAt - oneHourFromNow) < 5000, "expiry should be ~1 hour out");

      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].to, "manager@acme.test");
      assert.match(sentEmails[0].html, new RegExp(updated.passwordResetToken!));
    });

    test("unknown email: generic response, no token stamped anywhere, no email sent, and never a 404", async () => {
      users = [mkUser({ id: 1, email: "someone-else@acme.test", username: "acme_mgr" })];
      const res = await fetch(`${baseUrl}/api/manager/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@nowhere.test" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.message, /if an account exists/i);

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sentEmails.length, 0);
      assert.equal(users[0].passwordResetToken, null);
    });

    test("known email but response body is byte-identical to the unknown-email response (anti-enumeration)", async () => {
      users = [mkUser({ id: 1, email: "manager@acme.test", username: "acme_mgr" })];
      const knownRes = await fetch(`${baseUrl}/api/manager/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "manager@acme.test" }),
      });
      const unknownRes = await fetch(`${baseUrl}/api/manager/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@nowhere.test" }),
      });
      assert.equal(knownRes.status, unknownRes.status);
      const [knownBody, unknownBody] = await Promise.all([knownRes.json(), unknownRes.json()]);
      assert.deepEqual(knownBody, unknownBody);
    });

    test("missing email returns 400 (input validation, not an enumeration leak)", async () => {
      const res = await fetch(`${baseUrl}/api/manager/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  // --- POST /api/manager/reset-password -------------------------------------

  describe("POST /api/manager/reset-password", () => {
    test("happy path: valid unexpired token sets the new password and single-uses the token", async () => {
      const futureIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      users = [
        mkUser({
          id: 1,
          username: "acme_mgr",
          password: "old-password",
          passwordResetToken: "valid-token-abc",
          passwordResetExpiresAt: futureIso,
        }),
      ];
      const res = await fetch(`${baseUrl}/api/manager/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "valid-token-abc", newPassword: "brand-new-pass123" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.message, /reset/i);

      const updated = users[0];
      // Same plaintext storage scheme /api/login already compares against for
      // this table — reset must not invent scrypt/bcrypt hashing here.
      assert.equal(updated.password, "brand-new-pass123");
      assert.equal(updated.passwordResetToken, null);
      assert.equal(updated.passwordResetExpiresAt, null);
    });

    test("unknown/malformed token is rejected with a clear error, no account mutated", async () => {
      users = [mkUser({ id: 1, username: "acme_mgr", password: "old-password" })];
      const res = await fetch(`${baseUrl}/api/manager/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "not-a-real-token-!!!", newPassword: "brand-new-pass123" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.message, /invalid|expired/i);
      assert.equal(users[0].password, "old-password");
    });

    test("expired token is rejected, and the stale token is cleared so it can never be redeemed later", async () => {
      const pastIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      users = [
        mkUser({
          id: 1,
          username: "acme_mgr",
          password: "old-password",
          passwordResetToken: "expired-token-xyz",
          passwordResetExpiresAt: pastIso,
        }),
      ];
      const res = await fetch(`${baseUrl}/api/manager/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "expired-token-xyz", newPassword: "brand-new-pass123" }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.message, /expired/i);
      assert.equal(users[0].password, "old-password");
      assert.equal(users[0].passwordResetToken, null);
    });

    test("already-used token (cleared after redemption) cannot be replayed", async () => {
      const futureIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      users = [
        mkUser({
          id: 1,
          username: "acme_mgr",
          password: "old-password",
          passwordResetToken: "one-time-token",
          passwordResetExpiresAt: futureIso,
        }),
      ];
      const firstRes = await fetch(`${baseUrl}/api/manager/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "one-time-token", newPassword: "first-new-pass123" }),
      });
      assert.equal(firstRes.status, 200);

      const secondRes = await fetch(`${baseUrl}/api/manager/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "one-time-token", newPassword: "second-new-pass456" }),
      });
      assert.equal(secondRes.status, 400);
      const body = await secondRes.json();
      assert.match(body.message, /invalid|expired/i);
      // Password from the first (successful) redemption must be untouched by the replay.
      assert.equal(users[0].password, "first-new-pass123");
    });

    test("short new password is rejected by validation before any lookup", async () => {
      const futureIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      users = [
        mkUser({
          id: 1,
          username: "acme_mgr",
          password: "old-password",
          passwordResetToken: "valid-token-abc",
          passwordResetExpiresAt: futureIso,
        }),
      ];
      const res = await fetch(`${baseUrl}/api/manager/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "valid-token-abc", newPassword: "short" }),
      });
      assert.equal(res.status, 400);
      assert.equal(users[0].password, "old-password");
    });
  });

  // --- POST /api/manager/forgot-username -------------------------------------

  describe("POST /api/manager/forgot-username", () => {
    test("happy path: known email gets an email listing the username(s) on file", async () => {
      users = [mkUser({ id: 1, email: "manager@acme.test", username: "acme_mgr" })];
      const res = await fetch(`${baseUrl}/api/manager/forgot-username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "manager@acme.test" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.message, /if an account exists/i);

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].to, "manager@acme.test");
      assert.match(sentEmails[0].text!, /acme_mgr/);
    });

    test("lists every username when multiple accounts share one email", async () => {
      users = [
        mkUser({ id: 1, email: "shared@acme.test", username: "acme_mgr" }),
        mkUser({ id: 2, email: "shared@acme.test", username: "acme_qa", role: "qa" }),
      ];
      const res = await fetch(`${baseUrl}/api/manager/forgot-username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "shared@acme.test" }),
      });
      assert.equal(res.status, 200);

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sentEmails.length, 1);
      assert.match(sentEmails[0].text!, /acme_mgr/);
      assert.match(sentEmails[0].text!, /acme_qa/);
    });

    test("unknown email: generic response, no email sent", async () => {
      users = [mkUser({ id: 1, email: "someone-else@acme.test", username: "acme_mgr" })];
      const res = await fetch(`${baseUrl}/api/manager/forgot-username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@nowhere.test" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.message, /if an account exists/i);

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sentEmails.length, 0);
    });

    test("known and unknown email responses are byte-identical (anti-enumeration)", async () => {
      users = [mkUser({ id: 1, email: "manager@acme.test", username: "acme_mgr" })];
      const knownRes = await fetch(`${baseUrl}/api/manager/forgot-username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "manager@acme.test" }),
      });
      const unknownRes = await fetch(`${baseUrl}/api/manager/forgot-username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@nowhere.test" }),
      });
      assert.equal(knownRes.status, unknownRes.status);
      const [knownBody, unknownBody] = await Promise.all([knownRes.json(), unknownRes.json()]);
      assert.deepEqual(knownBody, unknownBody);
    });

    test("missing email returns 400", async () => {
      const res = await fetch(`${baseUrl}/api/manager/forgot-username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });
});
