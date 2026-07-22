import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEMO_DRIP_STEP_OFFSET_DAYS,
  demoScheduledAtForStep,
  buildDemoDay0Body,
  buildDemoDay1Body,
  buildDemoDay3Body,
  buildDemoDripSequence,
  enrollDemoDrip,
  sendDueDemoDripEmails,
  DEMO_DAY0_SUBJECT,
  DEMO_DAY1_SUBJECT,
  DEMO_DAY3_SUBJECT,
} from "./demoDrip";
import type { DemoDripEmail, DemoSession, DemoSignup } from "@shared/schema";

const DAY = 24 * 60 * 60 * 1000;

// Every new email must be on-brand: no "train"/"training", no em-dashes.
function assertBrandSafe(text: string) {
  assert.doesNotMatch(text, /train/i);
  assert.doesNotMatch(text, /—/);
}

// ===========================================================================
// Pure content builders
// ===========================================================================

describe("demo drip copy", () => {
  test("day 0 confirms 3 free sessions + scoring and links the demo, plus footer", () => {
    const body = buildDemoDay0Body("dana@example.com");
    assert.match(body, /three free practice sessions/i);
    assert.match(body, /SOLVE Coach/);
    assert.match(body, /https:\/\/www\.solveframework\.com\/demo/);
    assert.match(body, /opt out here: https?:\/\/[^\s]*\/api\/unsubscribe/);
    assertBrandSafe(body);
  });

  test("day 1 personalizes with the score when a scored session exists", () => {
    const body = buildDemoDay1Body("dana@example.com", { score: 78, feedback: "Ask one more question." });
    assert.match(body, /78 out of 100/);
    assert.match(body, /Ask one more question\./);
    assertBrandSafe(body);
  });

  test("day 1 nudges to use free sessions when there is no scored session", () => {
    const body = buildDemoDay1Body("dana@example.com", null);
    assert.match(body, /three free practice sessions are still sitting there/i);
    assert.doesNotMatch(body, /out of 100/);
    assertBrandSafe(body);
  });

  test("day 3 pushes convert-to-paid with library/dashboard/certification vs the cap", () => {
    const body = buildDemoDay3Body("dana@example.com");
    assert.match(body, /removes that cap/i);
    assert.match(body, /scenario library/i);
    assert.match(body, /manager dashboard/i);
    assert.match(body, /certification/i);
    assert.match(body, /Get Started: https:\/\/www\.solveframework\.com/);
    assertBrandSafe(body);
  });

  test("sequence has the right three steps and subjects", () => {
    const seq = buildDemoDripSequence("dana@example.com");
    assert.deepEqual(seq.map((s) => s.step), [1, 2, 3]);
    assert.equal(seq[0].emailSubject, DEMO_DAY0_SUBJECT);
    assert.equal(seq[1].emailSubject, DEMO_DAY1_SUBJECT);
    assert.equal(seq[2].emailSubject, DEMO_DAY3_SUBJECT);
    for (const s of seq) assertBrandSafe(s.emailSubject);
  });

  test("step offsets are day 0 / 1 / 3", () => {
    assert.deepEqual(DEMO_DRIP_STEP_OFFSET_DAYS, { 1: 0, 2: 1, 3: 3 });
    const nowMs = Date.parse("2026-07-10T00:00:00.000Z");
    assert.equal(demoScheduledAtForStep(2, nowMs), new Date(nowMs + 1 * DAY).toISOString());
    assert.equal(demoScheduledAtForStep(3, nowMs), new Date(nowMs + 3 * DAY).toISOString());
  });
});

// ===========================================================================
// enrollDemoDrip
// ===========================================================================

describe("enrollDemoDrip", () => {
  const now = new Date("2026-07-10T00:00:00.000Z");
  const nowMs = now.getTime();
  const signup: Pick<DemoSignup, "id" | "email"> = { id: 7, email: "dana@example.com" };

  function makeDeps(opts: { suppressed?: boolean; sendResult?: boolean } = {}) {
    const rows: DemoDripEmail[] = [];
    const sends: { to: string; subject: string }[] = [];
    const deps = {
      now: () => now,
      send: async (to: string, subject: string) => {
        sends.push({ to, subject });
        return opts.sendResult ?? true;
      },
      storage: {
        getEmailSuppression: async (_e: string) => (opts.suppressed ? ({ id: 1, email: _e, suppressedAt: "x" } as any) : undefined),
        createDemoDripEmail: async (row: any) => {
          const created = { id: rows.length + 1, ...row } as DemoDripEmail;
          rows.push(created);
          return created;
        },
      },
    };
    return { deps, rows, sends };
  }

  test("sends day 0 inline and schedules steps 2/3 at +1d/+3d", async () => {
    const { deps, rows, sends } = makeDeps();
    await enrollDemoDrip(deps as any, signup);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].subject, DEMO_DAY0_SUBJECT);

    assert.equal(rows.length, 3);
    assert.equal(rows[0].status, "sent");
    assert.equal(rows[0].sentAt, now.toISOString());
    assert.equal(rows[1].status, "scheduled");
    assert.equal(rows[1].scheduledAt, new Date(nowMs + 1 * DAY).toISOString());
    assert.equal(rows[2].status, "scheduled");
    assert.equal(rows[2].scheduledAt, new Date(nowMs + 3 * DAY).toISOString());
    for (const r of rows) assert.equal(r.signupId, 7);
  });

  test("when already suppressed: nothing is sent and every step is recorded stopped", async () => {
    const { deps, rows, sends } = makeDeps({ suppressed: true });
    await enrollDemoDrip(deps as any, signup);
    assert.equal(sends.length, 0);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.status, "stopped");
  });

  test("never throws when storage rejects", async () => {
    const deps = {
      now: () => now,
      send: async () => true,
      storage: {
        getEmailSuppression: async () => undefined,
        createDemoDripEmail: async () => {
          throw new Error("db down");
        },
      },
    };
    await assert.doesNotReject(enrollDemoDrip(deps as any, signup));
  });
});

// ===========================================================================
// sendDueDemoDripEmails
// ===========================================================================

describe("sendDueDemoDripEmails", () => {
  const now = new Date("2026-07-20T00:00:00.000Z");

  function dripRow(overrides: Partial<DemoDripEmail> = {}): DemoDripEmail {
    return {
      id: 1,
      signupId: 7,
      sequenceStep: 2,
      emailSubject: DEMO_DAY1_SUBJECT,
      emailBody: "placeholder",
      scheduledAt: "2026-07-19T00:00:00.000Z",
      sentAt: null,
      status: "scheduled",
      ...overrides,
    };
  }

  function makeStorage(opts: {
    due: DemoDripEmail[];
    signup?: Pick<DemoSignup, "id" | "email">;
    sessions?: DemoSession[];
    suppressed?: boolean;
  }) {
    const updates: Record<number, Partial<DemoDripEmail>> = {};
    return {
      updates,
      store: {
        listDueDemoDripEmails: async (_iso: string) => opts.due,
        getDemoSignup: async (id: number) => (opts.signup && opts.signup.id === id ? opts.signup : undefined),
        listDemoSessionsBySignup: async (_id: number) => opts.sessions ?? [],
        getEmailSuppression: async (_e: string) => (opts.suppressed ? ({ id: 1 } as any) : undefined),
        updateDemoDripEmail: async (id: number, patch: Partial<DemoDripEmail>) => {
          updates[id] = patch;
          return { ...dripRow({ id }), ...patch };
        },
      },
    };
  }

  test("personalizes step 2 from the latest scored session and marks it sent", async () => {
    const sessions = [
      { id: 1, status: "completed", score: 60, feedback: "old" } as any,
      { id: 2, status: "completed", score: 82, feedback: "Great discovery." } as any,
    ];
    const h = makeStorage({ due: [dripRow({ id: 3 })], signup: { id: 7, email: "dana@example.com" }, sessions });
    const sends: { to: string; html: string }[] = [];
    const result = await sendDueDemoDripEmails({
      storage: h.store as any,
      send: async (to, _s, html) => {
        sends.push({ to, html });
        return true;
      },
      now: () => now,
    });
    assert.deepEqual(result, { sent: 1, failed: 0, stopped: 0 });
    assert.match(sends[0].html, /82 out of 100/);
    assert.match(sends[0].html, /Great discovery\./);
    assert.equal(h.updates[3].status, "sent");
  });

  test("a suppressed recipient is marked stopped and never emailed", async () => {
    const h = makeStorage({
      due: [dripRow({ id: 4 })],
      signup: { id: 7, email: "dana@example.com" },
      suppressed: true,
    });
    let calls = 0;
    const result = await sendDueDemoDripEmails({
      storage: h.store as any,
      send: async () => {
        calls += 1;
        return true;
      },
      now: () => now,
    });
    assert.deepEqual(result, { sent: 0, failed: 0, stopped: 1 });
    assert.equal(calls, 0);
    assert.equal(h.updates[4].status, "stopped");
  });

  test("a failed send leaves the row scheduled (retried next tick)", async () => {
    const h = makeStorage({ due: [dripRow({ id: 5 })], signup: { id: 7, email: "dana@example.com" } });
    const result = await sendDueDemoDripEmails({
      storage: h.store as any,
      send: async () => false,
      now: () => now,
    });
    assert.deepEqual(result, { sent: 0, failed: 1, stopped: 0 });
    assert.equal(h.updates[5], undefined);
  });

  test("a missing signup counts as failed and sends nothing", async () => {
    const h = makeStorage({ due: [dripRow({ id: 6, signupId: 999 })], signup: { id: 7, email: "dana@example.com" } });
    let calls = 0;
    const result = await sendDueDemoDripEmails({
      storage: h.store as any,
      send: async () => {
        calls += 1;
        return true;
      },
      now: () => now,
    });
    assert.deepEqual(result, { sent: 0, failed: 1, stopped: 0 });
    assert.equal(calls, 0);
  });
});

// ===========================================================================
// Migration
// ===========================================================================

describe("migration 0023 (demo-activation drip)", () => {
  test("creates demo_drip_emails keyed to demo_signups and adds unsubscribed", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "migrations/0023_demo_activation_drip.sql"),
      "utf8",
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "demo_drip_emails"/);
    assert.match(sql, /REFERENCES "demo_signups"\("id"\)/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS "unsubscribed"/);
  });

  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8"),
    );
    assert.ok(journal.entries.some((e: any) => e.tag === "0023_demo_activation_drip"));
  });
});
