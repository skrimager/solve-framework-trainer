import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { planBackfill, BACKFILL_SIGNUP_IDS } from "./backfill_voice_demo_contacts";
import type { Contact, DemoSignup } from "@shared/schema";

// ===========================================================================
// Pure unit tests for the backfill script's planning logic (no DB, no I/O).
// The script's main() only wires this plan up to storage.getDemoSignup /
// storage.listContacts / storage.createLead -- a full DB-integration test of
// main() itself is not attempted here since the sandbox has no test DB to run
// it against (see the PR description for what was/wasn't tested).
// ===========================================================================

function signup(overrides: Partial<DemoSignup> = {}): DemoSignup {
  return {
    id: 1,
    email: "someone@example.com",
    code: null,
    codeExpiresAt: null,
    verified: true,
    sessionsUsed: 0,
    createdAt: "2026-05-01T00:00:00.000Z",
    lastSentAt: null,
    unsubscribed: false,
    ...overrides,
  } as DemoSignup;
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 1,
    name: "Someone",
    email: "someone@example.com",
    company: null,
    message: null,
    referredBy: null,
    status: "new",
    type: "role_play",
    source: "voice_demo",
    priority: "medium",
    owner: null,
    followUpDate: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("BACKFILL_SIGNUP_IDS", () => {
  test("is exactly the corrected 6-id list from the spec, in order", () => {
    assert.deepEqual(BACKFILL_SIGNUP_IDS, [11, 10, 9, 7, 3, 2]);
  });

  test("does not include the two signups that already have a contact from the CTA form", () => {
    assert.ok(!BACKFILL_SIGNUP_IDS.includes(6), "signup 6 (sheld68@gmail.com) already has CTA-form contacts");
    assert.ok(!BACKFILL_SIGNUP_IDS.includes(4), "signup 4 (ksyost@pldi.net) already has a CTA-form contact");
  });

  test("does not include the two internal test accounts", () => {
    assert.ok(!BACKFILL_SIGNUP_IDS.includes(8), "signup 8 is an internal QA test account");
    assert.ok(!BACKFILL_SIGNUP_IDS.includes(5), "signup 5 is an internal verify-test account");
  });
});

describe("planBackfill", () => {
  const signups = new Map<number, DemoSignup>([
    [11, signup({ id: 11, email: "shane9399@gmail.com", createdAt: "2026-07-20T10:00:00.000Z" })],
    [10, signup({ id: 10, email: "jacquelyn.foland@outlook.com", createdAt: "2026-07-18T10:00:00.000Z" })],
    [9, signup({ id: 9, email: "wskrimager@gmail.com", createdAt: "2026-07-15T10:00:00.000Z" })],
    [7, signup({ id: 7, email: "tina@riversteamaz.com", createdAt: "2026-07-10T10:00:00.000Z" })],
    [3, signup({ id: 3, email: "kasotharvey@gmail.com", createdAt: "2026-06-01T10:00:00.000Z" })],
    [2, signup({ id: 2, email: "ozleng@yahoo.com", createdAt: "2026-05-20T10:00:00.000Z" })],
  ]);
  const getSignup = (id: number) => signups.get(id);

  test("plans a create for all 6 target signups when none has a contact yet", () => {
    const actions = planBackfill(BACKFILL_SIGNUP_IDS, getSignup, []);
    assert.equal(actions.length, 6);
    assert.ok(actions.every((a) => a.kind === "create"));
  });

  test("field mapping matches the live auto-create path (source voice_demo, type role_play), createdAt backdated to the signup's own createdAt", () => {
    const actions = planBackfill([11], getSignup, []);
    assert.equal(actions.length, 1);
    const action = actions[0];
    assert.equal(action.kind, "create");
    if (action.kind !== "create") throw new Error("unreachable");
    assert.equal(action.email, "shane9399@gmail.com");
    assert.equal(action.contact.source, "voice_demo");
    assert.equal(action.contact.type, "role_play");
    assert.equal(action.contact.status, "new");
    assert.equal(action.contact.company, null);
    assert.equal(action.contact.message, "Signed up for the SOLVE voice demo.");
    // Backdated to the ORIGINAL signup time, not "now".
    assert.equal(action.contact.createdAt, "2026-07-20T10:00:00.000Z");
    assert.equal(action.contact.name, "Shane9399");
  });

  test("is idempotent: re-running against contacts already created by a prior run skips every id", () => {
    const firstPass = planBackfill(BACKFILL_SIGNUP_IDS, getSignup, []);
    const createdContacts: Contact[] = firstPass
      .filter((a) => a.kind === "create")
      .map((a, i) => (a.kind === "create" ? contact({ id: i + 1, email: a.email }) : contact()));

    const secondPass = planBackfill(BACKFILL_SIGNUP_IDS, getSignup, createdContacts);
    assert.equal(secondPass.length, 6);
    assert.ok(secondPass.every((a) => a.kind === "skip_already_backfilled"));
  });

  test("skips (does not duplicate) a signup that already has a voice_demo contact from a partial prior run", () => {
    const existing = [contact({ email: "ozleng@yahoo.com", source: "voice_demo" })];
    const actions = planBackfill([2, 3], getSignup, existing);
    const forOzleng = actions.find((a) => a.signupId === 2)!;
    const forKasotharvey = actions.find((a) => a.signupId === 3)!;
    assert.equal(forOzleng.kind, "skip_already_backfilled");
    assert.equal(forKasotharvey.kind, "create");
  });

  test("does NOT skip sheld68/ksyost-style signups whose existing contact is role_play (CTA form), not voice_demo", () => {
    const existing = [contact({ email: "sheld68@gmail.com", source: "role_play" })];
    const signupsWithSheld = (id: number) => (id === 6 ? signup({ id: 6, email: "sheld68@gmail.com" }) : getSignup(id));
    const actions = planBackfill([6], signupsWithSheld, existing);
    assert.equal(actions[0].kind, "create", "a role_play CTA contact must not block a distinct voice_demo contact");
  });

  test("reports skip_no_signup for an id with no matching demo_signups row", () => {
    const actions = planBackfill([999], () => undefined, []);
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0], { kind: "skip_no_signup", signupId: 999 });
  });

  test("a duplicate id within the same run only plans one create (belt-and-suspenders)", () => {
    const actions = planBackfill([2, 2], getSignup, []);
    const creates = actions.filter((a) => a.kind === "create");
    assert.equal(creates.length, 1);
    assert.equal(actions[1].kind, "skip_already_backfilled");
  });
});
