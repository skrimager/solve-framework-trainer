// Tests for the one-time ($4.99) individual demo practice session purchase.
//
// Nothing here touches the network: Stripe is replaced through the
// __setStripeForTests seam in stripe.ts, and storage is monkey-patched with
// in-memory arrays. The fake recordBillingEvent throws on a duplicate
// stripeEventId so it mirrors the DB unique constraint that makes the webhook
// idempotent for real.
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type Stripe from "stripe";

import { storage } from "./storage";
import { __setStripeForTests, APP_URL } from "./stripe";
import { registerPublicAndAdminRoutes } from "./routes";
import { __setFetchForTests } from "./notifications";
import { normalizeEmail, signDemoToken } from "./demo";
import {
  DEMO_SESSION_PRICE_CENTS,
  DEMO_PAID_SESSION_KIND,
  createDemoSessionCheckout,
  handleDemoPaymentEvent,
  availablePaidSessionCredits,
  consumeOldestPaidCredit,
} from "./demoPayments";
import type {
  BillingEvent,
  DemoPaidSession,
  DemoSession,
  DemoSignup,
  Scenario,
} from "@shared/schema";

// --- In-memory storage (no database needed) ---
let purchases: DemoPaidSession[];
let billingEvents: BillingEvent[];
let demoSessions: DemoSession[];

function patchStorage(): void {
  purchases = [];
  billingEvents = [];
  demoSessions = [];

  (storage as any).createDemoPaidSession = async (row: any) => {
    if (purchases.some((p) => p.stripeCheckoutSessionId === row.stripeCheckoutSessionId)) {
      throw new Error("duplicate stripeCheckoutSessionId"); // mirrors the DB unique constraint
    }
    const created = { id: purchases.length + 1, ...row } as DemoPaidSession;
    purchases.push(created);
    return created;
  };
  (storage as any).getDemoPaidSessionByStripeCheckoutSessionId = async (id: string) =>
    purchases.find((p) => p.stripeCheckoutSessionId === id);
  (storage as any).updateDemoPaidSession = async (id: number, patch: any) => {
    const row = purchases.find((p) => p.id === id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  };
  (storage as any).listDemoPaidSessionsBySignup = async (signupId: number) =>
    purchases.filter((p) => p.signupId === signupId).sort((a, b) => a.id - b.id);
  // The real implementation is a single conditional UPDATE, so the status check
  // and the write cannot be separated. Mirrored here.
  (storage as any).claimOldestPaidDemoSession = async (signupId: number, demoSessionId: number) => {
    const row = purchases
      .filter((p) => p.signupId === signupId && p.status === "paid")
      .sort((a, b) => a.id - b.id)[0];
    if (!row) return undefined;
    row.status = "consumed";
    row.consumedAt = new Date().toISOString();
    row.consumedByDemoSessionId = demoSessionId;
    return row;
  };
  (storage as any).getBillingEventByStripeId = async (eid: string) =>
    billingEvents.find((e) => e.stripeEventId === eid);
  (storage as any).recordBillingEvent = async (e: any) => {
    if (billingEvents.some((x) => x.stripeEventId === e.stripeEventId)) {
      throw new Error("duplicate stripeEventId"); // mirrors the DB unique constraint
    }
    const row = { id: billingEvents.length + 1, ...e } as BillingEvent;
    billingEvents.push(row);
    return row;
  };
  (storage as any).updateDemoSession = async (id: number, patch: any) => {
    const row = demoSessions.find((s) => s.id === id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  };
  (storage as any).getDemoSession = async (id: number) => demoSessions.find((s) => s.id === id);
}

function paidPurchase(overrides: Partial<DemoPaidSession> = {}): DemoPaidSession {
  const row = {
    id: purchases.length + 1,
    signupId: 1,
    email: "buyer@example.com",
    stripeCheckoutSessionId: `cs_${purchases.length + 1}`,
    stripePaymentIntentId: "pi_1",
    amountTotal: DEMO_SESSION_PRICE_CENTS,
    status: "paid",
    createdAt: "2026-07-01T00:00:00.000Z",
    paidAt: "2026-07-01T00:00:01.000Z",
    consumedAt: null,
    consumedByDemoSessionId: null,
    ...overrides,
  } as DemoPaidSession;
  purchases.push(row);
  return row;
}

// A fake Stripe covering only what demoPayments.ts calls. Every create call is
// recorded so tests can assert on the exact params sent to Stripe.
function fakeStripe(calls: any[] = [], retrieved: Record<string, any> = {}): void {
  __setStripeForTests({
    checkout: {
      sessions: {
        create: async (params: any) => {
          calls.push(params);
          const id = `cs_test_${calls.length}`;
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
        retrieve: async (id: string) => retrieved[id],
      },
    },
  });
}

function checkoutSessionCompleted(
  id: string,
  session: Partial<Stripe.Checkout.Session>,
): Stripe.Event {
  return {
    id,
    type: "checkout.session.completed",
    data: { object: { metadata: { kind: DEMO_PAID_SESSION_KIND }, ...session } },
  } as unknown as Stripe.Event;
}

describe("createDemoSessionCheckout", () => {
  beforeEach(() => patchStorage());

  test("creates a one-time payment session, never a subscription", async () => {
    const calls: any[] = [];
    fakeStripe(calls);
    await createDemoSessionCheckout({ signupId: 7, email: "buyer@example.com" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "payment");
    assert.notEqual(calls[0].mode, "subscription");
  });

  test("identifies the buyer by customer_email, creating no Stripe Customer", async () => {
    const calls: any[] = [];
    fakeStripe(calls);
    await createDemoSessionCheckout({ signupId: 7, email: "buyer@example.com" });
    assert.equal(calls[0].customer_email, "buyer@example.com");
    assert.equal(calls[0].customer, undefined);
  });

  test("charges exactly the advertised price as an inline line item", async () => {
    const calls: any[] = [];
    fakeStripe(calls);
    await createDemoSessionCheckout({ signupId: 7, email: "buyer@example.com" });
    assert.equal(DEMO_SESSION_PRICE_CENTS, 499);
    assert.equal(calls[0].line_items.length, 1);
    assert.equal(calls[0].line_items[0].quantity, 1);
    assert.equal(calls[0].line_items[0].price_data.unit_amount, DEMO_SESSION_PRICE_CENTS);
    assert.equal(calls[0].line_items[0].price_data.currency, "usd");
    // No em dash in anything the buyer sees on the Stripe page.
    assert.ok(!calls[0].line_items[0].price_data.product_data.name.includes("—"));
    // No subscription price id may leak into the one-time purchase.
    assert.equal(calls[0].line_items[0].price, undefined);
  });

  test("tags the session so the webhook can tell it apart from office billing", async () => {
    const calls: any[] = [];
    fakeStripe(calls);
    await createDemoSessionCheckout({ signupId: 7, email: "buyer@example.com" });
    assert.equal(calls[0].metadata.kind, DEMO_PAID_SESSION_KIND);
    assert.equal(calls[0].metadata.demoSignupId, "7");
    assert.equal(calls[0].metadata.email, "buyer@example.com");
  });

  test("returns the visitor to the demo with a success or cancelled marker", async () => {
    const calls: any[] = [];
    fakeStripe(calls);
    const url = await createDemoSessionCheckout({ signupId: 7, email: "buyer@example.com" });
    assert.equal(calls[0].success_url, `${APP_URL}/#/demo?paid=success&session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(calls[0].cancel_url, `${APP_URL}/#/demo?paid=cancelled`);
    assert.match(url, /^https:\/\/checkout\.stripe\.com\//);
  });

  test("records the purchase as pending, granting no credit before payment", async () => {
    fakeStripe();
    await createDemoSessionCheckout({ signupId: 7, email: "buyer@example.com" });
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].status, "pending");
    assert.equal(purchases[0].signupId, 7);
    assert.equal(purchases[0].amountTotal, DEMO_SESSION_PRICE_CENTS);
    assert.equal(purchases[0].paidAt, null);
    assert.equal(await availablePaidSessionCredits(7), 0);
  });

  test("throws rather than returning a broken redirect if Stripe gives no URL", async () => {
    __setStripeForTests({
      checkout: { sessions: { create: async () => ({ id: "cs_nourl", url: null }) } },
    });
    await assert.rejects(
      () => createDemoSessionCheckout({ signupId: 7, email: "buyer@example.com" }),
      /did not return a Checkout URL/,
    );
    assert.equal(purchases.length, 0);
  });
});

describe("handleDemoPaymentEvent", () => {
  beforeEach(() => patchStorage());

  // Grants a credit for a purchase created through the real code path.
  async function pendingPurchase(): Promise<string> {
    const calls: any[] = [];
    fakeStripe(calls);
    await createDemoSessionCheckout({ signupId: 1, email: "buyer@example.com" });
    return purchases[0].stripeCheckoutSessionId;
  }

  function stripeReturning(sessionId: string, session: Record<string, any>): void {
    fakeStripe([], {
      [sessionId]: { id: sessionId, metadata: { kind: DEMO_PAID_SESSION_KIND }, ...session },
    });
  }

  test("a paid checkout grants exactly one credit", async () => {
    const csId = await pendingPurchase();
    stripeReturning(csId, { payment_status: "paid", payment_intent: "pi_abc" });
    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_1", { id: csId }));
    assert.equal(purchases[0].status, "paid");
    assert.equal(purchases[0].stripePaymentIntentId, "pi_abc");
    assert.ok(purchases[0].paidAt);
    assert.equal(await availablePaidSessionCredits(1), 1);
  });

  // The property that protects real money: Stripe retries deliveries, so the
  // same event id can arrive more than once.
  test("redelivering the same event id credits only one session", async () => {
    const csId = await pendingPurchase();
    stripeReturning(csId, { payment_status: "paid", payment_intent: "pi_abc" });
    const event = checkoutSessionCompleted("evt_dup", { id: csId });

    await handleDemoPaymentEvent(event);
    await handleDemoPaymentEvent(event);

    assert.equal(purchases.filter((p) => p.status === "paid").length, 1);
    assert.equal(await availablePaidSessionCredits(1), 1);
    assert.equal(billingEvents.filter((e) => e.stripeEventId.includes("evt_dup")).length, 1);
  });

  test("a second, distinct event for the same purchase cannot re-credit it", async () => {
    const csId = await pendingPurchase();
    stripeReturning(csId, { payment_status: "paid", payment_intent: "pi_abc" });
    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_a", { id: csId }));
    const paidAt = purchases[0].paidAt;

    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_b", { id: csId }));
    assert.equal(purchases[0].paidAt, paidAt, "the paid timestamp was rewritten");
    assert.equal(await availablePaidSessionCredits(1), 1);
  });

  test("a consumed credit is never resurrected by a redelivered event", async () => {
    const csId = await pendingPurchase();
    stripeReturning(csId, { payment_status: "paid", payment_intent: "pi_abc" });
    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_a", { id: csId }));
    demoSessions.push({ id: 5, signupId: 1, paidSessionId: null } as unknown as DemoSession);
    assert.equal(await consumeOldestPaidCredit(1, 5), true);
    assert.equal(purchases[0].status, "consumed");

    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_c", { id: csId }));
    assert.equal(purchases[0].status, "consumed");
    assert.equal(await availablePaidSessionCredits(1), 0);
  });

  test("an unpaid checkout grants nothing", async () => {
    const csId = await pendingPurchase();
    stripeReturning(csId, { payment_status: "unpaid" });
    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_unpaid", { id: csId }));
    assert.equal(purchases[0].status, "pending");
    assert.equal(await availablePaidSessionCredits(1), 0);
  });

  // The office-billing handler runs on the same webhook delivery, so this
  // handler has to ignore everything that is not its own.
  test("office subscription events are ignored without recording anything", async () => {
    fakeStripe();
    await handleDemoPaymentEvent({
      id: "evt_sub",
      type: "customer.subscription.updated",
      data: { object: {} },
    } as unknown as Stripe.Event);
    await handleDemoPaymentEvent({
      id: "evt_other_checkout",
      type: "checkout.session.completed",
      data: { object: { id: "cs_office", metadata: { officeId: "3" } } },
    } as unknown as Stripe.Event);
    assert.equal(billingEvents.length, 0);
    assert.equal(purchases.length, 0);
  });

  // Belt and braces: the webhook payload is signed, but the authoritative
  // amount/status is re-read from Stripe, and a session that no longer claims to
  // be a demo purchase is dropped.
  test("a session that is not a demo purchase on re-read is dropped", async () => {
    const csId = await pendingPurchase();
    fakeStripe([], { [csId]: { id: csId, metadata: {}, payment_status: "paid" } });
    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_spoof", { id: csId }));
    assert.equal(purchases[0].status, "pending");
    assert.equal(billingEvents.length, 0);
  });

  test("an unknown Checkout Session is logged, not credited", async () => {
    fakeStripe([], {
      cs_ghost: { id: "cs_ghost", metadata: { kind: DEMO_PAID_SESSION_KIND }, payment_status: "paid" },
    });
    await handleDemoPaymentEvent(checkoutSessionCompleted("evt_ghost", { id: "cs_ghost" }));
    assert.equal(purchases.length, 0);
    assert.equal(billingEvents.length, 0);
  });
});

describe("credit accounting", () => {
  beforeEach(() => patchStorage());

  test("only paid credits count, not pending or consumed ones", async () => {
    paidPurchase({ status: "pending" });
    paidPurchase({ status: "consumed" });
    assert.equal(await availablePaidSessionCredits(1), 0);
    paidPurchase({ status: "paid" });
    assert.equal(await availablePaidSessionCredits(1), 1);
  });

  test("credits are scoped to one signup", async () => {
    paidPurchase({ signupId: 1 });
    paidPurchase({ signupId: 2 });
    assert.equal(await availablePaidSessionCredits(1), 1);
    assert.equal(await availablePaidSessionCredits(2), 1);
    assert.equal(await availablePaidSessionCredits(3), 0);
  });

  test("consuming spends the oldest credit first and links it to the session", async () => {
    const first = paidPurchase();
    const second = paidPurchase();
    demoSessions.push({ id: 9, signupId: 1, paidSessionId: null } as unknown as DemoSession);

    assert.equal(await consumeOldestPaidCredit(1, 9), true);
    assert.equal(purchases.find((p) => p.id === first.id)!.status, "consumed");
    assert.equal(purchases.find((p) => p.id === first.id)!.consumedByDemoSessionId, 9);
    assert.equal(purchases.find((p) => p.id === second.id)!.status, "paid");
    assert.equal(demoSessions[0].paidSessionId, first.id);
  });

  test("a pending purchase can never be spent, so voice stays locked", async () => {
    paidPurchase({ status: "pending" });
    demoSessions.push({ id: 9, signupId: 1, paidSessionId: null } as unknown as DemoSession);
    assert.equal(await consumeOldestPaidCredit(1, 9), false);
    assert.equal(demoSessions[0].paidSessionId, null);
  });

  test("one credit cannot fund two sessions", async () => {
    paidPurchase();
    demoSessions.push({ id: 9, signupId: 1, paidSessionId: null } as unknown as DemoSession);
    demoSessions.push({ id: 10, signupId: 1, paidSessionId: null } as unknown as DemoSession);
    assert.equal(await consumeOldestPaidCredit(1, 9), true);
    assert.equal(await consumeOldestPaidCredit(1, 10), false);
    assert.equal(demoSessions[1].paidSessionId, null);
  });
});

// ===========================================================================
// HTTP: buying a session and spending it
// ===========================================================================

describe("demo paid-session endpoints", () => {
  let server: Server;
  let baseUrl: string;
  let signups: DemoSignup[];
  let scenarioRows: Scenario[];

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

  after(() => server?.close());

  beforeEach(() => {
    patchStorage();
    signups = [];
    scenarioRows = [
      { id: 91, slug: "demo-v2-auto-1", vertical: "auto_sales" },
      { id: 93, slug: "demo-v2-auto-2", vertical: "auto_sales" },
      { id: 92, slug: "demo-v2-auto-3", vertical: "auto_sales" },
    ].map(
      (row) =>
        ({
          ...row,
          title: `Scenario ${row.slug}`,
          difficulty: "beginner",
          active: true,
          briefing: "b",
          description: "d",
          customerPersona: "p",
          personaCore: "core",
          gender: "female",
          track: "consulting",
          transactionType: null,
        }) as unknown as Scenario,
    );

    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    __setStripeForTests(null); // each test injects its own fake before it needs one
    __setFetchForTests(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));

    (storage as any).getScenarioBySlug = async (slug: string) => scenarioRows.find((s) => s.slug === slug);
    (storage as any).getScenario = async (id: number) => scenarioRows.find((s) => s.id === id);
    (storage as any).getDemoSignupByEmail = async (email: string) => signups.find((s) => s.email === email);
    (storage as any).updateDemoSignup = async (id: number, patch: any) => {
      const row = signups.find((x) => x.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    };
    (storage as any).createDemoSession = async (row: any) => {
      const created = { id: demoSessions.length + 1, paidSessionId: null, ...row } as DemoSession;
      demoSessions.push(created);
      return created;
    };
    (storage as any).listDemoSessionsBySignup = async (signupId: number) =>
      demoSessions.filter((s) => s.signupId === signupId).sort((a, b) => a.id - b.id);
    (storage as any).listDemoSessionsByFingerprint = async (fp: string) =>
      demoSessions.filter((s) => s.deviceFingerprint === fp);
    (storage as any).listDemoSessionsByIp = async (ip: string) =>
      demoSessions.filter((s) => s.ipAddress === ip);
  });

  afterEach(() => {
    __setFetchForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
  });

  let ipCounter = 0;
  function post(path: string, body: unknown) {
    ipCounter += 1;
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `10.50.0.${ipCounter}` },
      body: JSON.stringify(body),
    });
  }

  function verifiedSignup(email: string, sessionsUsed = 0): DemoSignup {
    const row = {
      id: signups.length + 1,
      email: normalizeEmail(email),
      code: null,
      codeExpiresAt: null,
      verified: true,
      sessionsUsed,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSentAt: null,
    } as DemoSignup;
    signups.push(row);
    return row;
  }

  describe("POST /api/demo/checkout", () => {
    test("requires a verified demo token", async () => {
      fakeStripe();
      const res = await post("/api/demo/checkout", { token: "not-a-token" });
      assert.equal(res.status, 401);
      assert.equal(purchases.length, 0);
    });

    test("returns a Checkout URL for a verified visitor", async () => {
      const calls: any[] = [];
      fakeStripe(calls);
      const signup = verifiedSignup("buyer@example.com", 1);
      const res = await post("/api/demo/checkout", { token: signDemoToken(signup.email) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.url, /^https:\/\/checkout\.stripe\.com\//);
      assert.equal(calls[0].mode, "payment");
      assert.equal(purchases.length, 1);
      assert.equal(purchases[0].signupId, signup.id);
    });

    test("degrades gracefully when Stripe is not configured", async () => {
      delete process.env.STRIPE_SECRET_KEY;
      __setStripeForTests(null);
      const signup = verifiedSignup("nostripe@example.com", 1);
      const res = await post("/api/demo/checkout", { token: signDemoToken(signup.email) });
      assert.equal(res.status, 503);
      assert.equal(purchases.length, 0);
    });
  });

  describe("POST /api/demo/session with the free allowance used", () => {
    test("is refused when there is no purchased credit", async () => {
      const signup = verifiedSignup("capped@example.com", 1);
      const res = await post("/api/demo/session", {
        token: signDemoToken(signup.email),
        industry: "auto",
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.limitReached, true);
      assert.match(body.message, /Purchase an individual session/);
      assert.ok(!body.message.includes("—"), "no em dash in the paywall message");
    });

    test("a purchased credit unlocks a session with voice, and is spent once", async () => {
      const signup = verifiedSignup("buyer@example.com", 1);
      paidPurchase({ signupId: signup.id });

      const res = await post("/api/demo/session", {
        token: signDemoToken(signup.email),
        industry: "auto",
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.voiceEnabled, true);
      assert.equal(purchases[0].status, "consumed");
      assert.equal(purchases[0].consumedByDemoSessionId, body.session.id);
      // sessionsUsed counts the FREE allowance only, so a purchase must not move it.
      assert.equal(signup.sessionsUsed, 1);
      assert.equal(await availablePaidSessionCredits(signup.id), 0);

      // The credit is gone, so the next attempt is back behind the paywall.
      const again = await post("/api/demo/session", {
        token: signDemoToken(signup.email),
        industry: "auto",
      });
      assert.equal(again.status, 403);
    });

    test("a pending (unpaid) purchase does not unlock anything", async () => {
      const signup = verifiedSignup("pending@example.com", 1);
      paidPurchase({ signupId: signup.id, status: "pending" });
      const res = await post("/api/demo/session", {
        token: signDemoToken(signup.email),
        industry: "auto",
      });
      assert.equal(res.status, 403);
      assert.equal(purchases[0].status, "pending");
    });
  });

  test("the free session still gets no voice", async () => {
    const signup = verifiedSignup("free@example.com", 0);
    const res = await post("/api/demo/session", {
      token: signDemoToken(signup.email),
      industry: "auto",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.voiceEnabled, false);
    assert.ok(!demoSessions[0].paidSessionId, "the free session must not be linked to a credit");
    assert.equal(signup.sessionsUsed, 1);
  });
});
