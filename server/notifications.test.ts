import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import {
  sendLeadNotification,
  buildLeadEmail,
  buildPaidWelcomeEmail,
  __setFetchForTests,
} from "./notifications";
import type { Lead } from "@shared/schema";

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 42,
    name: "Jane Doe",
    email: "jane@example.com",
    company: "Acme Co",
    message: "Please call me",
    status: "new",
    source: "Request Access",
    createdAt: "2026-07-05T12:00:00.000Z",
    ...overrides,
  };
}

// Capture console.warn so the failure-path assertions can confirm we log and
// keep the test output clean.
let warnings: string[];
let originalWarn: typeof console.warn;

beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  __setFetchForTests(null);
  delete process.env.RESEND_API_KEY;
});

describe("buildLeadEmail", () => {
  test("subject is scannable and includes name + source", () => {
    const { subject } = buildLeadEmail(makeLead());
    assert.equal(subject, "New Lead: Jane Doe (Request Access)");
  });

  test("falls back to 'no source' when source is empty", () => {
    const { subject } = buildLeadEmail(makeLead({ source: null }));
    assert.equal(subject, "New Lead: Jane Doe (no source)");
  });

  test("body includes all populated lead fields", () => {
    const { html } = buildLeadEmail(makeLead());
    assert.match(html, /Jane Doe/);
    assert.match(html, /jane@example\.com/);
    assert.match(html, /Acme Co/);
    assert.match(html, /Please call me/);
    assert.match(html, /Request Access/);
    assert.match(html, /2026-07-05T12:00:00\.000Z/);
  });

  test("escapes HTML in field values", () => {
    const { html } = buildLeadEmail(makeLead({ message: "<script>x</script>" }));
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe("buildPaidWelcomeEmail", () => {
  const details = {
    officeName: "Riverside Realty",
    inviteCode: "RIVER-1234",
    seatCount: 8,
    dashboard: true,
  };

  test("renders the primary CTA as a table-based, inline-styled button", () => {
    const { html } = buildPaidWelcomeEmail(details);
    // Table-based layout with a single anchor styled as a button.
    assert.match(html, /<table role="presentation"/);
    assert.match(html, /Open your Command Center<\/a>/);
    // Inline styles only (no external classes) and brand colors.
    assert.match(html, /display:inline-block/);
    assert.match(html, /background-color:#E06D00/);
    assert.match(html, /border:1px solid #0A1A30/);
    // The CTA anchor points at the manager login and is not a bare text link.
    assert.match(html, /href="[^"]*\/#\/command-center"/);
    assert.doesNotMatch(html, /<button/);
  });

  test("never uses the reserved admin lime color", () => {
    const { html } = buildPaidWelcomeEmail(details);
    assert.doesNotMatch(html, /C6F135/i);
  });

  test("plain-text version keeps a spelled-out Command Center link", () => {
    const { text } = buildPaidWelcomeEmail(details);
    assert.match(text, /Open your Command Center: http[^\s]*\/#\/command-center/);
    assert.doesNotMatch(text, /__CTA_BUTTON__/);
  });

  test("includes the invite code and does not use 'train' as a verb", () => {
    const { html, text } = buildPaidWelcomeEmail(details);
    assert.match(html, /RIVER-1234/);
    assert.match(text, /practicing/);
    assert.doesNotMatch(text, /\btrain(ing|ed|s)?\b/i);
  });
});

describe("sendLeadNotification", () => {
  test("creating a lead triggers a Resend API call with the correct payload", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const calls: { url: string; init: RequestInit }[] = [];
    __setFetchForTests(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    });

    await sendLeadNotification(makeLead());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer re_test_key");

    const payload = JSON.parse(String(calls[0].init.body));
    assert.equal(payload.from, "SOLVE Framework <notifications@solveframework.com>");
    assert.deepEqual(payload.to, ["hello@solveframework.com"]);
    assert.equal(payload.subject, "New Lead: Jane Doe (Request Access)");
    assert.match(payload.html, /jane@example\.com/);
  });

  test("does not throw and does not call Resend when RESEND_API_KEY is missing", async () => {
    let called = false;
    __setFetchForTests(async () => {
      called = true;
      return new Response(null, { status: 200 });
    });

    await assert.doesNotReject(sendLeadNotification(makeLead()));
    assert.equal(called, false);
    assert.ok(warnings.some((w) => w.includes("RESEND_API_KEY is not set")));
  });

  test("does not throw when the Resend call rejects (network failure)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    __setFetchForTests(async () => {
      throw new Error("network down");
    });

    await assert.doesNotReject(sendLeadNotification(makeLead()));
    assert.ok(warnings.some((w) => w.includes("Failed to send lead notification")));
  });

  test("does not throw when Resend returns a non-2xx status", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    __setFetchForTests(async () =>
      new Response("bad request", { status: 422 }),
    );

    await assert.doesNotReject(sendLeadNotification(makeLead()));
    assert.ok(warnings.some((w) => w.includes("Resend returned 422")));
  });
});
