// HTTP tests for the Message Coach routes.
//
// The model is injected as a spy through registerMessageCoachRoutes' responder
// option, so every "this must not cost an API call" claim is proved by a call
// count rather than argued. The seat gate is injected the same way the real
// server injects routes.ts's checkSeatAccess.
//
// MESSAGE_COACH_ENABLED is set per test, never globally, because the point of
// the flag is that it defaults off.
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { storage } from "./storage";
import { __setStripeForTests } from "./stripe";
import { __setFetchForTests } from "./notifications";
import {
  registerMessageCoachRoutes,
  messageCoachEnabled,
  type SeatGate,
} from "./messageCoachRoutes";
import { MESSAGE_COACH_PRICE_CENTS, signMessageCoachToken } from "./messageCoach";
import type {
  MessageCoachPaidPurchase,
  MessageCoachScore,
  MessageCoachSignup,
  ScoreCache,
  User,
} from "@shared/schema";

const GOOD_REPLY_OBJECT = {
  score: 31,
  stalledStep: "asked for a decision before any discovery",
  coaching: 'You opened with "ready to sell", which asks a stranger to decide.',
  rewrite: "Hi [their name], quick question about your place. Reply STOP to opt out.",
};
const GOOD_REPLY = JSON.stringify(GOOD_REPLY_OBJECT);
// scoreOutreachMessage's internal rewrite verification re-scores the rewrite
// TWICE, independently, and requires both checks to clear the floor before
// returning it (a single check is not enough evidence: a real customer
// resubmission showed a rewrite verified at 90 land at 72 on an independent
// re-check). These route tests are not about that loop
// (server/messageCoach.test.ts owns that), they are about routing, gating
// and persistence, so this reply always clears the floor on both checks:
// every call after the first that this responder sees is one of the loop's
// two verification calls, and it reports a passing score so no retry fires
// and call counts below stay meaningful for what the routes themselves do.
const GOOD_REPLY_VERIFIED = JSON.stringify({ ...GOOD_REPLY_OBJECT, score: 92 });

let signups: MessageCoachSignup[];
let scores: MessageCoachScore[];
let purchases: MessageCoachPaidPurchase[];
let scoreCache: ScoreCache[];
let users: User[];
let suppressedEmails: Set<string>;
// Every Resend audience-contacts call the route caused, so tests can assert
// on sync behaviour without hitting the network.
let audienceSyncCalls: { url: string; body: any }[];
// Every prompt the route caused. Length is the assertion that matters most:
// a refused request must never reach the model.
let modelCalls: string[];
// What the injected seat gate answers, per test.
let seatAnswer: Awaited<ReturnType<SeatGate>> = {
  ok: false,
  status: 402,
  message: "No active seat",
};

function patchStorage(): void {
  signups = [];
  scores = [];
  purchases = [];
  scoreCache = [];
  users = [];
  modelCalls = [];
  suppressedEmails = new Set();
  audienceSyncCalls = [];

  (storage as any).getEmailSuppression = async (email: string) =>
    suppressedEmails.has(email) ? { id: 1, email, suppressedAt: "2026-01-01T00:00:00.000Z" } : undefined;

  __setFetchForTests((async (url: string, init?: any) => {
    if (url.includes("/audiences/") && url.endsWith("/contacts")) {
      audienceSyncCalls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return { ok: true, text: async () => "" } as Response;
    }
    return { ok: true, text: async () => "" } as Response;
  }) as any);

  (storage as any).getMessageCoachSignupByEmail = async (email: string) =>
    signups.find((s) => s.email === email);
  (storage as any).createMessageCoachSignup = async (row: any) => {
    if (signups.some((s) => s.email === row.email)) {
      throw new Error("duplicate email"); // mirrors the DB unique constraint
    }
    // Mirrors the real table's column defaults (code/codeExpiresAt/lastSentAt
    // nullable, verified defaults false) for any field the caller omits, the
    // same way getOrCreateMessageCoachSignup relies on the DB default rather
    // than setting verified itself.
    const created = {
      id: signups.length + 1,
      code: null,
      codeExpiresAt: null,
      verified: false,
      lastSentAt: null,
      ...row,
    } as MessageCoachSignup;
    signups.push(created);
    return created;
  };
  (storage as any).updateMessageCoachSignup = async (id: number, patch: any) => {
    const row = signups.find((s) => s.id === id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  };
  // The real implementation is a single conditional UPDATE with the IS NULL
  // check inside it, so the read and the write cannot be separated. Mirrored
  // here, because that indivisibility is exactly what the free-score-once
  // guarantee rests on.
  (storage as any).claimFreeMessageCoachScore = async (id: number, usedAt: string) => {
    const row = signups.find((s) => s.id === id);
    if (!row || row.freeScoreUsedAt !== null) return undefined;
    row.freeScoreUsedAt = usedAt;
    return row;
  };
  (storage as any).createMessageCoachScore = async (row: any) => {
    const created = { id: scores.length + 1, ...row } as MessageCoachScore;
    scores.push(created);
    return created;
  };
  (storage as any).getMessageCoachPaidPurchaseByStripeCheckoutSessionId = async (id: string) =>
    purchases.find((p) => p.stripeCheckoutSessionId === id);
  (storage as any).updateMessageCoachPaidPurchase = async (id: number, patch: any) => {
    const row = purchases.find((p) => p.id === id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  };
  (storage as any).claimMessageCoachPaidPurchase = async (id: number) => {
    const row = purchases.find((p) => p.id === id);
    if (!row || row.status !== "paid") return undefined;
    row.status = "consumed";
    row.consumedAt = new Date().toISOString();
    return row;
  };
  (storage as any).getScoreCacheEntry = async (hash: string) =>
    scoreCache.find((r) => r.contentHash === hash);
  (storage as any).createScoreCacheEntry = async (entry: any) => {
    const row = { id: scoreCache.length + 1, ...entry } as ScoreCache;
    scoreCache.push(row);
    return row;
  };
  (storage as any).getUser = async (id: number) => users.find((u) => u.id === id);
}

function paidPurchase(overrides: Partial<MessageCoachPaidPurchase> = {}): MessageCoachPaidPurchase {
  const row = {
    id: purchases.length + 1,
    signupId: 1,
    email: "buyer@example.com",
    stripeCheckoutSessionId: `cs_${purchases.length + 1}`,
    stripePaymentIntentId: "pi_1",
    amountTotal: MESSAGE_COACH_PRICE_CENTS,
    status: "paid",
    createdAt: "2026-07-01T00:00:00.000Z",
    paidAt: "2026-07-01T00:00:01.000Z",
    consumedAt: null,
    consumedByScoreId: null,
    ...overrides,
  } as MessageCoachPaidPurchase;
  purchases.push(row);
  return row;
}

describe("Message Coach routes", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    registerMessageCoachRoutes(app, {
      responder: async (input: string) => {
        modelCalls.push(input);
        // Call 1 per scored message is the original score; calls 2 and 3
        // are the loop's two independent verification checks of the
        // rewrite, both passing so no retry fires.
        return modelCalls.length % 3 === 1 ? GOOD_REPLY : GOOD_REPLY_VERIFIED;
      },
      seatGate: async () => seatAnswer,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => server?.close());

  beforeEach(() => {
    patchStorage();
    seatAnswer = { ok: false, status: 402, message: "No active seat" };
    process.env.MESSAGE_COACH_ENABLED = "true";
    process.env.RESEND_API_KEY = "re_test_key";
    __setStripeForTests(null);
  });

  afterEach(() => {
    delete process.env.MESSAGE_COACH_ENABLED;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.RESEND_API_KEY;
    __setFetchForTests(null);
  });

  // Auto-attaches a valid verificationToken for any body with an `email`,
  // unless the caller already set verificationToken explicitly (including to
  // undefined, which the gate tests use to prove the check actually runs).
  // This keeps every pre-existing free/paid/member-path test exercising the
  // same behavior it always has, while the gate itself is covered by its own
  // dedicated tests below.
  function post(path: string, body: any) {
    const withToken =
      body && typeof body === "object" && "email" in body && !("verificationToken" in body)
        ? { ...body, verificationToken: signMessageCoachToken(body.email) }
        : body;
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withToken),
    });
  }

  // For tests that need to send a request with no auto-injected token, e.g.
  // to prove the gate rejects an anonymous request that never verified.
  function postRaw(path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // =========================================================================
  // The feature flag
  // =========================================================================

  describe("MESSAGE_COACH_ENABLED", () => {
    test("defaults off when the variable is unset", () => {
      delete process.env.MESSAGE_COACH_ENABLED;
      assert.equal(messageCoachEnabled(), false);
    });

    // Anything other than the exact string keeps the whole feature dark, so a
    // half-set value in a deployment cannot switch on a payments feature.
    test("only the exact string \"true\" enables it", () => {
      for (const value of ["", "false", "TRUE", "True", "1", "yes", "true "]) {
        process.env.MESSAGE_COACH_ENABLED = value;
        assert.equal(messageCoachEnabled(), false, `"${value}" must not enable the feature`);
      }
      process.env.MESSAGE_COACH_ENABLED = "true";
      assert.equal(messageCoachEnabled(), true);
    });

    test("every route 404s while the flag is off", async () => {
      delete process.env.MESSAGE_COACH_ENABLED;
      const config = await fetch(`${baseUrl}/api/message-coach/config`);
      assert.equal(config.status, 404);

      const score = await post("/api/message-coach/score", {
        email: "off@example.com",
        message: "hello",
      });
      assert.equal(score.status, 404);

      const checkout = await post("/api/message-coach/checkout", { email: "off@example.com" });
      assert.equal(checkout.status, 404);

      assert.equal(modelCalls.length, 0);
      assert.equal(signups.length, 0);
    });

    // The flag is read per request, not captured at import time, so flipping it
    // does not require a restart or a fresh module load.
    test("is read per request, not captured at import time", async () => {
      delete process.env.MESSAGE_COACH_ENABLED;
      assert.equal((await fetch(`${baseUrl}/api/message-coach/config`)).status, 404);
      process.env.MESSAGE_COACH_ENABLED = "true";
      assert.equal((await fetch(`${baseUrl}/api/message-coach/config`)).status, 200);
    });
  });

  describe("GET /api/message-coach/config", () => {
    test("advertises the price the server actually charges", async () => {
      const res = await fetch(`${baseUrl}/api/message-coach/config`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.enabled, true);
      assert.equal(body.priceCents, MESSAGE_COACH_PRICE_CENTS);
      assert.equal(body.priceCents, 499);
      assert.deepEqual(body.industries, [
        "Auto",
        "Real Estate",
        "Mortgage",
        "Home Services",
        "Other",
      ]);
    });
  });

  // =========================================================================
  // Email verification: request-code, verify-code, and the gate on
  // score/checkout that requires a valid token for the anonymous path.
  // =========================================================================

  describe("POST /api/message-coach/request-code", () => {
    test("sends a code and stores it on the signup", async () => {
      const res = await postRaw("/api/message-coach/request-code", {
        email: "Coder@Example.com ",
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });

      assert.equal(signups.length, 1);
      assert.equal(signups[0].email, "coder@example.com");
      assert.ok(signups[0].code, "a code must be stored");
      assert.equal(signups[0].code?.length, 6);
      assert.ok(signups[0].codeExpiresAt);
      assert.ok(signups[0].lastSentAt);
      assert.equal(signups[0].verified, false, "requesting a code does not verify the email");
    });

    test("reuses the existing signup rather than creating a second one", async () => {
      await post("/api/message-coach/score", { email: "existing@example.com", message: "free one" });
      assert.equal(signups.length, 1);

      const res = await postRaw("/api/message-coach/request-code", { email: "existing@example.com" });
      assert.equal(res.status, 200);
      assert.equal(signups.length, 1, "must not create a second signup for the same email");
      assert.ok(signups[0].code);
    });

    test("a disposable email is rejected before a code is generated", async () => {
      const res = await postRaw("/api/message-coach/request-code", { email: "throwaway@mailinator.com" });
      assert.equal(res.status, 400);
      assert.equal(signups.length, 0);
    });

    test("a missing or malformed email is rejected", async () => {
      for (const body of [{}, { email: "not-an-email" }]) {
        const res = await postRaw("/api/message-coach/request-code", body);
        assert.equal(res.status, 400);
      }
      assert.equal(signups.length, 0);
    });

    test("a Resend send failure surfaces a retryable 502 rather than a fake success", async () => {
      delete process.env.RESEND_API_KEY;
      const res = await postRaw("/api/message-coach/request-code", { email: "nosend@example.com" });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).retryable, true);
      // The signup and code are still stored, so a retry does not start over.
      assert.equal(signups.length, 1);
      assert.ok(signups[0].code);
    });

    test("404s while the feature flag is off", async () => {
      delete process.env.MESSAGE_COACH_ENABLED;
      const res = await postRaw("/api/message-coach/request-code", { email: "off@example.com" });
      assert.equal(res.status, 404);
      assert.equal(signups.length, 0);
    });
  });

  describe("POST /api/message-coach/verify-code", () => {
    async function requestedCode(email: string): Promise<string> {
      await postRaw("/api/message-coach/request-code", { email });
      const signup = signups.find((s) => s.email === email);
      return signup!.code!;
    }

    test("a correct code returns a token and marks the signup verified", async () => {
      const code = await requestedCode("goodcode@example.com");
      const res = await postRaw("/api/message-coach/verify-code", {
        email: "goodcode@example.com",
        code,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.verified, true);
      assert.ok(typeof body.token === "string" && body.token.length > 0);

      const signup = signups.find((s) => s.email === "goodcode@example.com")!;
      assert.equal(signup.verified, true);
      assert.equal(signup.code, null, "the code must be consumed (single-use)");
      assert.equal(signup.codeExpiresAt, null);
    });

    test("the returned token passes the score gate for that same email", async () => {
      const code = await requestedCode("tokenholder@example.com");
      const verifyRes = await postRaw("/api/message-coach/verify-code", {
        email: "tokenholder@example.com",
        code,
      });
      const { token } = await verifyRes.json();

      const res = await postRaw("/api/message-coach/score", {
        email: "tokenholder@example.com",
        message: "hello there",
        verificationToken: token,
      });
      assert.equal(res.status, 200);
      // 1 call to score, 2 independent calls to verify the rewrite clears
      // the floor on both checks.
      assert.equal(modelCalls.length, 3);
    });

    test("a wrong code is rejected and does not consume the real one", async () => {
      const code = await requestedCode("wrongcode@example.com");
      const res = await postRaw("/api/message-coach/verify-code", {
        email: "wrongcode@example.com",
        code: code === "000000" ? "111111" : "000000",
      });
      assert.equal(res.status, 400);

      const signup = signups.find((s) => s.email === "wrongcode@example.com")!;
      assert.equal(signup.code, code, "an incorrect attempt must not consume the real code");
      assert.equal(signup.verified, false);
    });

    test("an expired code is rejected", async () => {
      await postRaw("/api/message-coach/request-code", { email: "expired@example.com" });
      const signup = signups.find((s) => s.email === "expired@example.com")!;
      // Force the stored code into the past, as if the 10 minute window lapsed.
      signup.codeExpiresAt = new Date(Date.now() - 1000).toISOString();

      const res = await postRaw("/api/message-coach/verify-code", {
        email: "expired@example.com",
        code: signup.code!,
      });
      assert.equal(res.status, 400);
      assert.equal(signups.find((s) => s.email === "expired@example.com")!.verified, false);
    });

    test("a code cannot be used twice", async () => {
      const code = await requestedCode("reuse@example.com");
      const first = await postRaw("/api/message-coach/verify-code", { email: "reuse@example.com", code });
      assert.equal(first.status, 200);

      const second = await postRaw("/api/message-coach/verify-code", { email: "reuse@example.com", code });
      assert.equal(second.status, 400, "a consumed code must not verify a second time");
    });

    test("verifying with no prior code request is rejected", async () => {
      const res = await postRaw("/api/message-coach/verify-code", {
        email: "nevercalled@example.com",
        code: "123456",
      });
      assert.equal(res.status, 400);
      assert.equal(signups.length, 0);
    });

    test("404s while the feature flag is off", async () => {
      const code = await requestedCode("stillon@example.com");
      delete process.env.MESSAGE_COACH_ENABLED;
      const res = await postRaw("/api/message-coach/verify-code", { email: "stillon@example.com", code });
      assert.equal(res.status, 404);
    });
  });

  describe("Verification gate on score/checkout (anonymous path)", () => {
    test("score is refused with 401 verification_required when no token is sent", async () => {
      const res = await postRaw("/api/message-coach/score", {
        email: "unverified@example.com",
        message: "hello",
      });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, "verification_required");
      assert.equal(modelCalls.length, 0, "an unverified request must never reach the model");
      assert.equal(signups.length, 0, "an unverified request must not create a signup or spend the free score");
    });

    test("score is refused when the token is for a different email", async () => {
      const res = await postRaw("/api/message-coach/score", {
        email: "victim@example.com",
        message: "hello",
        verificationToken: signMessageCoachToken("attacker@example.com"),
      });
      assert.equal(res.status, 401);
      assert.equal(modelCalls.length, 0);
      assert.equal(signups.length, 0);
    });

    test("score is refused when the token is expired", async () => {
      const staleToken = signMessageCoachToken("stale@example.com", Date.now() - 2 * 60 * 60 * 1000);
      const res = await postRaw("/api/message-coach/score", {
        email: "stale@example.com",
        message: "hello",
        verificationToken: staleToken,
      });
      assert.equal(res.status, 401);
      assert.equal(modelCalls.length, 0);
    });

    test("score is refused when the token is garbage", async () => {
      const res = await postRaw("/api/message-coach/score", {
        email: "garbage@example.com",
        message: "hello",
        verificationToken: "not-a-real-token",
      });
      assert.equal(res.status, 401);
      assert.equal(modelCalls.length, 0);
    });

    test("a valid token for the claimed email allows the free score", async () => {
      const res = await postRaw("/api/message-coach/score", {
        email: "legit@example.com",
        message: "hello",
        verificationToken: signMessageCoachToken("legit@example.com"),
      });
      assert.equal(res.status, 200);
      assert.equal(modelCalls.length, 3);
    });

    test("a member with an active seat is never asked to verify", async () => {
      users.push({ id: 77, officeId: 3 } as User);
      seatAnswer = { ok: true };
      const res = await postRaw("/api/message-coach/score", { userId: 77, message: "member message" });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).source, "member");
      assert.equal(signups.length, 0);
    });

    test("checkout is refused with 401 verification_required when no token is sent", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
      __setStripeForTests({
        checkout: {
          sessions: {
            create: async () => {
              throw new Error("Stripe must not be called for an unverified checkout");
            },
          },
        },
      });
      const res = await postRaw("/api/message-coach/checkout", { email: "unverified@example.com" });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, "verification_required");
      assert.equal(signups.length, 0);
      assert.equal(purchases.length, 0);
    });

    test("checkout succeeds with a valid token for the claimed email", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
      __setStripeForTests({
        checkout: {
          sessions: {
            create: async () => ({ id: "cs_verified", url: "https://checkout.stripe.com/c/pay/cs_verified" }),
          },
        },
      });
      (storage as any).createMessageCoachPaidPurchase = async (row: any) => {
        const created = { id: purchases.length + 1, ...row } as MessageCoachPaidPurchase;
        purchases.push(created);
        return created;
      };

      const res = await postRaw("/api/message-coach/checkout", {
        email: "verifiedbuyer@example.com",
        verificationToken: signMessageCoachToken("verifiedbuyer@example.com"),
      });
      assert.equal(res.status, 200);
      assert.equal(purchases.length, 1);
    });
  });

  // =========================================================================
  // The free score: one per email, ever
  // =========================================================================

  describe("POST /api/message-coach/score, free path", () => {
    test("scores the first message for an email and captures the signup", async () => {
      const res = await post("/api/message-coach/score", {
        name: "Dana",
        email: "First@Example.com ",
        message: "Are you ready to sell your house?",
        industry: "Real Estate",
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.score, 31);
      assert.equal(body.source, "free");
      assert.match(body.rewrite, /Reply STOP to opt out\./);
      assert.equal(modelCalls.length, 3);

      assert.equal(signups.length, 1);
      assert.equal(signups[0].email, "first@example.com", "the email must be normalized");
      assert.equal(signups[0].name, "Dana");
      assert.ok(signups[0].freeScoreUsedAt);

      assert.equal(scores.length, 1);
      assert.equal(scores[0].source, "free");
      assert.equal(scores[0].signupId, signups[0].id);
      assert.equal(scores[0].industry, "Real Estate");
      assert.equal(scores[0].messageText, "Are you ready to sell your house?");
    });

    // The money test: a refused request must cost nothing. The free score is
    // spent by a conditional UPDATE before the model is ever reached, so the
    // second call cannot even attempt to score.
    test("a second call from the same email is refused with 402 and no model call", async () => {
      const first = await post("/api/message-coach/score", {
        email: "repeat@example.com",
        message: "first message",
      });
      assert.equal(first.status, 200);
      assert.equal(modelCalls.length, 3);

      const second = await post("/api/message-coach/score", {
        email: "repeat@example.com",
        message: "a completely different message",
      });
      assert.equal(second.status, 402);
      const body = await second.json();
      assert.equal(body.priceCents, MESSAGE_COACH_PRICE_CENTS);
      assert.match(body.message, /free score/);
      assert.ok(!body.message.includes("—"), "no em dash in the paywall message");

      assert.equal(modelCalls.length, 3, "the refused request must not have called the model");
      assert.equal(scores.length, 1);
      assert.equal(signups.length, 1);
    });

    test("the same email in different casing is the same person", async () => {
      assert.equal(
        (await post("/api/message-coach/score", { email: "Case@Example.com", message: "a" }))
          .status,
        200,
      );
      assert.equal(
        (await post("/api/message-coach/score", { email: "case@EXAMPLE.com", message: "b" }))
          .status,
        402,
      );
      assert.equal(signups.length, 1);
      assert.equal(modelCalls.length, 3);
    });

    test("a different email still gets its own free score", async () => {
      await post("/api/message-coach/score", { email: "one@example.com", message: "a" });
      const other = await post("/api/message-coach/score", {
        email: "two@example.com",
        message: "b",
      });
      assert.equal(other.status, 200);
      assert.equal(signups.length, 2);
      assert.equal(modelCalls.length, 6);
    });

    // A model failure is our fault, not the visitor's, so the free score is
    // handed back rather than burned.
    test("a model failure releases the free score instead of eating it", async () => {
      const brokenApp = express();
      brokenApp.use(express.json());
      let attempts = 0;
      registerMessageCoachRoutes(brokenApp, {
        responder: async () => {
          attempts += 1;
          throw new Error("model exploded");
        },
      });
      const brokenServer = await new Promise<Server>((resolve) => {
        const s = brokenApp.listen(0, () => resolve(s));
      });
      const addr = brokenServer.address();
      const brokenUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

      const res = await fetch(`${brokenUrl}/api/message-coach/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "unlucky@example.com",
          message: "hello",
          verificationToken: signMessageCoachToken("unlucky@example.com"),
        }),
      });
      assert.equal(res.status, 502);
      assert.equal(attempts, 1);
      assert.equal(signups[0].freeScoreUsedAt, null, "the free score must be given back");
      assert.equal(scores.length, 0);
      brokenServer.close();
    });

    test("an email is required on the public path", async () => {
      const res = await post("/api/message-coach/score", { message: "hello" });
      assert.equal(res.status, 400);
      assert.equal(modelCalls.length, 0);
      assert.equal(signups.length, 0);
    });

    test("an empty message is rejected before anything is created", async () => {
      for (const message of ["", "   "]) {
        const res = await post("/api/message-coach/score", { email: "a@example.com", message });
        assert.equal(res.status, 400);
      }
      assert.equal(modelCalls.length, 0);
      assert.equal(signups.length, 0);
    });

    // The cap keeps a pasted novel from running up an unbounded model bill.
    test("a message over the length cap is rejected without calling the model", async () => {
      const res = await post("/api/message-coach/score", {
        email: "long@example.com",
        message: "x".repeat(4001),
      });
      assert.equal(res.status, 400);
      assert.equal(modelCalls.length, 0);

      const atCap = await post("/api/message-coach/score", {
        email: "long@example.com",
        message: "x".repeat(4000),
      });
      assert.equal(atCap.status, 200);
    });

    test("an unknown industry is rejected rather than passed to the model", async () => {
      const res = await post("/api/message-coach/score", {
        email: "bad@example.com",
        message: "hello",
        industry: "Crypto",
      });
      assert.equal(res.status, 400);
      assert.equal(modelCalls.length, 0);
    });
  });

  // =========================================================================
  // The paid score
  // =========================================================================

  describe("Resend audience sync (Message Coach Leads)", () => {
    test("a new signup via the free path is synced to the Message Coach Leads audience", async () => {
      const res = await post("/api/message-coach/score", {
        name: "Dana Lee",
        email: "dana@example.com",
        message: "Are you ready to sell your house?",
      });
      assert.equal(res.status, 200);
      assert.equal(audienceSyncCalls.length, 1);
      assert.match(audienceSyncCalls[0].url, /\/audiences\/.+\/contacts$/);
      assert.equal(audienceSyncCalls[0].body.email, "dana@example.com");
      assert.equal(audienceSyncCalls[0].body.first_name, "Dana");
      assert.equal(audienceSyncCalls[0].body.last_name, "Lee");
      assert.equal(audienceSyncCalls[0].body.unsubscribed, false);
      assert.ok(signups[0].resendSyncedAt, "resendSyncedAt must be stamped on success");
    });

    test("a repeat request for the same email does not sync again", async () => {
      await post("/api/message-coach/score", { email: "repeat@example.com", message: "first" });
      assert.equal(audienceSyncCalls.length, 1);

      // Second call from the same email hits the 402 paywall, not a new signup.
      await post("/api/message-coach/score", { email: "repeat@example.com", message: "second" });
      assert.equal(audienceSyncCalls.length, 1, "must not re-sync an already-synced signup");
    });

    test("a suppressed email is never added to the audience, but the signup is still created", async () => {
      suppressedEmails.add("optedout@example.com");
      const res = await post("/api/message-coach/score", {
        email: "optedout@example.com",
        message: "a message",
      });
      assert.equal(res.status, 200, "suppression must not block the product itself");
      assert.equal(audienceSyncCalls.length, 0, "a suppressed email must never be synced");
      assert.equal(signups.length, 1);
      assert.equal(signups[0].resendSyncedAt, null);
    });

    test("a checkout-path signup (no prior free score) is also synced", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
      __setStripeForTests({
        checkout: {
          sessions: {
            create: async () => ({ id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" }),
          },
        },
      });
      (storage as any).createMessageCoachPaidPurchase = async (row: any) => {
        const created = { id: purchases.length + 1, ...row } as MessageCoachPaidPurchase;
        purchases.push(created);
        return created;
      };

      const res = await post("/api/message-coach/checkout", {
        email: "buyer@example.com",
        name: "Buyer Bob",
      });
      assert.equal(res.status, 200);
      assert.equal(audienceSyncCalls.length, 1);
      assert.equal(audienceSyncCalls[0].body.email, "buyer@example.com");
      assert.equal(signups.length, 1);
      assert.ok(signups[0].resendSyncedAt);
    });

    test("a Resend outage never blocks the score response", async () => {
      __setFetchForTests((async () => {
        throw new Error("network down");
      }) as any);
      const res = await post("/api/message-coach/score", {
        email: "resilient@example.com",
        message: "a message",
      });
      assert.equal(res.status, 200, "a Resend failure must not fail the score request");
      assert.equal(signups[0].resendSyncedAt, null, "a failed sync leaves resendSyncedAt null for retry");
    });
  });

  describe("POST /api/message-coach/score, paid path", () => {
    async function spentFreeScore(email: string): Promise<MessageCoachSignup> {
      await post("/api/message-coach/score", { email, message: "the free one" });
      modelCalls.length = 0;
      return signups[0];
    }

    test("a paid purchase scores again and is consumed exactly once", async () => {
      const signup = await spentFreeScore("buyer@example.com");
      const purchase = paidPurchase({ signupId: signup.id });

      const res = await post("/api/message-coach/score", {
        email: "buyer@example.com",
        message: "the paid one",
        paidCheckoutSessionId: purchase.stripeCheckoutSessionId,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.source, "paid");
      assert.equal(modelCalls.length, 3);
      assert.equal(purchases[0].status, "consumed");
      assert.ok(purchases[0].consumedAt);
      assert.equal(purchases[0].consumedByScoreId, scores[1].id);
      assert.equal(scores[1].source, "paid");

      // The credit is spent, so quoting it again is refused and costs nothing.
      const again = await post("/api/message-coach/score", {
        email: "buyer@example.com",
        message: "trying to reuse it",
        paidCheckoutSessionId: purchase.stripeCheckoutSessionId,
      });
      assert.equal(again.status, 409);
      assert.equal(modelCalls.length, 3, "a spent purchase must not reach the model");
      assert.equal(scores.length, 2);
    });

    // The webhook has not landed yet. Not an error, and not a reason to give the
    // score away.
    test("a pending purchase gets a retry-shortly 409, not a free score", async () => {
      const signup = await spentFreeScore("slow@example.com");
      const purchase = paidPurchase({ signupId: signup.id, status: "pending", paidAt: null });

      const res = await post("/api/message-coach/score", {
        email: "slow@example.com",
        message: "hello",
        paidCheckoutSessionId: purchase.stripeCheckoutSessionId,
      });
      assert.equal(res.status, 409);
      assert.match((await res.json()).message, /still confirming/);
      assert.equal(modelCalls.length, 0);
      assert.equal(purchases[0].status, "pending");
    });

    // A Checkout Session id is not a bearer token for anyone who holds it: the
    // purchase must belong to the email making the request.
    test("another visitor's purchase cannot be spent", async () => {
      await post("/api/message-coach/score", { email: "owner@example.com", message: "free" });
      await post("/api/message-coach/score", { email: "thief@example.com", message: "free" });
      modelCalls.length = 0;
      const purchase = paidPurchase({ signupId: signups[0].id });

      const res = await post("/api/message-coach/score", {
        email: "thief@example.com",
        message: "not mine",
        paidCheckoutSessionId: purchase.stripeCheckoutSessionId,
      });
      assert.equal(res.status, 404);
      assert.equal(modelCalls.length, 0);
      assert.equal(purchases[0].status, "paid", "the owner's credit must be untouched");
    });

    test("a made-up checkout session id buys nothing", async () => {
      await spentFreeScore("faker@example.com");
      const res = await post("/api/message-coach/score", {
        email: "faker@example.com",
        message: "hello",
        paidCheckoutSessionId: "cs_i_made_this_up",
      });
      assert.equal(res.status, 404);
      assert.equal(modelCalls.length, 0);
    });

    // The buyer paid. A failure on our side must not silently eat their credit.
    test("a model failure releases the purchase so the buyer can retry", async () => {
      const brokenApp = express();
      brokenApp.use(express.json());
      registerMessageCoachRoutes(brokenApp, {
        responder: async () => {
          throw new Error("model exploded");
        },
      });
      const brokenServer = await new Promise<Server>((resolve) => {
        const s = brokenApp.listen(0, () => resolve(s));
      });
      const addr = brokenServer.address();
      const brokenUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

      signups.push({
        id: 1,
        email: "paid-unlucky@example.com",
        name: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        freeScoreUsedAt: "2026-07-01T00:00:00.000Z",
      } as MessageCoachSignup);
      const purchase = paidPurchase({ signupId: 1 });

      const res = await fetch(`${brokenUrl}/api/message-coach/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "paid-unlucky@example.com",
          message: "hello",
          verificationToken: signMessageCoachToken("paid-unlucky@example.com"),
          paidCheckoutSessionId: purchase.stripeCheckoutSessionId,
        }),
      });
      assert.equal(res.status, 502);
      assert.equal(purchases[0].status, "paid", "the buyer's credit must be released");
      assert.equal(purchases[0].consumedAt, null);
      assert.equal(scores.length, 0);
      brokenServer.close();
    });
  });

  // =========================================================================
  // The member path
  // =========================================================================

  describe("POST /api/message-coach/score, member path", () => {
    beforeEach(() => {
      users.push({ id: 42, officeId: 7 } as User);
    });

    test("an active seat scores with no email and no limit", async () => {
      seatAnswer = { ok: true };
      for (let i = 0; i < 3; i += 1) {
        const res = await post("/api/message-coach/score", {
          userId: 42,
          message: `member message ${i}`,
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).source, "member");
      }
      assert.equal(modelCalls.length, 9);
      assert.equal(scores.length, 3);
      // A member is already captured as a user, so no lead row is created and
      // no free-score allowance is touched.
      assert.equal(signups.length, 0, "a member must not be captured as a lead again");
      assert.equal(scores[0].signupId, null);
      assert.equal(scores[0].officeId, 7, "the score belongs to the member's office");
    });

    // Falling through rather than refusing means a lapsed member is still a
    // visitor who can use the free tool.
    test("a user without an active seat falls through to the public path", async () => {
      seatAnswer = { ok: false, status: 402, message: "No active seat" };
      const noEmail = await post("/api/message-coach/score", { userId: 42, message: "hello" });
      assert.equal(noEmail.status, 400, "the public path needs an email");
      assert.equal(modelCalls.length, 0);

      const withEmail = await post("/api/message-coach/score", {
        userId: 42,
        email: "lapsed@example.com",
        message: "hello",
      });
      assert.equal(withEmail.status, 200);
      assert.equal((await withEmail.json()).source, "free");
      assert.equal(signups.length, 1);
    });

    // The score route is public, so a userId in the body is only ever a claim.
    // The injected gate is the thing that decides, and it is always consulted.
    test("an unverified userId claim does not bypass the free-score limit", async () => {
      seatAnswer = { ok: false, status: 401, message: "Unknown user" };
      await post("/api/message-coach/score", {
        userId: 9999,
        email: "claimer@example.com",
        message: "first",
      });
      const second = await post("/api/message-coach/score", {
        userId: 9999,
        email: "claimer@example.com",
        message: "second",
      });
      assert.equal(second.status, 402);
      assert.equal(modelCalls.length, 3);
    });
  });

  // =========================================================================
  // Checkout
  // =========================================================================

  describe("POST /api/message-coach/checkout", () => {
    test("returns a Checkout URL and records a pending purchase", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
      const calls: any[] = [];
      __setStripeForTests({
        checkout: {
          sessions: {
            create: async (params: any) => {
              calls.push(params);
              return { id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" };
            },
          },
        },
      });
      (storage as any).createMessageCoachPaidPurchase = async (row: any) => {
        const created = { id: purchases.length + 1, ...row } as MessageCoachPaidPurchase;
        purchases.push(created);
        return created;
      };

      const res = await post("/api/message-coach/checkout", {
        email: "Buyer@Example.com",
        name: "Dana",
      });
      assert.equal(res.status, 200);
      assert.match((await res.json()).url, /^https:\/\/checkout\.stripe\.com\//);
      assert.equal(calls[0].mode, "payment");
      assert.equal(calls[0].line_items[0].price_data.unit_amount, MESSAGE_COACH_PRICE_CENTS);
      assert.equal(purchases.length, 1);
      assert.equal(purchases[0].status, "pending");
      assert.equal(purchases[0].email, "buyer@example.com");
      assert.equal(signups[0].email, "buyer@example.com");
    });

    test("reuses the existing signup rather than creating a second one", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
      __setStripeForTests({
        checkout: {
          sessions: {
            create: async () => ({ id: "cs_x", url: "https://checkout.stripe.com/c/pay/cs_x" }),
          },
        },
      });
      (storage as any).createMessageCoachPaidPurchase = async (row: any) => {
        const created = { id: purchases.length + 1, ...row } as MessageCoachPaidPurchase;
        purchases.push(created);
        return created;
      };

      await post("/api/message-coach/score", { email: "again@example.com", message: "free one" });
      assert.equal(signups.length, 1);
      const res = await post("/api/message-coach/checkout", { email: "again@example.com" });
      assert.equal(res.status, 200);
      assert.equal(signups.length, 1);
      assert.equal(purchases[0].signupId, signups[0].id);
    });

    test("degrades gracefully when Stripe is not configured", async () => {
      delete process.env.STRIPE_SECRET_KEY;
      __setStripeForTests(null);
      const res = await post("/api/message-coach/checkout", { email: "nostripe@example.com" });
      assert.equal(res.status, 503);
      assert.equal(purchases.length, 0);
      assert.equal(signups.length, 0);
    });

    test("a missing or malformed email is rejected", async () => {
      // Stripe is injected so the request gets past the isStripeConfigured
      // boundary and is actually refused by validation. It throws if reached,
      // which would mean a bad email had created a real Checkout Session.
      __setStripeForTests({
        checkout: {
          sessions: {
            create: async () => {
              throw new Error("Stripe must not be called for an invalid email");
            },
          },
        },
      });
      for (const body of [{}, { email: "not-an-email" }]) {
        const res = await post("/api/message-coach/checkout", body);
        assert.equal(res.status, 400);
      }
      assert.equal(signups.length, 0);
      assert.equal(purchases.length, 0);
    });
  });
});
