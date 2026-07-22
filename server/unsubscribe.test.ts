import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import {
  normalizeUnsubEmail,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  unsubscribeFooter,
  unsubscribeConfirmationHtml,
  unsubscribeInvalidHtml,
} from "./unsubscribe";

// ===========================================================================
// Token sign/verify
// ===========================================================================

describe("signUnsubscribeToken / verifyUnsubscribeToken", () => {
  test("round-trips a normalized email", () => {
    const token = signUnsubscribeToken("A@B.com ");
    assert.equal(verifyUnsubscribeToken(token), "a@b.com");
  });

  test("rejects a tampered signature", () => {
    const token = signUnsubscribeToken("dana@example.com");
    const [body] = token.split(".");
    assert.equal(verifyUnsubscribeToken(`${body}.deadbeef`), null);
  });

  test("rejects a tampered payload (signature no longer matches)", () => {
    const token = signUnsubscribeToken("dana@example.com");
    const sig = token.split(".")[1];
    const forged = Buffer.from(JSON.stringify({ email: "evil@example.com" })).toString("base64url");
    assert.equal(verifyUnsubscribeToken(`${forged}.${sig}`), null);
  });

  test("rejects missing/garbage tokens", () => {
    assert.equal(verifyUnsubscribeToken(undefined), null);
    assert.equal(verifyUnsubscribeToken(""), null);
    assert.equal(verifyUnsubscribeToken("nodot"), null);
    assert.equal(verifyUnsubscribeToken(".onlysig"), null);
  });
});

describe("unsubscribeUrl / unsubscribeFooter", () => {
  test("builds an absolute /api/unsubscribe URL whose token verifies back", () => {
    const url = unsubscribeUrl("dana@example.com");
    assert.match(url, /\/api\/unsubscribe\?token=/);
    const token = decodeURIComponent(url.split("token=")[1]);
    assert.equal(verifyUnsubscribeToken(token), "dana@example.com");
  });

  test("footer carries the reason, a bare linkifiable URL, and brand-safe copy", () => {
    const footer = unsubscribeFooter("dana@example.com", "You are getting this because you started a demo.");
    assert.match(footer, /You are getting this because you started a demo\./);
    assert.match(footer, /https?:\/\/[^\s]*\/api\/unsubscribe\?token=/);
    // Brand voice: no "train"/"training", no em-dashes.
    assert.doesNotMatch(footer, /train/i);
    assert.doesNotMatch(footer, /—/);
  });
});

describe("confirmation / invalid pages", () => {
  test("are self-contained HTML with brand colors and no em-dashes", () => {
    for (const html of [unsubscribeConfirmationHtml(), unsubscribeInvalidHtml()]) {
      assert.match(html, /^<!doctype html>/);
      assert.doesNotMatch(html, /—/);
      assert.doesNotMatch(html, /train/i);
    }
    assert.match(unsubscribeConfirmationHtml(), /You are unsubscribed/);
    assert.match(unsubscribeInvalidHtml(), /not valid/);
  });
});

// ===========================================================================
// Migration presence
// ===========================================================================

describe("migration 0024 (suppression + monthly)", () => {
  test("creates email_suppressions and monthly_lifecycle_emails", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "migrations/0024_monthly_lifecycle_and_suppression.sql"),
      "utf8",
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "email_suppressions"/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "monthly_lifecycle_emails"/);
    assert.match(sql, /UNIQUE\("email"\)/);
  });

  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8"),
    );
    assert.ok(journal.entries.some((e: any) => e.tag === "0024_monthly_lifecycle_and_suppression"));
  });
});

// ===========================================================================
// HTTP: GET /api/unsubscribe
// ===========================================================================

describe("GET /api/unsubscribe", () => {
  let server: Server;
  let baseUrl: string;
  let suppressions: { email: string }[];
  let signupRow: any;

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

  after(() => server?.close());

  beforeEach(() => {
    suppressions = [];
    signupRow = { id: 42, email: "dana@example.com", unsubscribed: false };
    (storage as any).createEmailSuppression = async (row: any) => {
      suppressions.push(row);
      return { id: suppressions.length, ...row };
    };
    (storage as any).getDemoSignupByEmail = async (email: string) =>
      signupRow && signupRow.email === email ? signupRow : undefined;
    (storage as any).updateDemoSignup = async (id: number, patch: any) => {
      if (signupRow && signupRow.id === id) Object.assign(signupRow, patch);
      return signupRow;
    };
  });

  test("a valid token suppresses the email and flips the demo mirror flag", async () => {
    const token = signUnsubscribeToken("dana@example.com");
    const res = await fetch(`${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /You are unsubscribed/);
    assert.equal(suppressions.length, 1);
    assert.equal(suppressions[0].email, normalizeUnsubEmail("dana@example.com"));
    assert.equal(signupRow.unsubscribed, true);
  });

  test("an invalid token returns 400 and the friendly invalid page, no suppression", async () => {
    const res = await fetch(`${baseUrl}/api/unsubscribe?token=garbage`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not valid/);
    assert.equal(suppressions.length, 0);
  });

  test("still confirms when there is no matching demo signup (paying user)", async () => {
    signupRow = undefined;
    const token = signUnsubscribeToken("payer@example.com");
    const res = await fetch(`${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    assert.equal(suppressions.length, 1);
    assert.equal(suppressions[0].email, "payer@example.com");
  });
});
