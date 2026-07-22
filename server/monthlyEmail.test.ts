import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeEmail,
  payingUserEmails,
  isUnconvertedDemo,
  buildMonthlyDemoBody,
  buildMonthlyPayingBody,
  seedMonthlyLifecycleEmails,
  sendDueMonthlyEmails,
  MONTHLY_SUBJECT,
  MONTHLY_INTERVAL_DAYS,
  RECIPIENT_TYPE_DEMO,
  RECIPIENT_TYPE_PAYING,
} from "./monthlyEmail";
import type { DemoSignup, MonthlyLifecycleEmail, User } from "@shared/schema";

const DAY = 24 * 60 * 60 * 1000;

function assertBrandSafe(text: string) {
  assert.doesNotMatch(text, /train/i);
  assert.doesNotMatch(text, /—/);
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    officeId: 1,
    username: "payer@example.com",
    password: "x",
    role: "consultant",
    displayName: "Payer",
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

function signup(overrides: Partial<DemoSignup> = {}): DemoSignup {
  return {
    id: 1,
    email: "dana@example.com",
    code: null,
    codeExpiresAt: null,
    verified: true,
    sessionsUsed: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSentAt: null,
    unsubscribed: false,
    ...overrides,
  } as DemoSignup;
}

// ===========================================================================
// Pure eligibility helpers
// ===========================================================================

describe("eligibility helpers", () => {
  test("looksLikeEmail guards non-address usernames", () => {
    assert.equal(looksLikeEmail("a@b.com"), true);
    assert.equal(looksLikeEmail("consultant42"), false);
    assert.equal(looksLikeEmail(""), false);
  });

  test("payingUserEmails includes only seat-active, non-demo, email usernames", () => {
    const set = payingUserEmails([
      user({ username: "A@B.com" }),
      user({ username: "inactive@x.com", seatActive: false }),
      user({ username: "demo@x.com", isDemoAccount: true }),
      user({ username: "consultant42" }),
    ]);
    assert.deepEqual([...set], ["a@b.com"]);
  });

  test("isUnconvertedDemo excludes converted, unverified, and opted-out signups", () => {
    const payers = new Set(["converted@x.com"]);
    assert.equal(isUnconvertedDemo(signup({ email: "new@x.com" }), payers), true);
    assert.equal(isUnconvertedDemo(signup({ email: "converted@x.com" }), payers), false);
    assert.equal(isUnconvertedDemo(signup({ verified: false }), payers), false);
    assert.equal(isUnconvertedDemo(signup({ unsubscribed: true }), payers), false);
  });
});

describe("monthly copy", () => {
  test("both segments use the money subject and carry the unsubscribe footer, brand-safe", () => {
    assert.equal(MONTHLY_SUBJECT, "Practice makes money!");
    for (const body of [buildMonthlyDemoBody("dana@example.com"), buildMonthlyPayingBody("payer@example.com")]) {
      assert.match(body, /Practice makes money\./);
      assert.match(body, /opt out here: https?:\/\/[^\s]*\/api\/unsubscribe/);
      assertBrandSafe(body);
    }
  });

  test("demo segment nudges conversion; paying segment nudges re-engagement", () => {
    assert.match(buildMonthlyDemoBody("d@x.com"), /removes the three-session cap/i);
    assert.match(buildMonthlyPayingBody("p@x.com"), /monthly nudge/i);
  });
});

// ===========================================================================
// seedMonthlyLifecycleEmails
// ===========================================================================

describe("seedMonthlyLifecycleEmails", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");

  function makeDeps(opts: {
    signups: DemoSignup[];
    users: User[];
    existing?: MonthlyLifecycleEmail[];
    suppressedEmails?: string[];
  }) {
    const created: any[] = [];
    const suppressed = new Set(opts.suppressedEmails ?? []);
    return {
      created,
      deps: {
        now: () => now,
        storage: {
          listDemoSignups: async () => opts.signups,
          listUsers: async () => opts.users,
          listMonthlyLifecycleEmails: async () => opts.existing ?? [],
          getEmailSuppression: async (e: string) => (suppressed.has(e) ? ({ id: 1 } as any) : undefined),
          createMonthlyLifecycleEmail: async (row: any) => {
            const c = { id: created.length + 1, ...row };
            created.push(c);
            return c;
          },
        },
      },
    };
  }

  test("seeds one scheduled row (due now) per new eligible recipient in both segments", async () => {
    const { deps, created } = makeDeps({
      signups: [signup({ id: 1, email: "dana@example.com" })],
      users: [user({ id: 10, username: "payer@example.com" })],
    });
    const result = await seedMonthlyLifecycleEmails(deps as any);
    assert.equal(result.seeded, 2);
    const demo = created.find((r) => r.recipientType === RECIPIENT_TYPE_DEMO);
    const paying = created.find((r) => r.recipientType === RECIPIENT_TYPE_PAYING);
    assert.equal(demo.recipientId, 1);
    assert.equal(demo.scheduledAt, now.toISOString());
    assert.equal(demo.status, "scheduled");
    assert.equal(paying.recipientId, 10);
    assert.equal(paying.email, "payer@example.com");
  });

  test("does not re-seed a recipient who already has a row", async () => {
    const { deps, created } = makeDeps({
      signups: [signup({ id: 1, email: "dana@example.com" })],
      users: [],
      existing: [{ recipientType: RECIPIENT_TYPE_DEMO, recipientId: 1 } as any],
    });
    const result = await seedMonthlyLifecycleEmails(deps as any);
    assert.equal(result.seeded, 0);
    assert.equal(created.length, 0);
  });

  test("skips a converted demo signup and a suppressed recipient", async () => {
    const { deps, created } = makeDeps({
      signups: [signup({ id: 1, email: "converted@x.com" }), signup({ id: 2, email: "opted@x.com" })],
      users: [user({ id: 10, username: "converted@x.com" })],
      suppressedEmails: ["opted@x.com"],
    });
    const result = await seedMonthlyLifecycleEmails(deps as any);
    // Only the paying user (converted@x.com) is seeded; the demo row for that
    // same email is "converted" and the other demo is suppressed.
    assert.equal(result.seeded, 1);
    assert.equal(created[0].recipientType, RECIPIENT_TYPE_PAYING);
  });
});

// ===========================================================================
// sendDueMonthlyEmails
// ===========================================================================

describe("sendDueMonthlyEmails", () => {
  const now = new Date("2026-07-20T00:00:00.000Z");
  const nowMs = now.getTime();

  function dueRow(overrides: Partial<MonthlyLifecycleEmail> = {}): MonthlyLifecycleEmail {
    return {
      id: 1,
      recipientType: RECIPIENT_TYPE_DEMO,
      recipientId: 1,
      email: "dana@example.com",
      emailSubject: MONTHLY_SUBJECT,
      emailBody: "body",
      scheduledAt: "2026-07-19T00:00:00.000Z",
      sentAt: null,
      status: "scheduled",
      ...overrides,
    };
  }

  function makeStorage(opts: {
    due: MonthlyLifecycleEmail[];
    signups?: DemoSignup[];
    users?: User[];
    suppressedEmails?: string[];
  }) {
    const updates: Record<number, Partial<MonthlyLifecycleEmail>> = {};
    const created: any[] = [];
    const suppressed = new Set(opts.suppressedEmails ?? []);
    return {
      updates,
      created,
      store: {
        listDueMonthlyLifecycleEmails: async () => opts.due,
        getEmailSuppression: async (e: string) => (suppressed.has(e) ? ({ id: 1 } as any) : undefined),
        listDemoSignups: async () => opts.signups ?? [],
        listUsers: async () => opts.users ?? [],
        updateMonthlyLifecycleEmail: async (id: number, patch: Partial<MonthlyLifecycleEmail>) => {
          updates[id] = patch;
          return { ...dueRow({ id }), ...patch };
        },
        createMonthlyLifecycleEmail: async (row: any) => {
          const c = { id: 999, ...row };
          created.push(c);
          return c;
        },
      },
    };
  }

  test("sends, marks sent, and self-perpetuates +30d when still eligible", async () => {
    const h = makeStorage({
      due: [dueRow({ id: 3 })],
      signups: [signup({ id: 1, email: "dana@example.com" })],
      users: [],
    });
    const result = await sendDueMonthlyEmails({
      storage: h.store as any,
      send: async () => true,
      now: () => now,
    });
    assert.deepEqual(result, { sent: 1, failed: 0, stopped: 0 });
    assert.equal(h.updates[3].status, "sent");
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].scheduledAt, new Date(nowMs + MONTHLY_INTERVAL_DAYS * DAY).toISOString());
    assert.equal(h.created[0].status, "scheduled");
  });

  test("does NOT re-enqueue when the recipient is no longer eligible (converted)", async () => {
    const h = makeStorage({
      due: [dueRow({ id: 3, email: "dana@example.com" })],
      signups: [signup({ id: 1, email: "dana@example.com" })],
      users: [user({ id: 10, username: "dana@example.com" })], // now a paying user => converted
    });
    const result = await sendDueMonthlyEmails({
      storage: h.store as any,
      send: async () => true,
      now: () => now,
    });
    assert.equal(result.sent, 1);
    assert.equal(h.created.length, 0);
  });

  test("a suppressed recipient is marked stopped, not sent, and not re-enqueued", async () => {
    const h = makeStorage({ due: [dueRow({ id: 4 })], suppressedEmails: ["dana@example.com"] });
    let calls = 0;
    const result = await sendDueMonthlyEmails({
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
    assert.equal(h.created.length, 0);
  });

  test("a failed send leaves the row scheduled and enqueues nothing", async () => {
    const h = makeStorage({ due: [dueRow({ id: 5 })], signups: [signup({ id: 1, email: "dana@example.com" })] });
    const result = await sendDueMonthlyEmails({
      storage: h.store as any,
      send: async () => false,
      now: () => now,
    });
    assert.deepEqual(result, { sent: 0, failed: 1, stopped: 0 });
    assert.equal(h.updates[5], undefined);
    assert.equal(h.created.length, 0);
  });
});
