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
  createSelfServeCheckoutSession,
  EnterpriseQuoteRequiredError,
} from "./billing";
import type { Office, BillingEvent } from "@shared/schema";

// billing.ts (via stripe.ts) reads the per-tier price ids from env at module load.
// The npm test script sets them; these fallbacks keep the file runnable directly.
process.env.STRIPE_SEAT_TEAM_PRICE_ID ??= "price_seat_team";
process.env.STRIPE_SEAT_OFFICE_PRICE_ID ??= "price_seat_office";
process.env.STRIPE_SEAT_COMPANY_PRICE_ID ??= "price_seat_company";
process.env.STRIPE_DASHBOARD_TEAM_PRICE_ID ??= "price_dash_team";
process.env.STRIPE_DASHBOARD_OFFICE_PRICE_ID ??= "price_dash_office";
process.env.STRIPE_DASHBOARD_COMPANY_PRICE_ID ??= "price_dash_company";
// The annual-prepay dashboard coupon. Set by the npm test script BEFORE any module
// loads so stripe.ts captures it and isAnnualDashboardDiscountConfigured() is true;
// the ??= keeps the const defined for direct runs (assertions below reference it).
process.env.STRIPE_DASHBOARD_ANNUAL_COUPON_ID ??= "coupon_dash_annual";

const SEAT_TEAM = process.env.STRIPE_SEAT_TEAM_PRICE_ID;
const SEAT_OFFICE = process.env.STRIPE_SEAT_OFFICE_PRICE_ID;
const DASH_TEAM = process.env.STRIPE_DASHBOARD_TEAM_PRICE_ID;
const DASH_OFFICE = process.env.STRIPE_DASHBOARD_OFFICE_PRICE_ID;
const DASH_COMPANY = process.env.STRIPE_DASHBOARD_COMPANY_PRICE_ID;
const SEAT_COMPANY = process.env.STRIPE_SEAT_COMPANY_PRICE_ID;
const ANNUAL_COUPON = process.env.STRIPE_DASHBOARD_ANNUAL_COUPON_ID;

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

// A fake Stripe that captures the checkout.sessions.create params so we can assert
// exactly what line items and discounts a self-serve checkout would send to Stripe.
function fakeCheckoutStripe(): { params: any } {
  const captured: { params: any } = { params: null };
  const fake = {
    checkout: {
      sessions: {
        create: async (params: any) => {
          captured.params = params;
          return { url: "https://checkout.stripe.test/session" };
        },
      },
    },
  };
  __setStripeForTests(fake);
  return captured;
}

// Pull the single seat / dashboard line items out of a captured line_items array by
// matching against the known per-tier price ids.
function seatLine(params: any) {
  return params.line_items.find((li: any) => [SEAT_TEAM, SEAT_OFFICE, SEAT_COMPANY].includes(li.price));
}
function dashboardLine(params: any) {
  return params.line_items.find((li: any) => [DASH_TEAM, DASH_OFFICE, DASH_COMPANY].includes(li.price));
}

describe("createSelfServeCheckoutSession — annual-prepay dashboard discount", () => {
  test("annual + dashboard: attaches the dashboard coupon; seat line is unchanged and never discounted", async () => {
    const captured = fakeCheckoutStripe();
    await createSelfServeCheckoutSession({
      officeName: "Acme",
      seatCount: 3, // Team tier
      includeDashboard: true,
      annual: true,
    });
    const p = captured.params;

    // The 20%-off-dashboard coupon rides at the session level. It is scoped in Stripe
    // to the dashboard product, so it can only ever reduce the dashboard line.
    assert.deepEqual(p.discounts, [{ coupon: ANNUAL_COUPON }]);

    // Seat line: exact per-seat monthly price + quantity, and crucially NO per-item
    // discount/coupon of any kind — annual prepay must never touch seats.
    const seat = seatLine(p);
    assert.equal(seat.price, SEAT_TEAM);
    assert.equal(seat.quantity, 3);
    assert.equal(seat.discounts, undefined, "seat line must carry no discount");
    assert.equal(seat.coupon, undefined, "seat line must carry no coupon");

    // Dashboard line is still billed at the normal monthly tier price (qty 1); the
    // discount is applied by the coupon, never by swapping the price object.
    const dash = dashboardLine(p);
    assert.equal(dash.price, DASH_TEAM);
    assert.equal(dash.quantity, 1);
  });

  test("monthly (annual=false) + dashboard: no discount is attached", async () => {
    const captured = fakeCheckoutStripe();
    await createSelfServeCheckoutSession({
      officeName: "Acme",
      seatCount: 3,
      includeDashboard: true,
      annual: false,
    });
    const p = captured.params;
    assert.equal(p.discounts, undefined, "monthly checkout must not attach any discount");
    assert.equal(seatLine(p).price, SEAT_TEAM);
    assert.equal(dashboardLine(p).price, DASH_TEAM);
  });

  test("annual selected WITHOUT the dashboard: no discount (the coupon only makes sense with a dashboard line)", async () => {
    const captured = fakeCheckoutStripe();
    await createSelfServeCheckoutSession({
      officeName: "Acme",
      seatCount: 4,
      includeDashboard: false,
      annual: true,
    });
    const p = captured.params;
    assert.equal(p.discounts, undefined, "no dashboard line → no dashboard discount");
    assert.equal(dashboardLine(p), undefined, "no dashboard line item at all");
    assert.equal(seatLine(p).quantity, 4);
  });

  test("annual applies at any tier: Company (30 seats) discounts the dashboard, seats stay on the Company per-seat rate", async () => {
    const captured = fakeCheckoutStripe();
    await createSelfServeCheckoutSession({
      officeName: "BigCo",
      seatCount: 30, // Company tier
      includeDashboard: true,
      annual: true,
    });
    const p = captured.params;
    assert.deepEqual(p.discounts, [{ coupon: ANNUAL_COUPON }]);
    const seat = seatLine(p);
    assert.equal(seat.price, SEAT_COMPANY);
    assert.equal(seat.quantity, 30);
    assert.equal(seat.discounts, undefined);
    assert.equal(dashboardLine(p).price, DASH_COMPANY);
  });

  test("annual flag defaults off: omitting it behaves exactly like a monthly checkout", async () => {
    const captured = fakeCheckoutStripe();
    await createSelfServeCheckoutSession({
      officeName: "Acme",
      seatCount: 2,
      includeDashboard: true,
    });
    assert.equal(captured.params.discounts, undefined);
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
