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
  buildContactUpdateEvents,
  isFollowUpDue,
  filterContacts,
  sortByFollowUp,
  normalizeContactPatch,
  runContactCascade,
  bulkDeleteContactsSchema,
  DEFAULT_TYPE,
  DEFAULT_SOURCE,
  DEFAULT_PRIORITY,
} from "./contacts";
import type { AdminUser, Contact, ContactEvent } from "@shared/schema";

// ===========================================================================
// Pure unit tests (no DB, no HTTP)
// ===========================================================================

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 1,
    name: "Dana",
    email: "dana@example.com",
    company: null,
    message: null,
    referredBy: null,
    status: "new",
    type: "general",
    source: "website",
    priority: "medium",
    owner: null,
    followUpDate: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("buildContactUpdateEvents", () => {
  const opts = { actor: "admin", now: "2026-07-05T00:00:00.000Z" };

  test("logs a status change with a human description", () => {
    const events = buildContactUpdateEvents(contact(), { status: "contacted" }, opts);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "status_changed");
    assert.equal(events[0].description, "Status changed from new to contacted");
    assert.equal(events[0].contactId, 1);
    assert.equal(events[0].actor, "admin");
    assert.equal(events[0].createdAt, opts.now);
  });

  test("logs priority, owner and follow-up changes", () => {
    const events = buildContactUpdateEvents(
      contact(),
      { priority: "high", owner: "Alex", followUpDate: "2026-07-10T00:00:00.000Z" },
      opts,
    );
    const types = events.map((e) => e.eventType).sort();
    assert.deepEqual(types, ["follow_up_changed", "owner_changed", "priority_changed"]);
    const owner = events.find((e) => e.eventType === "owner_changed")!;
    assert.equal(owner.description, "Owner changed from unassigned to Alex");
    const follow = events.find((e) => e.eventType === "follow_up_changed")!;
    assert.equal(follow.description, "Follow-up date changed from none to 2026-07-10");
  });

  test("no event when a field is unchanged", () => {
    const events = buildContactUpdateEvents(
      contact({ status: "new", priority: "medium" }),
      { status: "new", priority: "medium" },
      opts,
    );
    assert.equal(events.length, 0);
  });

  test("a note becomes its own event and does not overwrite anything", () => {
    const events = buildContactUpdateEvents(contact(), { note: "Called, left voicemail" }, opts);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "note");
    assert.equal(events[0].description, "Called, left voicemail");
  });

  test("a blank note is ignored", () => {
    const events = buildContactUpdateEvents(contact(), { note: "   " }, opts);
    assert.equal(events.length, 0);
  });

  test("clearing an owner logs the change to unassigned", () => {
    const events = buildContactUpdateEvents(contact({ owner: "Alex" }), { owner: "" }, opts);
    assert.equal(events.length, 1);
    assert.equal(events[0].description, "Owner changed from Alex to unassigned");
  });
});

describe("normalizeContactPatch", () => {
  test("empty owner/followUpDate become null; note is dropped", () => {
    const out = normalizeContactPatch({ owner: "", followUpDate: "", note: "hi", status: "contacted" });
    assert.equal(out.owner, null);
    assert.equal(out.followUpDate, null);
    assert.equal(out.status, "contacted");
    assert.equal("note" in out, false);
  });
});

describe("isFollowUpDue", () => {
  const now = new Date("2026-07-05T12:00:00.000Z");
  test("today or past is due", () => {
    assert.equal(isFollowUpDue("2026-07-05T00:00:00.000Z", now), true);
    assert.equal(isFollowUpDue("2026-07-01T00:00:00.000Z", now), true);
  });
  test("future is not due", () => {
    assert.equal(isFollowUpDue("2026-07-10T00:00:00.000Z", now), false);
  });
  test("null / blank / invalid is not due", () => {
    assert.equal(isFollowUpDue(null, now), false);
    assert.equal(isFollowUpDue("", now), false);
    assert.equal(isFollowUpDue("not-a-date", now), false);
  });
});

describe("filterContacts", () => {
  const rows = [
    contact({ id: 1, type: "speaking", priority: "high", status: "new", owner: "Alex" }),
    contact({ id: 2, type: "consulting", priority: "low", status: "contacted", owner: null }),
    contact({ id: 3, type: "speaking", priority: "medium", status: "new", owner: "Sam" }),
  ];
  test("filters by single field", () => {
    assert.deepEqual(filterContacts(rows, { type: "speaking" }).map((c) => c.id), [1, 3]);
  });
  test("filters by multiple fields (AND)", () => {
    assert.deepEqual(filterContacts(rows, { type: "speaking", status: "new", priority: "high" }).map((c) => c.id), [1]);
  });
  test("empty filters return all", () => {
    assert.equal(filterContacts(rows, {}).length, 3);
  });
});

describe("filterContacts archived views", () => {
  const rows = [
    contact({ id: 1, archivedAt: null }),
    contact({ id: 2, archivedAt: "2026-07-10T00:00:00.000Z" }),
    contact({ id: 3, archivedAt: null }),
  ];
  test("defaults to active only (archived hidden)", () => {
    assert.deepEqual(filterContacts(rows, {}).map((c) => c.id), [1, 3]);
  });
  test("archived view returns only archived", () => {
    assert.deepEqual(filterContacts(rows, { archived: "archived" }).map((c) => c.id), [2]);
  });
  test("all view returns everything", () => {
    assert.deepEqual(filterContacts(rows, { archived: "all" }).map((c) => c.id), [1, 2, 3]);
  });
  test("archived view still respects other filters", () => {
    const mixed = [
      contact({ id: 1, archivedAt: "2026-07-10T00:00:00.000Z", type: "speaking" }),
      contact({ id: 2, archivedAt: "2026-07-10T00:00:00.000Z", type: "consulting" }),
    ];
    assert.deepEqual(filterContacts(mixed, { archived: "archived", type: "speaking" }).map((c) => c.id), [1]);
  });
});

describe("runContactCascade", () => {
  test("runs the FK-safe steps in order", async () => {
    const order: string[] = [];
    await runContactCascade(7, {
      deleteLeadDripEmails: async () => { order.push("drip"); },
      deleteContactEvents: async () => { order.push("events"); },
      detachOfficeSetupTokens: async () => { order.push("tokens"); },
      deleteContactRow: async () => { order.push("contact"); },
    });
    assert.deepEqual(order, ["drip", "events", "tokens", "contact"]);
  });

  test("nulls office_setup_tokens.contact_id rather than deleting the token rows", async () => {
    // Simulate the four tables so we can assert the cascade's net effect.
    let drip = [{ id: 1, contactId: 7 }, { id: 2, contactId: 8 }];
    let events = [{ id: 1, contactId: 7 }];
    let tokens = [{ id: 1, contactId: 7 as number | null }, { id: 2, contactId: null }];
    let contacts = [{ id: 7 }, { id: 8 }];
    const target = 7;

    await runContactCascade(target, {
      deleteLeadDripEmails: async () => { drip = drip.filter((r) => r.contactId !== target); },
      deleteContactEvents: async () => { events = events.filter((r) => r.contactId !== target); },
      detachOfficeSetupTokens: async () => {
        tokens = tokens.map((t) => (t.contactId === target ? { ...t, contactId: null } : t));
      },
      deleteContactRow: async () => { contacts = contacts.filter((r) => r.id !== target); },
    });

    // Dependent NOT NULL rows for the target are gone; the other contact's row stays.
    assert.deepEqual(drip.map((r) => r.id), [2]);
    assert.deepEqual(events.map((r) => r.id), []);
    // Token rows are preserved (still 2), and the one pointing at the target is detached.
    assert.equal(tokens.length, 2);
    assert.equal(tokens.find((t) => t.id === 1)!.contactId, null);
    // Contact row itself removed.
    assert.deepEqual(contacts.map((r) => r.id), [8]);
  });
});

describe("bulkDeleteContactsSchema", () => {
  test("accepts a non-empty list of positive ids", () => {
    assert.equal(bulkDeleteContactsSchema.safeParse({ ids: [1, 2, 3] }).success, true);
  });
  test("rejects an empty list", () => {
    assert.equal(bulkDeleteContactsSchema.safeParse({ ids: [] }).success, false);
  });
  test("rejects non-positive or non-integer ids", () => {
    assert.equal(bulkDeleteContactsSchema.safeParse({ ids: [0] }).success, false);
    assert.equal(bulkDeleteContactsSchema.safeParse({ ids: [1.5] }).success, false);
    assert.equal(bulkDeleteContactsSchema.safeParse({ ids: [-2] }).success, false);
  });
});

describe("sortByFollowUp", () => {
  test("soonest first, nulls last", () => {
    const rows = [
      contact({ id: 1, followUpDate: null }),
      contact({ id: 2, followUpDate: "2026-07-10" }),
      contact({ id: 3, followUpDate: "2026-07-02" }),
    ];
    assert.deepEqual(sortByFollowUp(rows, "asc").map((c) => c.id), [3, 2, 1]);
  });
});

describe("migration 0007", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "migrations/0007_contacts_crm.sql"), "utf8");
  test("renames leads to contacts", () => {
    assert.match(sql, /ALTER TABLE "leads" RENAME TO "contacts"/);
  });
  test("backfills the Phase 1 defaults", () => {
    assert.match(sql, new RegExp(`ADD COLUMN "type" text DEFAULT '${DEFAULT_TYPE}' NOT NULL`));
    assert.match(sql, new RegExp(`ADD COLUMN "priority" text DEFAULT '${DEFAULT_PRIORITY}' NOT NULL`));
    assert.match(sql, new RegExp(`SET "source" = '${DEFAULT_SOURCE}' WHERE "source" IS NULL`));
  });
  test("creates the contact_events table and seeds one created event per row", () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "contact_events"/);
    assert.match(sql, /INSERT INTO "contact_events"[\s\S]*SELECT "id", 'created'[\s\S]*FROM "contacts"/);
  });
});

describe("migration 0025", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "migrations/0025_contacts_archive.sql"), "utf8");
  test("adds a nullable archived_at column to contacts", () => {
    assert.match(sql, /ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "archived_at" text/);
    // Nullable: no NOT NULL constraint on the new column.
    assert.doesNotMatch(sql, /"archived_at" text NOT NULL/);
  });
  test("is recorded in the drizzle journal", () => {
    const journal = readFileSync(path.resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8");
    assert.match(journal, /"tag": "0025_contacts_archive"/);
  });
});

// ===========================================================================
// HTTP integration tests: real Express app + in-memory storage patch.
// ===========================================================================

describe("admin contacts HTTP routes", () => {
  const ADMIN_USER = "Solve Framework";
  const ADMIN_PASS = "Sooners@1031";

  let server: Server;
  let baseUrl: string;

  let admins: AdminUser[];
  let contacts: Contact[];
  let events: ContactEvent[];

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
    contacts = [];
    events = [];

    (storage as any).getAdminByUsername = async (u: string) => admins.find((a) => a.username === u);

    (storage as any).createContact = async (c: any) => {
      const row = { id: contacts.length + 1, ...c } as Contact;
      contacts.push(row);
      events.push({
        id: events.length + 1,
        contactId: row.id,
        eventType: "created",
        description: "Lead created",
        actor: "system",
        createdAt: row.createdAt,
      });
      return row;
    };
    (storage as any).createLead = (l: any) => (storage as any).createContact(l);
    (storage as any).listContacts = async (filters: any = {}, sort?: string) => {
      let out = [...contacts].reverse();
      out = filterContacts(out, filters);
      if (sort === "followUp") out = sortByFollowUp(out, "asc");
      return out;
    };
    (storage as any).getContact = async (id: number) => contacts.find((c) => c.id === id);
    (storage as any).updateContact = async (id: number, patch: any) => {
      const c = contacts.find((x) => x.id === id);
      if (!c) return undefined;
      Object.assign(c, patch);
      return c;
    };
    (storage as any).createContactEvent = async (e: any) => {
      const row = { id: events.length + 1, ...e } as ContactEvent;
      events.push(row);
      return row;
    };
    (storage as any).listContactEvents = async (contactId: number) =>
      events.filter((e) => e.contactId === contactId).slice().reverse();
    (storage as any).archiveContact = async (id: number) => {
      const c = contacts.find((x) => x.id === id);
      if (!c) return undefined;
      c.archivedAt = "2026-07-23T00:00:00.000Z";
      return c;
    };
    (storage as any).unarchiveContact = async (id: number) => {
      const c = contacts.find((x) => x.id === id);
      if (!c) return undefined;
      c.archivedAt = null;
      return c;
    };
    (storage as any).deleteContact = async (id: number) => {
      const idx = contacts.findIndex((x) => x.id === id);
      if (idx === -1) return false;
      contacts.splice(idx, 1);
      // Deleting a contact also removes its dependent events (mirrors the cascade).
      events = events.filter((e) => e.contactId !== id);
      return true;
    };
    (storage as any).bulkDeleteContacts = async (ids: number[]) => {
      const deleted: number[] = [];
      const notFound: number[] = [];
      for (const id of ids) {
        if (await (storage as any).deleteContact(id)) deleted.push(id);
        else notFound.push(id);
      }
      return { deleted, notFound };
    };
  });

  let ipCounter = 0;
  function freshIp(): string {
    ipCounter += 1;
    return `10.1.0.${ipCounter}`;
  }
  async function login(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    return setCookie.split(";")[0];
  }

  test("POST /api/leads stays backward compatible and applies CRM defaults", async () => {
    const res = await fetch(`${baseUrl}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ name: "Dana", email: "dana@example.com", message: "interested" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].type, DEFAULT_TYPE);
    assert.equal(contacts[0].source, DEFAULT_SOURCE);
    assert.equal(contacts[0].priority, DEFAULT_PRIORITY);
    // A "created" event was seeded automatically.
    assert.equal(events.filter((e) => e.contactId === 1 && e.eventType === "created").length, 1);
  });

  test("POST /api/leads persists an optional referredBy and surfaces it to admins", async () => {
    const submit = await fetch(`${baseUrl}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ name: "Dana", email: "dana@example.com", referredBy: "Acme Motors" }),
    });
    assert.equal(submit.status, 201);
    assert.equal(contacts[0].referredBy, "Acme Motors");
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(body.rows[0].referredBy, "Acme Motors");
  });

  test("POST /api/leads without referredBy stores null", async () => {
    const res = await fetch(`${baseUrl}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ name: "Dana", email: "dana@example.com" }),
    });
    assert.equal(res.status, 201);
    assert.equal(contacts[0].referredBy, null);
  });

  test("GET /api/admin/contacts filters by type/priority/status", async () => {
    contacts.push(
      contact({ id: 1, type: "speaking", priority: "high", status: "new" }),
      contact({ id: 2, type: "consulting", priority: "low", status: "contacted" }),
    );
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts?type=speaking`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].id, 1);
    assert.equal(body.rows[0].type, "speaking");
    assert.ok("followUpDue" in body.rows[0]);
  });

  test("PATCH /api/admin/contacts/:id updates fields and logs events", async () => {
    contacts.push(contact({ id: 1 }));
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "contacted", priority: "high", owner: "Alex", followUpDate: "2026-07-20" }),
    });
    assert.equal(res.status, 200);
    assert.equal(contacts[0].status, "contacted");
    assert.equal(contacts[0].priority, "high");
    assert.equal(contacts[0].owner, "Alex");
    const logged = events.filter((e) => e.contactId === 1).map((e) => e.eventType);
    assert.ok(logged.includes("status_changed"));
    assert.ok(logged.includes("priority_changed"));
    assert.ok(logged.includes("owner_changed"));
    assert.ok(logged.includes("follow_up_changed"));
  });

  test("PATCH with a note appends a note event without changing columns", async () => {
    contacts.push(contact({ id: 1, status: "new" }));
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ note: "Spoke with Dana, will follow up" }),
    });
    assert.equal(res.status, 200);
    assert.equal(contacts[0].status, "new");
    const notes = events.filter((e) => e.contactId === 1 && e.eventType === "note");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].description, "Spoke with Dana, will follow up");
  });

  test("GET /api/admin/contacts/:id/events returns the timeline newest first", async () => {
    contacts.push(contact({ id: 1 }));
    events.push(
      { id: 10, contactId: 1, eventType: "created", description: "Lead created", actor: "system", createdAt: "2026-07-01" },
      { id: 11, contactId: 1, eventType: "note", description: "later note", actor: "admin", createdAt: "2026-07-02" },
    );
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/1/events`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(body.rows.length, 2);
    assert.equal(body.rows[0].id, 11); // newest first
  });

  test("contacts routes reject an unauthenticated request", async () => {
    for (const path of ["/api/admin/contacts", "/api/admin/contacts/1/events"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401, `${path} should be 401 without a session`);
    }
  });

  test("PATCH on a missing contact is 404", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "contacted" }),
    });
    assert.equal(res.status, 404);
  });

  test("CSV export for contacts includes the new columns", async () => {
    contacts.push(contact({ id: 1, type: "speaking", priority: "high", owner: "Alex" }));
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts?format=csv`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    const text = await res.text();
    const header = text.split("\n")[0];
    for (const col of ["Type", "Source", "Priority", "Owner", "Follow-up", "Referred By"]) {
      assert.ok(header.includes(col), `header should include ${col}`);
    }
  });

  // --- Archive / unarchive ---

  test("POST /api/admin/contacts/:id/archive stamps archivedAt and hides from default list", async () => {
    contacts.push(contact({ id: 1 }));
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/1/archive`, { method: "POST", headers: { cookie } });
    assert.equal(res.status, 200);
    assert.ok(contacts[0].archivedAt);
    // Default (active) list no longer shows it.
    const active = await (await fetch(`${baseUrl}/api/admin/contacts`, { headers: { cookie } })).json();
    assert.equal(active.rows.length, 0);
    // Archived view shows it.
    const archived = await (await fetch(`${baseUrl}/api/admin/contacts?archived=archived`, { headers: { cookie } })).json();
    assert.equal(archived.rows.length, 1);
    assert.equal(archived.rows[0].id, 1);
  });

  test("POST /api/admin/contacts/:id/unarchive clears archivedAt", async () => {
    contacts.push(contact({ id: 1, archivedAt: "2026-07-10T00:00:00.000Z" }));
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/1/unarchive`, { method: "POST", headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(contacts[0].archivedAt, null);
    const active = await (await fetch(`${baseUrl}/api/admin/contacts`, { headers: { cookie } })).json();
    assert.equal(active.rows.length, 1);
  });

  test("archive/unarchive on a missing contact is 404", async () => {
    const cookie = await login();
    for (const action of ["archive", "unarchive"]) {
      const res = await fetch(`${baseUrl}/api/admin/contacts/999/${action}`, { method: "POST", headers: { cookie } });
      assert.equal(res.status, 404, `${action} should be 404`);
    }
  });

  // --- Delete ---

  test("DELETE /api/admin/contacts/:id removes the contact", async () => {
    contacts.push(contact({ id: 1 }), contact({ id: 2 }));
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/1`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(contacts.find((c) => c.id === 1), undefined);
    assert.ok(contacts.find((c) => c.id === 2));
  });

  test("DELETE on a missing contact is 404", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/999`, { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 404);
  });

  test("POST /api/admin/contacts/bulk-delete removes many and reports counts", async () => {
    contacts.push(contact({ id: 1 }), contact({ id: 2 }), contact({ id: 3 }));
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ ids: [1, 3, 999] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deletedCount, 2);
    assert.deepEqual(body.deleted, [1, 3]);
    assert.deepEqual(body.notFound, [999]);
    assert.deepEqual(contacts.map((c) => c.id), [2]);
  });

  test("bulk-delete rejects an empty id list with 400", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/admin/contacts/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(res.status, 400);
  });

  test("archive, unarchive, delete and bulk-delete all reject unauthenticated requests", async () => {
    const cases: [string, string][] = [
      ["POST", "/api/admin/contacts/1/archive"],
      ["POST", "/api/admin/contacts/1/unarchive"],
      ["DELETE", "/api/admin/contacts/1"],
      ["POST", "/api/admin/contacts/bulk-delete"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} should be 401 without a session`);
    }
  });
});
