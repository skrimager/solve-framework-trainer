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
import {
  registerMessageCoachRoutes,
  messageCoachEnabled,
  type SeatGate,
} from "./messageCoachRoutes";
import { MESSAGE_COACH_PRICE_CENTS } from "./messageCoach";
import type {
  MessageCoachPaidPurchase,
  MessageCoachScore,
  MessageCoachSignup,
  ScoreCache,
  User,
} from "@shared/schema";

const GOOD_REPLY = JSON.stringify({
  score: 31,
  stalledStep: "asked for a decision before any discovery",
  coaching: 'You opened with "ready to sell", which asks a stranger to decide.',
  rewrite: "Hi [their name], quick question about your place. Reply STOP to opt out.",
});

let signups: MessageCoachSignup[];
let scores: MessageCoachScore[];
let purchases: MessageCoachPaidPurchase[];
let scoreCache: ScoreCache[];
let users: User[];
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

  (storage as any).getMessageCoachSignupByEmail = async (email: string) =>
    signups.find((s) => s.email === email);
  (storage as any).createMessageCoachSignup = async (row: any) => {
    if (signups.some((s) => s.email === row.email)) {
      throw new Error("duplicate email"); // mirrors the DB unique constraint
    }
    const created = { id: signups.length + 1, ...row } as MessageCoachSignup;
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
        return GOOD_REPLY;
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
    __setStripeForTests(null);
  });

  afterEach(() => {
    delete process.env.MESSAGE_COACH_ENABLED;
    delete process.env.STRIPE_SECRET_KEY;
  });

  function post(path: string, body: unknown) {
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
      assert.equal(modelCalls.length, 1);

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
      assert.equal(modelCalls.length, 1);

      const second = await post("/api/message-coach/score", {
        email: "repeat@example.com",
        message: "a completely different message",
      });
      assert.equal(second.status, 402);
      const body = await second.json();
      assert.equal(body.priceCents, MESSAGE_COACH_PRICE_CENTS);
      assert.match(body.message, /free score/);
      assert.ok(!body.message.includes("—"), "no em dash in the paywall message");

      assert.equal(modelCalls.length, 1, "the refused request must not have called the model");
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
      assert.equal(modelCalls.length, 1);
    });

    test("a different email still gets its own free score", async () => {
      await post("/api/message-coach/score", { email: "one@example.com", message: "a" });
      const other = await post("/api/message-coach/score", {
        email: "two@example.com",
        message: "b",
      });
      assert.equal(other.status, 200);
      assert.equal(signups.length, 2);
      assert.equal(modelCalls.length, 2);
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
        body: JSON.stringify({ email: "unlucky@example.com", message: "hello" }),
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
      assert.equal(modelCalls.length, 1);
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
      assert.equal(modelCalls.length, 1, "a spent purchase must not reach the model");
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
      assert.equal(modelCalls.length, 3);
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
      assert.equal(modelCalls.length, 1);
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
