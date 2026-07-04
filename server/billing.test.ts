import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";

import { storage } from "./storage";
import { __setStripeForTests } from "./stripe";
import {
  officeIsActive,
  syncOfficeFromSubscription,
  setSeatQuantity,
  handleStripeEvent,
} from "./billing";
import type { Office, BillingEvent } from "@shared/schema";

// These tests use hardcoded price ids; billing.ts reads them from env at module
// load, so we set them before anything else runs.
process.env.STRIPE_MANAGER_DASHBOARD_PRICE_ID ??= "price_manager";
process.env.STRIPE_CONSULTANT_SEAT_PRICE_ID ??= "price_seat";
const MANAGER_PRICE = process.env.STRIPE_MANAGER_DASHBOARD_PRICE_ID;
const SEAT_PRICE = process.env.STRIPE_CONSULTANT_SEAT_PRICE_ID;

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

// A minimal fake Stripe covering only what billing.ts calls.
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
        calls.push(["subscriptionItems.update", id, params.quantity]);
        return { id };
      },
      create: async (params: any) => {
        calls.push(["subscriptionItems.create", params.price, params.quantity]);
        return { id: "si_new" };
      },
    },
  };
  __setStripeForTests(fake);
}

function subscriptionWith(status: string, seatQty: number | null): any {
  const items = [
    { id: "si_manager", price: { id: MANAGER_PRICE }, quantity: 1 },
  ];
  if (seatQty !== null) {
    items.push({ id: "si_seat", price: { id: SEAT_PRICE }, quantity: seatQty });
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
});

describe("setSeatQuantity", () => {
  test("updates existing seat item quantity", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    const office = makeOffice({ seatItemId: "si_seat" });
    const id = await setSeatQuantity(office, 4);
    assert.equal(id, "si_seat");
    assert.deepEqual(calls[0], ["subscriptionItems.update", "si_seat", 4]);
  });

  test("creates seat item on first seat and persists id", async () => {
    const calls: any[] = [];
    fakeStripe(null, calls);
    offices.set(1, makeOffice({ seatItemId: null }));
    const id = await setSeatQuantity(offices.get(1)!, 1);
    assert.equal(id, "si_new");
    assert.deepEqual(calls[0], ["subscriptionItems.create", SEAT_PRICE, 1]);
    assert.equal(offices.get(1)!.seatItemId, "si_new");
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
