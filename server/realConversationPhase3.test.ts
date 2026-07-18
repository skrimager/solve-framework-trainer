import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { registerRealConversationRoutes, registerManagerRosterRoutes } from "./routes";
import {
  evaluateRealConversationCap,
  countMonthlyCountedSubmissions,
  realConversationCapBlockedMessage,
  REAL_CONVERSATION_MONTHLY_CAP,
} from "./realConversationCap";
import type { RealConversation, RubricScores } from "@shared/schema";
import type { RealConversationScorer } from "./realConversations";

// ===========================================================================
// Phase 3: monthly per-rep cap, manager-submits-on-behalf, rep visibility of
// manager-submitted scores with attribution, and the office-scoped Field view.
// Follows the existing realConversations/roster test pattern: stub `storage`,
// register the real routes on a real express server, assert over live HTTP.
// ===========================================================================

const SAMPLE_RUBRIC: RubricScores = {
  needsDiscovery: 40,
  objectionPrevention: 82,
  trustBuilding: 75,
  naturalClose: 60,
  relationshipContinuity: 90,
};

function makeFakeScorer() {
  const calls: unknown[] = [];
  const scorer: RealConversationScorer = async (transcript) => {
    calls.push(transcript);
    return { rubric: SAMPLE_RUBRIC, feedback: "ok", overall: 68 };
  };
  return { scorer, calls };
}

// A minimal stored real-conversation row, defaulting to a counted submission
// created "now", so cap tests can pre-seed a rep's month.
function mkRow(partial: Partial<RealConversation> & { id: number; subjectRepUserId: number }): RealConversation {
  return {
    submittedByUserId: partial.subjectRepUserId,
    officeId: 1,
    submissionType: "text_chat",
    rawTranscript: "x",
    originalAudioFilename: null,
    overallScore: 68,
    rubricScores: JSON.stringify(SAMPLE_RUBRIC),
    feedback: "ok",
    stalledStep: "Listen",
    consentAccepted: true,
    consentAcceptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    submissionCountedForCap: true,
    fieldVerifiedEligible: null,
    ...partial,
  } as RealConversation;
}

// ---------------------------------------------------------------------------
// Pure cap module (no DB, no network).
// ---------------------------------------------------------------------------

describe("real conversation cap (pure)", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");

  test("counts only counted submissions created in the current month", () => {
    const rows = [
      mkRow({ id: 1, subjectRepUserId: 2, createdAt: "2026-07-01T00:00:00.000Z" }),
      mkRow({ id: 2, subjectRepUserId: 2, createdAt: "2026-07-31T23:59:59.000Z" }),
      // Prior month: excluded.
      mkRow({ id: 3, subjectRepUserId: 2, createdAt: "2026-06-30T23:59:59.000Z" }),
      // Not flagged as counted: excluded.
      mkRow({ id: 4, subjectRepUserId: 2, submissionCountedForCap: false }),
      mkRow({ id: 5, subjectRepUserId: 2, submissionCountedForCap: null }),
    ];
    assert.equal(countMonthlyCountedSubmissions(rows, now), 2);
  });

  test("blocks at the cap and resets across a month boundary", () => {
    const atCap = Array.from({ length: REAL_CONVERSATION_MONTHLY_CAP }, (_, i) =>
      mkRow({ id: i + 1, subjectRepUserId: 2, createdAt: "2026-07-10T00:00:00.000Z" }),
    );
    const julyStatus = evaluateRealConversationCap({ rows: atCap, now });
    assert.equal(julyStatus.count, REAL_CONVERSATION_MONTHLY_CAP);
    assert.equal(julyStatus.blocked, true);
    assert.equal(julyStatus.remaining, 0);

    // Same rows, evaluated in the NEXT month: the counter has reset.
    const augStatus = evaluateRealConversationCap({ rows: atCap, now: new Date("2026-08-01T00:00:00.000Z") });
    assert.equal(augStatus.count, 0);
    assert.equal(augStatus.blocked, false);
    assert.equal(augStatus.remaining, REAL_CONVERSATION_MONTHLY_CAP);
  });

  test("blocked message names the cap and reset date, no em dash", () => {
    const msg = realConversationCapBlockedMessage("2026-08-01T00:00:00.000Z");
    assert.match(msg, /20 real-conversation submissions/);
    assert.match(msg, /August 1, 2026/);
    assert.ok(!msg.includes("—"), "message must not contain an em dash");
  });
});

// ---------------------------------------------------------------------------
// Routes: cap enforcement, manager-on-behalf, attribution, Field view.
// ---------------------------------------------------------------------------

describe("real conversation Phase 3 routes", () => {
  let server: Server;
  let baseUrl: string;
  let created: RealConversation[];
  let usersById: Record<number, any>;
  let officesById: Record<number, any>;

  before(async () => {
    const app = express();
    app.use(express.json());
    const fake = makeFakeScorer();
    registerRealConversationRoutes(app, { scorer: fake.scorer });
    registerManagerRosterRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => server?.close());

  beforeEach(() => {
    created = [];
    officesById = {
      1: { id: 1, subscriptionStatus: "active" },
      2: { id: 2, subscriptionStatus: "active" },
    };
    usersById = {
      1: { id: 1, officeId: 1, role: "manager", displayName: "Manager One", seatActive: true, isDemoAccount: false },
      2: { id: 2, officeId: 1, role: "consultant", displayName: "Rep A", seatActive: true, isDemoAccount: false },
      3: { id: 3, officeId: 1, role: "consultant", displayName: "Rep B", seatActive: true, isDemoAccount: false },
      4: { id: 4, officeId: 2, role: "manager", displayName: "Manager Two", seatActive: true, isDemoAccount: false },
      5: { id: 5, officeId: 2, role: "consultant", displayName: "Rep C", seatActive: true, isDemoAccount: false },
      6: { id: 6, officeId: 1, role: "consultant", displayName: "Rep Unpaid", seatActive: false, isDemoAccount: false },
    };
    (storage as any).getUser = async (id: number) => usersById[id];
    (storage as any).getOffice = async (id: number) => officesById[id];
    (storage as any).createRealConversation = async (rc: any) => {
      const row = { id: created.length + 1, ...rc } as RealConversation;
      created.push(row);
      return row;
    };
    (storage as any).listRealConversationsBySubjectRep = async (repId: number) =>
      created.filter((r) => r.subjectRepUserId === repId).slice().reverse();
  });

  // Seed `n` counted submissions this month for a given rep.
  function seedCap(subjectRepUserId: number, n: number) {
    for (let i = 0; i < n; i++) {
      created.push(mkRow({ id: created.length + 1, subjectRepUserId }));
    }
  }

  async function post(body: unknown) {
    const res = await fetch(`${baseUrl}/api/real-conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const selfBody = {
    userId: 2,
    submissionType: "text_chat",
    rawTranscript: "Customer: hi\nMe: hello, what brought you in?",
    consentAccepted: true,
  };

  // --- Cap enforcement ---

  test("a fresh rep can submit; the submission is flagged counted for the cap", async () => {
    const { status, body } = await post(selfBody);
    assert.equal(status, 200);
    assert.equal(body.submissionCountedForCap, true);
    assert.equal(body.subjectRepUserId, 2);
    assert.equal(body.submittedByUserId, 2);
  });

  test("the 21st submission in a month is rejected (429) and no row is created", async () => {
    seedCap(2, REAL_CONVERSATION_MONTHLY_CAP);
    const before = created.length;
    const { status, body } = await post(selfBody);
    assert.equal(status, 429);
    assert.match(body.message, /20 real-conversation submissions/);
    assert.equal(created.length, before, "no new row when blocked");
  });

  test("the cap applies independently per rep (rep A at cap does not block rep B)", async () => {
    seedCap(2, REAL_CONVERSATION_MONTHLY_CAP);
    const blocked = await post(selfBody);
    assert.equal(blocked.status, 429);
    // Rep B (id 3) is fresh and can still submit.
    const ok = await post({ ...selfBody, userId: 3 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.subjectRepUserId, 3);
  });

  test("prior-month submissions do not count against this month", async () => {
    for (let i = 0; i < REAL_CONVERSATION_MONTHLY_CAP; i++) {
      created.push(mkRow({ id: created.length + 1, subjectRepUserId: 2, createdAt: "2020-01-01T00:00:00.000Z" }));
    }
    const { status } = await post(selfBody);
    assert.equal(status, 200);
  });

  // --- Manager submits on behalf of a rep ---

  test("a manager can submit on behalf of a rep in their office (attribution recorded)", async () => {
    const { status, body } = await post({
      userId: 1, // manager
      subjectRepUserId: 2, // rep A
      submissionType: "text_chat",
      rawTranscript: "Customer: hi\nMe: hello",
      consentAccepted: true,
    });
    assert.equal(status, 200);
    assert.equal(body.submittedByUserId, 1);
    assert.equal(body.subjectRepUserId, 2);
    assert.equal(body.officeId, 1);
  });

  test("a manager from ANOTHER office cannot submit for a rep (403), no row created", async () => {
    const { status } = await post({
      userId: 4, // manager, office 2
      subjectRepUserId: 2, // rep A, office 1
      submissionType: "text_chat",
      rawTranscript: "Customer: hi\nMe: hello",
      consentAccepted: true,
    });
    assert.equal(status, 403);
    assert.equal(created.length, 0);
  });

  test("a plain consultant cannot submit on behalf of another rep (403)", async () => {
    const { status } = await post({
      userId: 3, // rep B
      subjectRepUserId: 2, // rep A
      submissionType: "text_chat",
      rawTranscript: "Customer: hi\nMe: hello",
      consentAccepted: true,
    });
    assert.equal(status, 403);
    assert.equal(created.length, 0);
  });

  test("manager-on-behalf still requires consent", async () => {
    const { status } = await post({
      userId: 1,
      subjectRepUserId: 2,
      submissionType: "text_chat",
      rawTranscript: "Customer: hi\nMe: hello",
      consentAccepted: false,
    });
    assert.equal(status, 400);
    assert.equal(created.length, 0);
  });

  test("manager-on-behalf is blocked when the TARGET rep is at the cap", async () => {
    seedCap(2, REAL_CONVERSATION_MONTHLY_CAP);
    const before = created.length;
    const { status } = await post({
      userId: 1,
      subjectRepUserId: 2,
      submissionType: "text_chat",
      rawTranscript: "Customer: hi\nMe: hello",
      consentAccepted: true,
    });
    assert.equal(status, 429);
    assert.equal(created.length, before);
  });

  test("the seat gate checks the TARGET rep's seat, not the manager's", async () => {
    // Manager (paid) submits for an unpaid rep -> 402 on the rep's seat.
    const { status } = await post({
      userId: 1,
      subjectRepUserId: 6, // unpaid consultant
      submissionType: "text_chat",
      rawTranscript: "Customer: hi\nMe: hello",
      consentAccepted: true,
    });
    assert.equal(status, 402);
    assert.equal(created.length, 0);
  });

  // --- Rep visibility + attribution ---

  test("a rep sees manager-submitted entries about themselves with attribution, and not other reps'", async () => {
    // Manager submits for rep A; rep B submits for themselves.
    await post({ userId: 1, subjectRepUserId: 2, submissionType: "text_chat", rawTranscript: "Customer: hi\nMe: a", consentAccepted: true });
    await post({ ...selfBody, userId: 3 });

    const res = await fetch(`${baseUrl}/api/real-conversations?userId=2`);
    const rows = await res.json();
    assert.equal(res.status, 200);
    assert.equal(rows.length, 1, "rep A sees only submissions about rep A");
    assert.equal(rows[0].subjectRepUserId, 2);
    assert.equal(rows[0].managerSubmitted, true);
    assert.equal(rows[0].submittedByName, "Manager One");
  });

  test("a rep's own submission is not marked manager-submitted", async () => {
    await post(selfBody);
    const res = await fetch(`${baseUrl}/api/real-conversations?userId=2`);
    const rows = await res.json();
    assert.equal(rows[0].managerSubmitted, false);
    assert.equal(rows[0].submittedByName, "Rep A");
  });

  // --- Manager Field view (office-scoped) ---

  test("Field endpoint returns a rep's real conversations with attribution", async () => {
    await post({ userId: 1, subjectRepUserId: 2, submissionType: "text_chat", rawTranscript: "Customer: hi\nMe: a", consentAccepted: true });
    const res = await fetch(`${baseUrl}/api/offices/1/consultants/2/real-conversations?requesterId=1`);
    const rows = await res.json();
    assert.equal(res.status, 200);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].managerSubmitted, true);
    assert.equal(rows[0].submittedByName, "Manager One");
  });

  test("Field endpoint rejects a manager from another office (403)", async () => {
    const res = await fetch(`${baseUrl}/api/offices/1/consultants/2/real-conversations?requesterId=4`);
    assert.equal(res.status, 403);
  });

  test("Field endpoint 404s for a rep outside the office", async () => {
    const res = await fetch(`${baseUrl}/api/offices/1/consultants/5/real-conversations?requesterId=1`);
    assert.equal(res.status, 404);
  });

  test("Field endpoint rejects a plain consultant (403)", async () => {
    const res = await fetch(`${baseUrl}/api/offices/1/consultants/2/real-conversations?requesterId=3`);
    assert.equal(res.status, 403);
  });
});
