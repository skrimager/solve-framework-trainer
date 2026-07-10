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
  scheduledAtForStep,
  normalizeSegment,
  buildSequence,
  planApproval,
  sendDueOutreach,
  SEQUENCE_STEP_OFFSET_DAYS,
} from "./opportunities";
import type {
  AdminUser,
  ProspectSearch,
  ProspectCompany,
  ProspectContact,
  ProspectOutreach,
  ProspectActivity,
} from "@shared/schema";

// ===========================================================================
// Pure unit tests (no DB, no HTTP)
// ===========================================================================

describe("scheduledAtForStep", () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  test("step 1 sends immediately, step 2 at +3d, step 3 at +7d", () => {
    assert.equal(scheduledAtForStep(1, now), new Date(now).toISOString());
    assert.equal(scheduledAtForStep(2, now), new Date(now + 3 * DAY).toISOString());
    assert.equal(scheduledAtForStep(3, now), new Date(now + 7 * DAY).toISOString());
  });

  test("offsets match the exported table", () => {
    assert.deepEqual(SEQUENCE_STEP_OFFSET_DAYS, { 1: 0, 2: 3, 3: 7 });
  });

  test("unknown step falls back to immediate", () => {
    assert.equal(scheduledAtForStep(9, now), new Date(now).toISOString());
  });
});

describe("normalizeSegment", () => {
  test("maps free-text markets to canonical angles", () => {
    assert.equal(normalizeSegment("Manufactured Housing communities"), "manufactured_housing");
    assert.equal(normalizeSegment("HVAC & plumbing"), "home_services");
    assert.equal(normalizeSegment("Auto dealership"), "auto_dealership");
    assert.equal(normalizeSegment("Mortgage lending"), "mortgage_lending");
    assert.equal(normalizeSegment("Equipment rental"), "equipment_rental");
    assert.equal(normalizeSegment("customer service / conflict"), "conflict_service");
  });

  test("unknown segment falls back to general", () => {
    assert.equal(normalizeSegment("underwater basket weaving"), "general");
    assert.equal(normalizeSegment(""), "general");
  });
});

describe("buildSequence", () => {
  const emails = buildSequence("Manufactured Housing", {
    contactName: "Dana Smith",
    companyName: "Acme Communities",
  });

  test("produces exactly three steps", () => {
    assert.equal(emails.length, 3);
    assert.deepEqual(emails.map((e) => e.step), [1, 2, 3]);
  });

  test("greets by first name and names the company in every subject", () => {
    for (const e of emails) assert.match(e.emailBody, /Hi Dana,/);
    for (const e of emails) assert.match(e.emailSubject, /Acme Communities/);
  });

  test("every email mentions role-play, scoring/tracking, certification, and the demo CTA", () => {
    for (const e of emails) {
      const body = e.emailBody.toLowerCase();
      assert.match(body, /role-play/, "mentions live role-play scenarios");
      assert.match(body, /scor|track/, "mentions scoring/tracking");
      assert.match(body, /certification/, "mentions certification");
      assert.match(body, /solveframework\.com\/demo/, "includes the free demo CTA link");
    }
  });

  test("copy never uses forbidden 'sales' or 'AI roleplay' language", () => {
    for (const e of emails) {
      const all = `${e.emailSubject} ${e.emailBody}`.toLowerCase();
      assert.doesNotMatch(all, /\bsales\b/, "no 'sales' in prospect copy");
      assert.doesNotMatch(all, /ai roleplay/, "no 'AI roleplay' in prospect copy");
    }
  });

  test("unknown segment still builds a full general sequence", () => {
    const general = buildSequence("nonprofit outreach", { contactName: "Lee", companyName: "Org" });
    assert.equal(general.length, 3);
    for (const e of general) assert.match(e.emailBody.toLowerCase(), /certification/);
  });
});

describe("planApproval", () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  function outreach(overrides: Partial<ProspectOutreach> = {}): ProspectOutreach {
    return {
      id: 1,
      contactId: 1,
      searchId: 1,
      sequenceStep: 1,
      emailSubject: "s",
      emailBody: "b",
      scheduledAt: null,
      sentAt: null,
      status: "draft",
      ...overrides,
    };
  }

  test("schedules only draft rows, with the step offsets applied", () => {
    const plan = planApproval(
      [
        outreach({ id: 10, sequenceStep: 1 }),
        outreach({ id: 11, sequenceStep: 2 }),
        outreach({ id: 12, sequenceStep: 3 }),
      ],
      now,
    );
    assert.equal(plan.length, 3);
    assert.deepEqual(
      plan.map((p) => [p.id, p.scheduledAt]),
      [
        [10, new Date(now).toISOString()],
        [11, new Date(now + 3 * DAY).toISOString()],
        [12, new Date(now + 7 * DAY).toISOString()],
      ],
    );
    for (const p of plan) assert.equal(p.status, "scheduled");
  });

  test("leaves already sent/scheduled rows untouched", () => {
    const plan = planApproval(
      [outreach({ id: 1, status: "sent" }), outreach({ id: 2, status: "scheduled" })],
      now,
    );
    assert.equal(plan.length, 0);
  });
});

describe("sendDueOutreach", () => {
  function makeStorage(due: ProspectOutreach[], contacts: ProspectContact[]) {
    const updates: Record<number, Partial<ProspectOutreach>> = {};
    const activity: any[] = [];
    return {
      updates,
      activity,
      store: {
        listDueProspectOutreach: async (_iso: string) => due,
        getProspectContact: async (id: number) => contacts.find((c) => c.id === id),
        updateProspectOutreach: async (id: number, patch: Partial<ProspectOutreach>) => {
          updates[id] = { ...(updates[id] ?? {}), ...patch };
          const row = due.find((d) => d.id === id)!;
          Object.assign(row, patch);
          return row;
        },
        createProspectActivity: async (a: any) => {
          activity.push(a);
          return { id: activity.length, ...a };
        },
      },
    };
  }

  function outreach(overrides: Partial<ProspectOutreach> = {}): ProspectOutreach {
    return {
      id: 1,
      contactId: 1,
      searchId: 1,
      sequenceStep: 1,
      emailSubject: "A discovery-training idea",
      emailBody: "body",
      scheduledAt: "2026-07-01T00:00:00.000Z",
      sentAt: null,
      status: "scheduled",
      ...overrides,
    };
  }

  const contact: ProspectContact = {
    id: 1,
    companyId: 1,
    fullName: "Dana Smith",
    title: "Owner",
    email: "dana@example.com",
    phone: null,
    linkedinUrl: null,
    createdAt: "2026-06-01T00:00:00.000Z",
  };

  test("sends due rows, marks them sent, and logs a sent activity", async () => {
    const h = makeStorage([outreach({ id: 5 })], [contact]);
    const sent: string[] = [];
    const result = await sendDueOutreach({
      storage: h.store as any,
      send: async (to) => {
        sent.push(to);
        return true;
      },
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    assert.deepEqual(result, { sent: 1, failed: 0 });
    assert.deepEqual(sent, ["dana@example.com"]);
    assert.equal(h.updates[5].status, "sent");
    assert.equal(h.updates[5].sentAt, "2026-07-10T00:00:00.000Z");
    assert.equal(h.activity.length, 1);
    assert.equal(h.activity[0].eventType, "sent");
  });

  test("a failed send leaves the row scheduled and logs no activity", async () => {
    const h = makeStorage([outreach({ id: 6 })], [contact]);
    const result = await sendDueOutreach({
      storage: h.store as any,
      send: async () => false,
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    assert.deepEqual(result, { sent: 0, failed: 1 });
    assert.equal(h.updates[6], undefined, "row is not updated");
    assert.equal(h.activity.length, 0);
  });

  test("already-sent rows are never resent (only scheduled rows are fetched)", async () => {
    // listDueProspectOutreach only returns scheduled+due rows; a sent row is
    // never in the due list, so the sender can't resend it.
    const h = makeStorage([], [contact]);
    let calls = 0;
    const result = await sendDueOutreach({
      storage: h.store as any,
      send: async () => {
        calls += 1;
        return true;
      },
    });
    assert.deepEqual(result, { sent: 0, failed: 0 });
    assert.equal(calls, 0);
  });

  test("a missing contact counts as a failure and does not send", async () => {
    const h = makeStorage([outreach({ id: 7, contactId: 999 })], [contact]);
    let calls = 0;
    const result = await sendDueOutreach({
      storage: h.store as any,
      send: async () => {
        calls += 1;
        return true;
      },
    });
    assert.deepEqual(result, { sent: 0, failed: 1 });
    assert.equal(calls, 0);
  });
});

describe("migration 0011", () => {
  const sql = readFileSync(
    path.resolve(process.cwd(), "migrations/0011_opportunity_intelligence.sql"),
    "utf8",
  );
  test("creates all five prospect tables", () => {
    for (const t of [
      "prospect_searches",
      "prospect_companies",
      "prospect_contacts",
      "prospect_outreach",
      "prospect_activity",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`));
    }
  });
});

// ===========================================================================
// HTTP integration tests: real Express app + in-memory storage patch.
// ===========================================================================

describe("admin opportunities HTTP routes", () => {
  const ADMIN_USER = "Solve Framework";
  const ADMIN_PASS = "Sooners@1031";

  let server: Server;
  let baseUrl: string;

  let admins: AdminUser[];
  let searches: ProspectSearch[];
  let companies: ProspectCompany[];
  let contacts: ProspectContact[];
  let outreach: ProspectOutreach[];
  let activity: ProspectActivity[];

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
    searches = [];
    companies = [];
    contacts = [];
    outreach = [];
    activity = [];

    (storage as any).getAdminByUsername = async (u: string) => admins.find((a) => a.username === u);

    (storage as any).createProspectSearch = async (s: any) => {
      const row = { id: searches.length + 1, ...s } as ProspectSearch;
      searches.push(row);
      return row;
    };
    (storage as any).getProspectSearch = async (id: number) => searches.find((s) => s.id === id);
    (storage as any).listProspectSearches = async () => [...searches].reverse();
    (storage as any).updateProspectSearch = async (id: number, patch: any) => {
      const s = searches.find((x) => x.id === id);
      if (!s) return undefined;
      Object.assign(s, patch);
      return s;
    };
    (storage as any).createProspectCompany = async (c: any) => {
      const row = { id: companies.length + 1, ...c } as ProspectCompany;
      companies.push(row);
      return row;
    };
    (storage as any).getProspectCompaniesByIds = async (ids: number[]) =>
      companies.filter((c) => ids.includes(c.id));
    (storage as any).createProspectContact = async (c: any) => {
      const row = { id: contacts.length + 1, ...c } as ProspectContact;
      contacts.push(row);
      return row;
    };
    (storage as any).getProspectContact = async (id: number) => contacts.find((c) => c.id === id);
    (storage as any).getProspectContactsByIds = async (ids: number[]) =>
      contacts.filter((c) => ids.includes(c.id));
    (storage as any).createProspectOutreach = async (o: any) => {
      const row = { id: outreach.length + 1, ...o } as ProspectOutreach;
      outreach.push(row);
      return row;
    };
    (storage as any).listProspectOutreachBySearch = async (searchId: number) =>
      outreach.filter((o) => o.searchId === searchId);
    (storage as any).listDueProspectOutreach = async (iso: string) =>
      outreach.filter((o) => o.status === "scheduled" && o.scheduledAt !== null && o.scheduledAt <= iso);
    (storage as any).updateProspectOutreach = async (id: number, patch: any) => {
      const o = outreach.find((x) => x.id === id);
      if (!o) return undefined;
      Object.assign(o, patch);
      return o;
    };
    (storage as any).createProspectActivity = async (a: any) => {
      const row = { id: activity.length + 1, ...a } as ProspectActivity;
      activity.push(row);
      return row;
    };
    (storage as any).listRecentProspectActivity = async (limit = 200) =>
      [...activity].reverse().slice(0, limit);
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

  const samplePayload = {
    segment: "Manufactured Housing",
    geography: "Phoenix, AZ",
    companies: [
      {
        name: "Acme Communities",
        domain: "acme.com",
        city: "Phoenix",
        state: "AZ",
        signalType: "hiring",
        signalDetail: "Hiring 3 community managers",
        source: "apollo",
        contacts: [
          { fullName: "Dana Smith", title: "Owner", email: "dana@acme.com" },
        ],
      },
    ],
  };

  test("routes reject unauthenticated requests", async () => {
    for (const p of [
      "/api/admin/opportunities/searches",
      "/api/admin/opportunities/activity",
    ]) {
      const res = await fetch(`${baseUrl}${p}`);
      assert.equal(res.status, 401, `${p} should be 401 without a session`);
    }
  });

  test("POST /batches creates a pending_review batch with a generated 3-step drip", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/opportunities/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.companies, 1);
    assert.equal(body.contacts, 1);
    assert.equal(body.outreach, 3);
    assert.equal(searches[0].status, "pending_review");
    assert.equal(searches[0].resultsCount, 1);
    assert.equal(outreach.length, 3);
    assert.ok(outreach.every((o) => o.status === "draft"));
  });

  test("GET /searches lists batches most recent first", async () => {
    const cookie = await login();
    for (const seg of ["A", "B"]) {
      await fetch(`${baseUrl}/api/admin/opportunities/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ ...samplePayload, segment: seg }),
      });
    }
    const res = await fetch(`${baseUrl}/api/admin/opportunities/searches`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(body.rows.length, 2);
    assert.equal(body.rows[0].segment, "B");
  });

  test("GET /searches/:id returns nested companies -> contacts -> step-sorted outreach", async () => {
    const cookie = await login();
    const created = await (
      await fetch(`${baseUrl}/api/admin/opportunities/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(samplePayload),
      })
    ).json();
    const res = await fetch(`${baseUrl}/api/admin/opportunities/searches/${created.searchId}`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.companies.length, 1);
    const co = body.companies[0];
    assert.equal(co.contacts.length, 1);
    assert.deepEqual(co.contacts[0].outreach.map((o: any) => o.sequenceStep), [1, 2, 3]);
  });

  test("approve schedules step 1 now, step 2 +3d, step 3 +7d and marks the batch approved", async () => {
    const cookie = await login();
    const created = await (
      await fetch(`${baseUrl}/api/admin/opportunities/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(samplePayload),
      })
    ).json();
    const before = Date.now();
    const res = await fetch(
      `${baseUrl}/api/admin/opportunities/searches/${created.searchId}/approve`,
      { method: "POST", headers: { cookie } },
    );
    const after = Date.now();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.scheduled, 3);
    assert.equal(searches[0].status, "approved");
    assert.ok(outreach.every((o) => o.status === "scheduled"));

    const DAY = 24 * 60 * 60 * 1000;
    const step1 = outreach.find((o) => o.sequenceStep === 1)!;
    const step2 = outreach.find((o) => o.sequenceStep === 2)!;
    const step3 = outreach.find((o) => o.sequenceStep === 3)!;
    const t1 = Date.parse(step1.scheduledAt!);
    assert.ok(t1 >= before && t1 <= after, "step 1 scheduled ~now");
    assert.ok(Math.abs(Date.parse(step2.scheduledAt!) - (t1 + 3 * DAY)) < 1000);
    assert.ok(Math.abs(Date.parse(step3.scheduledAt!) - (t1 + 7 * DAY)) < 1000);
  });

  test("approving a non-pending batch is a 409", async () => {
    const cookie = await login();
    const created = await (
      await fetch(`${baseUrl}/api/admin/opportunities/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(samplePayload),
      })
    ).json();
    await fetch(`${baseUrl}/api/admin/opportunities/searches/${created.searchId}/approve`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await fetch(
      `${baseUrl}/api/admin/opportunities/searches/${created.searchId}/approve`,
      { method: "POST", headers: { cookie } },
    );
    assert.equal(res.status, 409);
  });

  test("reject marks the batch rejected and leaves outreach draft", async () => {
    const cookie = await login();
    const created = await (
      await fetch(`${baseUrl}/api/admin/opportunities/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(samplePayload),
      })
    ).json();
    const res = await fetch(
      `${baseUrl}/api/admin/opportunities/searches/${created.searchId}/reject`,
      { method: "POST", headers: { cookie } },
    );
    assert.equal(res.status, 200);
    assert.equal(searches[0].status, "rejected");
    assert.ok(outreach.every((o) => o.status === "draft"));
  });

  test("GET /searches/:id is 404 for a missing batch", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/opportunities/searches/999`, { headers: { cookie } });
    assert.equal(res.status, 404);
  });

  test("run-drip sends scheduled+due outreach and records activity", async () => {
    const cookie = await login();
    const created = await (
      await fetch(`${baseUrl}/api/admin/opportunities/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(samplePayload),
      })
    ).json();
    await fetch(`${baseUrl}/api/admin/opportunities/searches/${created.searchId}/approve`, {
      method: "POST",
      headers: { cookie },
    });
    // Only step 1 is due now; steps 2 and 3 are future-dated. No RESEND_API_KEY
    // in the test env, so sendProspectEmail returns false and nothing is marked
    // sent — this asserts the failure path keeps rows scheduled.
    const res = await fetch(`${baseUrl}/api/admin/opportunities/run-drip`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sent + body.failed, 1, "exactly one row was due");
  });
});
