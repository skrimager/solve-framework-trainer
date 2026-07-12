import { test, beforeEach, afterEach, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import { storage } from "./storage";
import { registerPublicAndAdminRoutes } from "./routes";
import { __setFetchForTests } from "./notifications";
import {
  inboundFirstName,
  buildWelcomeEmailBody,
  buildInboundDay3Body,
  buildInboundDay7Body,
  buildInboundDripSequence,
  inboundBodyToHtml,
  enrollInboundLead,
  sendDueLeadDripEmails,
  WELCOME_SUBJECT,
  INBOUND_DAY3_SUBJECT,
  INBOUND_DAY7_SUBJECT,
} from "./opportunities";
import type { Contact, LeadDripEmail } from "@shared/schema";

const DAY = 24 * 60 * 60 * 1000;

// ===========================================================================
// Pure content builders
// ===========================================================================

describe("inboundFirstName", () => {
  test("takes the first token of the name", () => {
    assert.equal(inboundFirstName("Dana Smith"), "Dana");
    assert.equal(inboundFirstName("  Wade  "), "Wade");
  });
  test("returns empty string for empty/unparseable names", () => {
    assert.equal(inboundFirstName(""), "");
    assert.equal(inboundFirstName("   "), "");
    assert.equal(inboundFirstName(null), "");
    assert.equal(inboundFirstName(undefined), "");
  });
});

describe("buildWelcomeEmailBody", () => {
  test("personalizes the salutation with the first name", () => {
    assert.match(buildWelcomeEmailBody("Dana Smith"), /^Hi Dana,/);
  });
  test("falls back to a generic salutation when the name is empty", () => {
    assert.match(buildWelcomeEmailBody(""), /^Hi there,/);
    assert.match(buildWelcomeEmailBody(null), /^Hi there,/);
  });
  test("contains the exact provided copy anchors", () => {
    const body = buildWelcomeEmailBody("Dana");
    assert.match(body, /This is Wade\./);
    assert.match(body, /Your Free Practice Sessions/);
    assert.match(body, /three complimentary AI practice sessions/);
    assert.match(body, /Meet Your SOLVE Coach™/);
    assert.match(body, /Welcome to the SOLVE Framework\./);
    assert.match(body, /Wade Skrimager/);
    assert.match(body, /P\.S\. Don't rush through your practice sessions/);
  });
});

describe("buildInboundDay3Body", () => {
  test("personalizes and carries the day-3 copy", () => {
    const body = buildInboundDay3Body("Dana Smith");
    assert.match(body, /^Hi Dana,/);
    assert.match(body, /A few days ago you signed up to try the SOLVE Framework/);
    assert.match(body, /three free sessions/);
    assert.match(body, /SOLVE Coach feedback/);
    assert.match(body, /Wade\nFounder, SOLVE Framework™$/);
  });
});

describe("buildInboundDay7Body", () => {
  const body = buildInboundDay7Body("Dana");
  test("carries the day-7 copy and the discovery-architecture framing", () => {
    assert.match(body, /^Hi Dana,/);
    assert.match(body, /building real discovery architecture/);
    assert.match(body, /walk you through a live demo/);
  });
  test("uses the established demo CTA destination, not a guessed one", () => {
    assert.match(body, /Book a Demo: https:\/\/www\.solveframework\.com\/demo/);
  });
});

describe("buildInboundDripSequence", () => {
  const seq = buildInboundDripSequence("Dana Smith");
  test("produces exactly three steps 1/2/3 with the right subjects", () => {
    assert.deepEqual(seq.map((s) => s.step), [1, 2, 3]);
    assert.equal(seq[0].emailSubject, WELCOME_SUBJECT);
    assert.equal(seq[1].emailSubject, INBOUND_DAY3_SUBJECT);
    assert.equal(seq[2].emailSubject, INBOUND_DAY7_SUBJECT);
  });
  test("every step greets the contact by first name", () => {
    for (const s of seq) assert.match(s.emailBody, /^Hi Dana,/);
  });
});

describe("inboundBodyToHtml", () => {
  test("escapes HTML in the body", () => {
    const html = inboundBodyToHtml("Hi <script>x</script>");
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
  test("a crafted URL-like token cannot break out of the href attribute", () => {
    // A malicious name/body token that looks like a URL but embeds a quote must
    // not inject extra HTML attributes into the generated anchor.
    const html = inboundBodyToHtml('http://evil.com/"onmouseover="alert(1) rest');
    // The anchor is closed at the quote; the crafted attribute never lands
    // inside a tag (the leftover survives only as inert, escaped text).
    assert.match(html, /<a href="http:\/\/evil\.com\/">http:\/\/evil\.com\/<\/a>/);
    assert.doesNotMatch(html, /<a[^>]*onmouseover/);
  });
  test("linkifies the day-7 Book a Demo URL into an anchor", () => {
    const html = inboundBodyToHtml(buildInboundDay7Body("Dana"));
    assert.match(html, /<a href="https:\/\/www\.solveframework\.com\/demo">/);
  });
  test("preserves line breaks", () => {
    assert.match(inboundBodyToHtml("a\nb"), /a<br>b/);
  });
});

// ===========================================================================
// enrollInboundLead — welcome send + drip enrollment
// ===========================================================================

describe("enrollInboundLead", () => {
  const now = new Date("2026-07-10T00:00:00.000Z");
  const nowMs = now.getTime();
  const contact: Pick<Contact, "id" | "name" | "email"> = {
    id: 5,
    name: "Dana Smith",
    email: "dana@example.com",
  };

  function makeDeps(sendResult = true) {
    const rows: LeadDripEmail[] = [];
    const sends: { to: string; subject: string }[] = [];
    const deps = {
      now: () => now,
      send: async (to: string, subject: string) => {
        sends.push({ to, subject });
        return sendResult;
      },
      storage: {
        createLeadDripEmail: async (row: any) => {
          const created = { id: rows.length + 1, ...row } as LeadDripEmail;
          rows.push(created);
          return created;
        },
      },
    };
    return { deps, rows, sends };
  }

  test("sends the day-0 welcome inline exactly once to the lead", async () => {
    const { deps, sends } = makeDeps();
    await enrollInboundLead(deps as any, contact);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, "dana@example.com");
    assert.equal(sends[0].subject, WELCOME_SUBJECT);
  });

  test("persists all three steps: step 1 sent now, steps 2/3 scheduled +3d/+7d", async () => {
    const { deps, rows } = makeDeps();
    await enrollInboundLead(deps as any, contact);
    assert.equal(rows.length, 3);

    const [s1, s2, s3] = rows;
    assert.equal(s1.sequenceStep, 1);
    assert.equal(s1.status, "sent");
    assert.equal(s1.sentAt, now.toISOString());

    assert.equal(s2.sequenceStep, 2);
    assert.equal(s2.status, "scheduled");
    assert.equal(s2.sentAt, null);
    assert.equal(s2.scheduledAt, new Date(nowMs + 3 * DAY).toISOString());

    assert.equal(s3.sequenceStep, 3);
    assert.equal(s3.status, "scheduled");
    assert.equal(s3.scheduledAt, new Date(nowMs + 7 * DAY).toISOString());

    for (const r of rows) assert.equal(r.contactId, 5);
  });

  test("still records the welcome step even when the welcome send fails", async () => {
    const { deps, rows } = makeDeps(false);
    await enrollInboundLead(deps as any, contact);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].status, "sent");
  });

  test("never throws when storage rejects (fully best-effort)", async () => {
    const deps = {
      now: () => now,
      send: async () => true,
      storage: {
        createLeadDripEmail: async () => {
          throw new Error("db down");
        },
      },
    };
    await assert.doesNotReject(enrollInboundLead(deps as any, contact));
  });

  test("greets 'Hi there,' when the contact name is empty", async () => {
    const { deps, rows } = makeDeps();
    await enrollInboundLead(deps as any, { id: 9, name: "", email: "x@y.com" });
    assert.match(rows[0].emailBody, /^Hi there,/);
  });
});

// ===========================================================================
// sendDueLeadDripEmails — background sender for day 3/7
// ===========================================================================

describe("sendDueLeadDripEmails", () => {
  const now = new Date("2026-07-20T00:00:00.000Z");

  function dripRow(overrides: Partial<LeadDripEmail> = {}): LeadDripEmail {
    return {
      id: 1,
      contactId: 5,
      sequenceStep: 2,
      emailSubject: INBOUND_DAY3_SUBJECT,
      emailBody: "Hi Dana,\n\nbody",
      scheduledAt: "2026-07-19T00:00:00.000Z",
      sentAt: null,
      status: "scheduled",
      ...overrides,
    };
  }

  function makeStorage(due: LeadDripEmail[], contacts: Pick<Contact, "id" | "email">[]) {
    const updates: Record<number, Partial<LeadDripEmail>> = {};
    return {
      updates,
      store: {
        listDueLeadDripEmails: async (_iso: string) => due,
        getContact: async (id: number) => contacts.find((c) => c.id === id),
        updateLeadDripEmail: async (id: number, patch: Partial<LeadDripEmail>) => {
          updates[id] = patch;
          return { ...dripRow({ id }), ...patch };
        },
      },
    };
  }

  test("sends a due step and marks it sent", async () => {
    const h = makeStorage([dripRow({ id: 3 })], [{ id: 5, email: "dana@example.com" }]);
    const sends: { to: string; subject: string; html: string }[] = [];
    const result = await sendDueLeadDripEmails({
      storage: h.store as any,
      send: async (to, subject, html) => {
        sends.push({ to, subject, html });
        return true;
      },
      now: () => now,
    });
    assert.deepEqual(result, { sent: 1, failed: 0 });
    assert.equal(sends[0].to, "dana@example.com");
    assert.equal(sends[0].subject, INBOUND_DAY3_SUBJECT);
    assert.match(sends[0].html, /Hi Dana,/);
    assert.equal(h.updates[3].status, "sent");
    assert.equal(h.updates[3].sentAt, now.toISOString());
  });

  test("a failed send leaves the row untouched (retried next tick)", async () => {
    const h = makeStorage([dripRow({ id: 4 })], [{ id: 5, email: "dana@example.com" }]);
    const result = await sendDueLeadDripEmails({
      storage: h.store as any,
      send: async () => false,
      now: () => now,
    });
    assert.deepEqual(result, { sent: 0, failed: 1 });
    assert.equal(h.updates[4], undefined);
  });

  test("a missing contact counts as failed and sends nothing", async () => {
    const h = makeStorage([dripRow({ id: 7, contactId: 999 })], [{ id: 5, email: "dana@example.com" }]);
    let calls = 0;
    const result = await sendDueLeadDripEmails({
      storage: h.store as any,
      send: async () => {
        calls += 1;
        return true;
      },
      now: () => now,
    });
    assert.deepEqual(result, { sent: 0, failed: 1 });
    assert.equal(calls, 0);
  });
});

// ===========================================================================
// Migration
// ===========================================================================

describe("migration 0013", () => {
  test("creates the lead_drip_emails table separate from prospect_outreach", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "migrations/0013_lead_drip_emails.sql"),
      "utf8",
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "lead_drip_emails"/);
    assert.match(sql, /REFERENCES "contacts"\("id"\)/);
  });

  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8"),
    );
    assert.ok(journal.entries.some((e: any) => e.tag === "0013_lead_drip_emails"));
  });
});

// ===========================================================================
// HTTP: POST /api/leads triggers welcome send + drip enrollment
// ===========================================================================

describe("POST /api/leads welcome + drip enrollment", () => {
  let server: Server;
  let baseUrl: string;
  let contacts: Contact[];
  let dripRows: LeadDripEmail[];

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

  let ipCounter = 0;
  function freshIp(): string {
    ipCounter += 1;
    return `10.9.0.${ipCounter}`;
  }

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    contacts = [];
    dripRows = [];
    (storage as any).createContact = async (c: any) => {
      const row = { id: contacts.length + 1, ...c } as Contact;
      contacts.push(row);
      return row;
    };
    (storage as any).createLead = (l: any) => (storage as any).createContact(l);
    (storage as any).createContactEvent = async () => ({});
    (storage as any).createLeadDripEmail = async (row: any) => {
      const created = { id: dripRows.length + 1, ...row } as LeadDripEmail;
      dripRows.push(created);
      return created;
    };
  });

  afterEach(() => {
    __setFetchForTests(null);
    delete process.env.RESEND_API_KEY;
  });

  async function waitForRows(n: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (dripRows.length >= n) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  test("sends the welcome email from hello@ and enrolls the lead in a distinct 3-step drip", async () => {
    const sends: any[] = [];
    __setFetchForTests(async (_url: any, init: any) => {
      sends.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    });

    const res = await fetch(`${baseUrl}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ name: "Dana Smith", email: "dana@example.com" }),
    });
    assert.equal(res.status, 201);
    assert.equal(contacts.length, 1);

    await waitForRows(3);

    // A welcome email was sent from the hello@ mailbox to the submitter.
    const welcome = sends.find((s) => s.subject === WELCOME_SUBJECT);
    assert.ok(welcome, "welcome email was sent");
    assert.equal(welcome.from, "SOLVE Framework <hello@solveframework.com>");
    assert.deepEqual(welcome.to, ["dana@example.com"]);
    assert.match(welcome.html, /This is Wade\./);

    // A full 3-step enrollment was recorded in lead_drip_emails (NOT prospect_outreach).
    assert.equal(dripRows.length, 3);
    assert.deepEqual(dripRows.map((r) => r.sequenceStep), [1, 2, 3]);
    assert.equal(dripRows[0].status, "sent");
    assert.equal(dripRows[1].status, "scheduled");
    assert.equal(dripRows[2].status, "scheduled");
    for (const r of dripRows) assert.equal(r.contactId, contacts[0].id);
  });

  test("still returns 201 and enrolls when the welcome send fails", async () => {
    __setFetchForTests(async () => {
      throw new Error("network down");
    });
    const res = await fetch(`${baseUrl}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ name: "Casey Lee", email: "casey@example.com" }),
    });
    assert.equal(res.status, 201);
    await waitForRows(3);
    assert.equal(dripRows.length, 3);
  });
});
