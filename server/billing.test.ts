import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";

import { storage } from "./storage";
import { __setStripeForTests } from "./stripe";
import {
  officeIsActive,
  syncOfficeFromSubscription,
  setSeatQuantity,
  addDashboard,
  removeDashboard,
  handleStripeEvent,
  EnterpriseQuoteRequiredError,
  createEvaluationCheckoutSession,
  createEvaluationConversionCheckoutSession,
  evaluationHasAccess,
  expireEvaluations,
} from "./billing";
import type { Office, BillingEvent, EvaluationPurchase } from "@shared/schema";

// billing.ts (via stripe.ts) reads the per-tier price ids from env at module load.
// The npm test script sets them; these fallbacks keep the file runnable directly.
process.env.STRIPE_SEAT_TEAM_PRICE_ID ??= "price_seat_team";
process.env.STRIPE_SEAT_OFFICE_PRICE_ID ??= "price_seat_office";
process.env.STRIPE_SEAT_COMPANY_PRICE_ID ??= "price_seat_company";
process.env.STRIPE_DASHBOARD_TEAM_PRICE_ID ??= "price_dash_team";
process.env.STRIPE_DASHBOARD_OFFICE_PRICE_ID ??= "price_dash_office";
process.env.STRIPE_DASHBOARD_COMPANY_PRICE_ID ??= "price_dash_company";

const SEAT_TEAM = process.env.STRIPE_SEAT_TEAM_PRICE_ID;
const SEAT_OFFICE = process.env.STRIPE_SEAT_OFFICE_PRICE_ID;
const DASH_TEAM = process.env.STRIPE_DASHBOARD_TEAM_PRICE_ID;
const DASH_OFFICE = process.env.STRIPE_DASHBOARD_OFFICE_PRICE_ID;

// --- In-memory storage patch (no database needed) ---
let offices: Map<number, Office>;
let billingEvents: BillingEvent[];

function makeOffice(overrides: Partial<Office> = {}): Office {
  return {
    id: 1,
    name: "Acme",
    inviteCode: "ACME1234",
    createdAt: new Date().toISOString(),
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    subscriptionStatus: "incomplete",
    managerItemId: null,
    seatItemId: null,
    activeSeatCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  offices = new Map();
  billingEvents = [];

  (storage as any).getOffice = async (id: number) => offices.get(id);
  (storage as any).getOfficeByStripeCustomerId = async (c: string) =>
    [...offices.values()].find((o) => o.stripeCustomerId === c);
  (storage as any).getOfficeByStripeSubscriptionId = async (s: string) =>
    [...offices.values()].find((o) => o.stripeSubscriptionId === s);
  (storage as any).updateOffice = async (id: number, patch: Partial<Office>) => {
    const o = offices.get(id);
    if (!o) return undefined;
    const next = { ...o, ...patch };
    offices.set(id, next);
    return next;
  };
  (storage as any).getBillingEventByStripeId = async (eid: string) =>
    billingEvents.find((e) => e.stripeEventId === eid);
  (storage as any).recordBillingEvent = async (e: any) => {
    if (billingEvents.some((x) => x.stripeEventId === e.stripeEventId)) {
      throw new Error("duplicate stripeEventId"); // mirrors the DB unique constraint
    }
    const row = { id: billingEvents.length + 1, ...e };
    billingEvents.push(row);
    return row;
  };
});

// A minimal fake Stripe covering only what billing.ts calls. Update/create calls
// record BOTH price and quantity so tests can assert the flat-per-tier reprice.
function fakeStripe(subscription: any, calls: any[] = []): void {
  const fake = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push(["subscriptions.retrieve", id]);
        return subscription;
      },
    },
    subscriptionItems: {
      update: async (id: string, params: any) => {
        calls.push(["subscriptionItems.update", id, params.price, params.quantity]);
        return { id };
      },
      create: async (params: any) => {
        calls.push(["subscriptionItems.create", params.price, params.quantity]);
        return { id: "si_new" };
      },
      del: async (id: string) => {
        calls.push(["subscriptionItems.del", id]);
        return { id, deleted: true };
      },
    },
  };
  __setStripeForTests(fake);
}

function subscriptionWith(status: string, seatQty: number | null): any {
  const items = [
    { id: "si_manager", price: { id: DASH_TEAM }, quantity: 1 },
  ];
  if (seatQty !== null) {
    items.push({ id: "si_seat", price: { id: SEAT_TEAM }, quantity: seatQty });
  }
  return { id: "sub_1", status, customer: "cus_1", items: { data: items }, metadata: { officeId: "1" } };
}

describe("officeIsActive", () => {
  test("active and trialing are active; others are not", () => {
    assert.equal(officeIsActive({ subscriptionStatus: "active" }), true);
    assert.equal(officeIsActive({ subscriptionStatus: "trialing" }), true);
    for (const s of ["incomplete", "past_due", "canceled", "unpaid"]) {
      assert.equal(officeIsActive({ subscriptionStatus: s }), false);
    }
  });
});

describe("syncOfficeFromSubscription", () => {
  test("maps manager + seat items and seat count", async () => {
    offices.set(1, makeOffice());
    await syncOfficeFromSubscription(offices.get(1)!, subscriptionWith("active", 7));
    const o = offices.get(1)!;
    assert.equal(o.subscriptionStatus, "active");
    assert.equal(o.managerItemId, "si_manager");
    assert.equal(o.seatItemId, "si_seat");
    assert.equal(o.activeSeatCount, 7);
  });

  test("classifies a seat priced at ANY tier (Office) as the seat line", async () => {
    offices.set(1, makeOffice());
    const sub = {
      id: "sub_1",
      status: "active",
      customer: "cus_1",
      items: { data: [{ id: "si_seat", price: { id: SEAT_OFFICE }, quantity: 12 }] },
      metadata: { officeId: "1" },
    };
    await syncOfficeFromSubscription(offices.get(1)!, sub as any);
    const o = offices.get(1)!;
    assert.equal(o.seatItemId, "si_seat");
    assert.equal(o.activeSeatCount, 12);
  });

  test("a seats-only subscription (no dashboard line) leaves managerItemId unset", async () => {
    offices.set(1, makeOffice());
    const sub = {
      id: "sub_1",
      status: "active",
      customer: "cus_1",
      items: { data: [{ id: "si_seat", price: { id: SEAT_TEAM }, quantity: 4 }] },
      metadata: { officeId: "1" },
    };
    await syncOfficeFromSubscription(offices.get(1)!, sub as any);
    const o = offices.get(1)!;
    assert.equal(o.seatItemId, "si_seat");
    assert.equal(o.activeSeatCount, 4);
    assert.equal(o.managerItemId, null, "no dashboard add-on → managerItemId stays null");
  });
});

describe("setSeatQuantity", () => {
  test("updates existing seat item at the Team-tier price for 4 seats", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    const office = makeOffice({ seatItemId: "si_seat" });
    const id = await setSeatQuantity(office, 4);
    assert.equal(id, "si_seat");
    assert.deepEqual(calls[0], ["subscriptionItems.update", "si_seat", SEAT_TEAM, 4]);
  });

  test("creates seat item on first seat at the Team-tier price and persists id", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    offices.set(1, makeOffice({ seatItemId: null }));
    const id = await setSeatQuantity(offices.get(1)!, 1);
    assert.equal(id, "si_new");
    assert.deepEqual(calls[0], ["subscriptionItems.create", SEAT_TEAM, 1]);
    assert.equal(offices.get(1)!.seatItemId, "si_new");
  });

  test("crossing 5→6 seats re-prices the WHOLE seat line to the Office-tier rate", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    // Office was in the Team tier (seat item already priced at Team). Growing to 6
    // seats moves it to Office; the entire seat line must switch to the Office price.
    const office = makeOffice({ seatItemId: "si_seat" });
    await setSeatQuantity(office, 6);
    assert.deepEqual(calls[0], ["subscriptionItems.update", "si_seat", SEAT_OFFICE, 6]);
  });

  test("an office can run seats-only: no dashboard line is touched when the add-on is inactive", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    // managerItemId is null (no dashboard add-on) — only the seat line changes.
    const office = makeOffice({ seatItemId: "si_seat", managerItemId: null });
    await setSeatQuantity(office, 3);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["subscriptionItems.update", "si_seat", SEAT_TEAM, 3]);
  });

  test("dashboard re-tiers when a seat change moves the office into a new tier", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    // Dashboard add-on is active (managerItemId set). Growing to 6 seats (Office
    // tier) must also re-price the dashboard line to the Office dashboard rate.
    const office = makeOffice({ seatItemId: "si_seat", managerItemId: "si_manager" });
    await setSeatQuantity(office, 6);
    assert.deepEqual(calls[0], ["subscriptionItems.update", "si_seat", SEAT_OFFICE, 6]);
    assert.deepEqual(calls[1], ["subscriptionItems.update", "si_manager", DASH_OFFICE, 1]);
  });

  test("reaching 36+ seats is Enterprise and is rejected (route to a custom quote)", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    const office = makeOffice({ seatItemId: "si_seat" });
    await assert.rejects(() => setSeatQuantity(office, 36), EnterpriseQuoteRequiredError);
    assert.equal(calls.length, 0, "no Stripe calls should be made for Enterprise");
  });
});

describe("optional dashboard add-on", () => {
  test("addDashboard adds ONLY a dashboard line (no seat granted — manager buys a seat separately)", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    offices.set(1, makeOffice({ managerItemId: null, seatItemId: null, activeSeatCount: 0 }));
    const id = await addDashboard(offices.get(1)!);
    assert.equal(id, "si_new");
    // Exactly one create call, for the dashboard at the Team-tier rate. No seat line.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["subscriptionItems.create", DASH_TEAM, 1]);
    assert.equal(offices.get(1)!.managerItemId, "si_new");
    assert.equal(offices.get(1)!.seatItemId, null, "dashboard must not create a seat");
  });

  test("removeDashboard drops the dashboard line so the office runs seats-only", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    offices.set(1, makeOffice({ managerItemId: "si_manager", seatItemId: "si_seat", activeSeatCount: 3 }));
    await removeDashboard(offices.get(1)!);
    assert.deepEqual(calls[0], ["subscriptionItems.del", "si_manager"]);
    assert.equal(offices.get(1)!.managerItemId, null);
    assert.equal(offices.get(1)!.seatItemId, "si_seat", "seat line is untouched");
  });

  // The dashboard "state" the manager UI branches on is purely office.managerItemId:
  // set => dashboard is ACTIVE (full analytics, never an "add-on not active" error);
  // unset => not purchased, so the UI shows the friendly upsell. addDashboard /
  // removeDashboard are the only transitions, and the price billed must match the
  // tier's dashboard sell line shown in that upsell.
  test("dashboard state flips purchased<->not, and the tier price billed matches the upsell price", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    // Office tier (6-20 seats): the upsell shows $389/mo, billed at the Office dashboard price.
    offices.set(1, makeOffice({ managerItemId: null, seatItemId: "si_seat", activeSeatCount: 10 }));

    const dashboardActive = (o: Office) => !!o.managerItemId;
    assert.equal(dashboardActive(offices.get(1)!), false, "starts not purchased -> upsell state");

    await addDashboard(offices.get(1)!);
    assert.equal(dashboardActive(offices.get(1)!), true, "purchased -> dashboard active state");
    assert.deepEqual(calls[0], ["subscriptionItems.create", DASH_OFFICE, 1], "billed at the Office-tier dashboard price");

    await removeDashboard(offices.get(1)!);
    assert.equal(dashboardActive(offices.get(1)!), false, "removed -> back to upsell state");
  });
});

describe("handleStripeEvent", () => {
  test("checkout.session.completed activates the office", async () => {
    offices.set(1, makeOffice({ subscriptionStatus: "incomplete" }));
    fakeStripe(subscriptionWith("active", null));
    await handleStripeEvent({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "1", customer: "cus_1", subscription: "sub_1" } },
    } as any);
    assert.equal(offices.get(1)!.subscriptionStatus, "active");
    assert.equal(billingEvents.length, 1);
  });

  test("invoice.payment_failed locks the office immediately (past_due)", async () => {
    offices.set(1, makeOffice({ subscriptionStatus: "active" }));
    fakeStripe(subscriptionWith("past_due", 3));
    await handleStripeEvent({
      id: "evt_2",
      type: "invoice.payment_failed",
      data: { object: { subscription: "sub_1", customer: "cus_1" } },
    } as any);
    assert.equal(offices.get(1)!.subscriptionStatus, "past_due");
  });

  test("invoice.paid restores active by re-fetching the subscription", async () => {
    offices.set(1, makeOffice({ subscriptionStatus: "past_due" }));
    fakeStripe(subscriptionWith("active", 3));
    await handleStripeEvent({
      id: "evt_3",
      type: "invoice.paid",
      data: { object: { subscription: "sub_1", customer: "cus_1" } },
    } as any);
    assert.equal(offices.get(1)!.subscriptionStatus, "active");
    assert.equal(offices.get(1)!.activeSeatCount, 3);
  });

  test("is idempotent: a redelivered event id is a no-op", async () => {
    offices.set(1, makeOffice({ subscriptionStatus: "active" }));
    fakeStripe(subscriptionWith("active", 1));
    const evt = {
      id: "evt_dup",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_1", metadata: { officeId: "1" }, status: "active", items: { data: [] } } },
    } as any;
    await handleStripeEvent(evt);
    await handleStripeEvent(evt); // second delivery
    assert.equal(billingEvents.length, 1, "event should only be recorded once");
  });
});

describe("webhook signature verification", () => {
  test("constructEvent accepts a correctly signed raw body and rejects tampering", () => {
    const stripe = new Stripe("sk_test_dummy", { apiVersion: "2025-02-24.acacia" });
    const secret = "whsec_testsecret";
    const payload = JSON.stringify({ id: "evt_sig", type: "invoice.paid", data: { object: {} } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });

    const event = stripe.webhooks.constructEvent(Buffer.from(payload), header, secret);
    assert.equal(event.id, "evt_sig");

    assert.throws(() =>
      stripe.webhooks.constructEvent(Buffer.from(payload + "tamper"), header, secret),
    );
  });
});


// Evaluation checkout is intentionally separate from a recurring seat subscription:
// one paid checkout opens a 14-day window, and conversion applies the stored credit
// only when the buyer retains evaluated participants and the first invoice can absorb the credit.
describe("14-Day Team Evaluation billing", () => {
  test("creates the hidden 1-2 participant checkout with server-authored $175 price data", async () => {
    let customerParams: any;
    let sessionParams: any;
    __setStripeForTests({
      customers: {
        create: async (params: any) => {
          customerParams = params;
          return { id: "cus_eval" };
        },
      },
      checkout: {
        sessions: {
          create: async (params: any) => {
            sessionParams = params;
            return { id: "cs_eval", url: "https://checkout.stripe.test/evaluation" };
          },
        },
      },
    } as any);

    const url = await createEvaluationCheckoutSession({
      officeName: "Acme Practice Group",
      participantCount: 2,
      email: "owner@example.com",
      signupId: 42,
    });

    assert.equal(url, "https://checkout.stripe.test/evaluation");
    assert.equal(customerParams.email, "owner@example.com");
    assert.equal(sessionParams.mode, "payment");
    assert.deepEqual(sessionParams.line_items, [{
      price_data: {
        currency: "usd",
        product_data: { name: "14-Day Team Evaluation" },
        unit_amount: 17_500,
      },
      quantity: 1,
    }]);
    assert.equal(sessionParams.metadata.participantCount, "2");
    assert.equal(sessionParams.metadata.expectedTotalAmountCents, "17500");
  });

  test("conversion requires at least as many paid seats as evaluation participants", async () => {
    const purchase = {
      id: 8,
      officeId: 1,
      participantCount: 6,
      totalAmountCents: 29_900,
      conversionStatus: "not_converted",
      evaluationEndsAt: new Date(Date.now() + 60_000).toISOString(),
    };
    (storage as any).getEvaluationPurchase = async () => purchase;
    let couponCalled = false;
    __setStripeForTests({ coupons: { create: async () => { couponCalled = true; return { id: "coupon_eval" }; } } } as any);

    await assert.rejects(
      () => createEvaluationConversionCheckoutSession(8, 5),
      /retains your evaluated participants/,
    );
    assert.equal(couponCalled, false, "conversion is rejected before any Stripe side effect");
  });

  test("conversion applies the recorded evaluation credit to a subscription checkout", async () => {
    const purchase = {
      id: 8,
      officeId: 1,
      participantCount: 6,
      totalAmountCents: 29_900,
      conversionStatus: "not_converted",
      evaluationEndsAt: new Date(Date.now() + 60_000).toISOString(),
    };
    offices.set(1, makeOffice({ stripeCustomerId: "cus_eval" }));
    (storage as any).getEvaluationPurchase = async () => purchase;
    let couponParams: any;
    let sessionParams: any;
    __setStripeForTests({
      coupons: { create: async (params: any) => { couponParams = params; return { id: "coupon_eval" }; } },
      checkout: { sessions: { create: async (params: any) => { sessionParams = params; return { url: "https://checkout.stripe.test/convert" }; } } },
    } as any);

    const url = await createEvaluationConversionCheckoutSession(8, 6);
    assert.equal(url, "https://checkout.stripe.test/convert");
    assert.equal(couponParams.amount_off, 29_900);
    assert.equal(sessionParams.mode, "subscription");
    assert.deepEqual(sessionParams.line_items, [{ price: SEAT_OFFICE, quantity: 6 }]);
    assert.deepEqual(sessionParams.discounts, [{ coupon: "coupon_eval" }]);
    assert.equal(sessionParams.metadata.conversionEvaluationPurchaseId, "8");
  });

  test("evaluation access requires the current purchase and an unexpired participant record", () => {
    const office = { evaluationStatus: "active", currentEvaluationPurchaseId: 8 } as Office;
    const activeUser = { evaluationPurchaseId: 8, evaluationAccessExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    assert.equal(evaluationHasAccess(office, activeUser), true);
    assert.equal(evaluationHasAccess(office, { ...activeUser, evaluationPurchaseId: 9 }), false);
    assert.equal(evaluationHasAccess(office, { ...activeUser, evaluationAccessExpiresAt: new Date(Date.now() - 1).toISOString() }), false);
  });

  // This is the test that actually simulates time passing rather than just
  // exercising the pure gate function above. It seeds real evaluationPurchase
  // rows with evaluationEndsAt timestamps in the past and future, runs the
  // exact sweep the scheduler calls on a timer, and asserts on the resulting
  // storage/office state -- proving expireEvaluations() genuinely revokes
  // access on its own instead of only being reachable in theory.
  test("expireEvaluations revokes Command Center access once evaluationEndsAt is in the past, and leaves active/converted evaluations untouched", async () => {
    const now = new Date("2026-06-15T12:00:00.000Z");

    offices.set(1, makeOffice({ id: 1, evaluationStatus: "active", commandCenterEntitled: true, currentEvaluationPurchaseId: 101 } as Partial<Office>));
    offices.set(2, makeOffice({ id: 2, evaluationStatus: "active", commandCenterEntitled: true, currentEvaluationPurchaseId: 102 } as Partial<Office>));
    offices.set(3, makeOffice({ id: 3, evaluationStatus: "converted", commandCenterEntitled: true, currentEvaluationPurchaseId: 103 } as Partial<Office>));

    const purchases = new Map<number, EvaluationPurchase>();
    const makePurchase = (overrides: Partial<EvaluationPurchase>): EvaluationPurchase => ({
      id: 0,
      officeId: 0,
      stripeCustomerId: "cus_eval",
      stripeCheckoutSessionId: "cs_eval",
      stripePaymentIntentId: null,
      baseAmountCents: 24_900,
      additionalParticipantAmountCents: 0,
      totalAmountCents: 24_900,
      participantCount: 5,
      evaluationStartedAt: "2026-06-01T00:00:00.000Z",
      evaluationEndsAt: "2026-06-15T00:00:00.000Z",
      conversionStatus: "not_converted",
      convertedAt: null,
      convertedStripeSubscriptionId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      ...overrides,
    });

    // Office 1: evaluation ended 12 hours before "now" and was never converted.
    // This is the one the sweep must catch and expire.
    purchases.set(101, makePurchase({
      id: 101,
      officeId: 1,
      evaluationEndsAt: "2026-06-15T00:00:00.000Z",
      conversionStatus: "not_converted",
    }));
    // Office 2: evaluation does not end until 12 hours AFTER "now". Must be
    // left completely untouched by this tick.
    purchases.set(102, makePurchase({
      id: 102,
      officeId: 2,
      evaluationEndsAt: "2026-06-16T00:00:00.000Z",
      conversionStatus: "not_converted",
    }));
    // Office 3: evaluation window is in the past AND it already converted to
    // a paid subscription. Must never be marked expired -- conversion status
    // is a one-way transition into "converted", not something the sweep
    // should ever overwrite.
    purchases.set(103, makePurchase({
      id: 103,
      officeId: 3,
      evaluationEndsAt: "2026-06-10T00:00:00.000Z",
      conversionStatus: "converted",
    }));

    (storage as any).listExpiredUnconvertedEvaluations = async (nowIso: string) =>
      [...purchases.values()].filter((p) => p.evaluationEndsAt <= nowIso && p.conversionStatus === "not_converted");
    (storage as any).markEvaluationExpired = async (id: number, nowIso: string) => {
      const p = purchases.get(id);
      if (p) purchases.set(id, { ...p, conversionStatus: "expired_unconverted", updatedAt: nowIso });
    };

    const expiredCount = await expireEvaluations(now);

    assert.equal(expiredCount, 1, "exactly one evaluation (office 1) should have crossed evaluationEndsAt unconverted");

    // Office 1: access revoked, status flipped.
    assert.equal(offices.get(1)!.commandCenterEntitled, false);
    assert.equal(offices.get(1)!.evaluationStatus, "expired_unconverted");
    assert.equal(purchases.get(101)!.conversionStatus, "expired_unconverted");

    // Office 2: still within its window, must be completely untouched.
    assert.equal(offices.get(2)!.commandCenterEntitled, true);
    assert.equal(offices.get(2)!.evaluationStatus, "active");
    assert.equal(purchases.get(102)!.conversionStatus, "not_converted");

    // Office 3: already converted, must be completely untouched even though
    // its evaluationEndsAt is also in the past.
    assert.equal(offices.get(3)!.commandCenterEntitled, true);
    assert.equal(offices.get(3)!.evaluationStatus, "converted");
    assert.equal(purchases.get(103)!.conversionStatus, "converted");

    // Running the sweep again at the same "now" must be a no-op (idempotent):
    // office 1 is no longer "not_converted", so it must not be re-processed.
    const secondRunCount = await expireEvaluations(now);
    assert.equal(secondRunCount, 0, "a second sweep at the same time must find nothing left to expire");
  });
});
