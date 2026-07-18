import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { storage } from "./storage";
import { __setStripeForTests } from "./stripe";
import {
  createSelfServeCheckoutSession,
  provisionSelfServeOffice,
  handleStripeEvent,
  EnterpriseQuoteRequiredError,
} from "./billing";
import {
  planForSeatCount,
  isEnterpriseSeatCount,
  PLAN_TIERS,
} from "@shared/pricing";
import { computeSalesRow } from "./admin";
import { buildWelcomeEmailBody } from "./opportunities";
import type { Office, OfficeSetupToken, PaidOfficeSignup } from "@shared/schema";

// Same env fallbacks as billing.test.ts so the file is runnable directly.
process.env.STRIPE_SEAT_TEAM_PRICE_ID ??= "price_seat_team";
process.env.STRIPE_SEAT_OFFICE_PRICE_ID ??= "price_seat_office";
process.env.STRIPE_SEAT_COMPANY_PRICE_ID ??= "price_seat_company";
process.env.STRIPE_DASHBOARD_TEAM_PRICE_ID ??= "price_dash_team";
process.env.STRIPE_DASHBOARD_OFFICE_PRICE_ID ??= "price_dash_office";
process.env.STRIPE_DASHBOARD_COMPANY_PRICE_ID ??= "price_dash_company";

const SEAT_TEAM = process.env.STRIPE_SEAT_TEAM_PRICE_ID;
const SEAT_OFFICE = process.env.STRIPE_SEAT_OFFICE_PRICE_ID;
const SEAT_COMPANY = process.env.STRIPE_SEAT_COMPANY_PRICE_ID;
const DASH_TEAM = process.env.STRIPE_DASHBOARD_TEAM_PRICE_ID;

describe("shared/pricing tiers", () => {
  test("seat counts map to the right tier and rate", () => {
    assert.equal(planForSeatCount(1)?.tier, "team");
    assert.equal(planForSeatCount(5)?.tier, "team");
    assert.equal(planForSeatCount(5)?.seatRate, 49);
    assert.equal(planForSeatCount(6)?.tier, "office");
    assert.equal(planForSeatCount(20)?.tier, "office");
    assert.equal(planForSeatCount(20)?.seatRate, 45);
    assert.equal(planForSeatCount(21)?.tier, "company");
    assert.equal(planForSeatCount(35)?.tier, "company");
    assert.equal(planForSeatCount(35)?.seatRate, 41);
  });

  test("dashboard rates match the tier sell lines", () => {
    assert.equal(planForSeatCount(3)?.dashboardRate, 249);
    assert.equal(planForSeatCount(10)?.dashboardRate, 389);
    assert.equal(planForSeatCount(30)?.dashboardRate, 529);
  });

  test("36+ seats is Enterprise (no self-serve plan)", () => {
    assert.equal(isEnterpriseSeatCount(35), false);
    assert.equal(isEnterpriseSeatCount(36), true);
    assert.equal(planForSeatCount(36), null);
    assert.equal(planForSeatCount(100), null);
  });

  test("PLAN_TIERS is contiguous from 1 to 35", () => {
    assert.equal(PLAN_TIERS[0].minSeats, 1);
    assert.equal(PLAN_TIERS[PLAN_TIERS.length - 1].maxSeats, 35);
  });
});

describe("createSelfServeCheckoutSession", () => {
  let created: any[];

  beforeEach(() => {
    created = [];
    __setStripeForTests({
      checkout: {
        sessions: {
          create: async (params: any) => {
            created.push(params);
            return { url: "https://checkout.stripe.test/session" };
          },
        },
      },
    });
  });

  test("Team-tier: one seat line at the Team price, quantity = seat count, no dashboard", async () => {
    const url = await createSelfServeCheckoutSession({
      officeName: "Acme",
      seatCount: 4,
      includeDashboard: false,
    });
    assert.equal(url, "https://checkout.stripe.test/session");
    const params = created[0];
    assert.equal(params.mode, "subscription");
    assert.deepEqual(params.line_items, [{ price: SEAT_TEAM, quantity: 4 }]);
    assert.equal(params.metadata.selfServe, "true");
    assert.equal(params.metadata.officeName, "Acme");
    assert.equal(params.metadata.seatCount, "4");
    assert.equal(params.metadata.dashboard, "false");
    // Same provisioning metadata must ride on the subscription too.
    assert.deepEqual(params.subscription_data.metadata, params.metadata);
  });

  test("Office-tier with dashboard: seat line at Office price + one dashboard line", async () => {
    await createSelfServeCheckoutSession({
      officeName: "Bigco",
      seatCount: 10,
      includeDashboard: true,
      email: "buyer@example.com",
    });
    const params = created[0];
    assert.equal(params.line_items.length, 2);
    assert.deepEqual(params.line_items[0], { price: SEAT_OFFICE, quantity: 10 });
    assert.equal(params.line_items[1].quantity, 1);
    assert.equal(params.metadata.dashboard, "true");
    assert.equal(params.metadata.email, "buyer@example.com");
    assert.equal(params.customer_email, "buyer@example.com");
  });

  test("Company-tier seat price for 21+ seats", async () => {
    await createSelfServeCheckoutSession({
      officeName: "Enterpriseish",
      seatCount: 25,
      includeDashboard: false,
    });
    assert.deepEqual(created[0].line_items[0], { price: SEAT_COMPANY, quantity: 25 });
  });

  test("36+ seats is rejected (Enterprise custom quote) with no Stripe call", async () => {
    await assert.rejects(
      () =>
        createSelfServeCheckoutSession({
          officeName: "Huge",
          seatCount: 36,
          includeDashboard: false,
        }),
      EnterpriseQuoteRequiredError,
    );
    assert.equal(created.length, 0);
  });
});

// --- provisionSelfServeOffice ------------------------------------------------
let offices: Map<number, Office>;
let nextOfficeId: number;
let signups: PaidOfficeSignup[];
let tokens: Map<string, OfficeSetupToken>;

function fakeSubscription(overrides: any = {}): any {
  return {
    id: "sub_ss_1",
    status: "active",
    customer: "cus_ss_1",
    items: { data: [{ id: "si_seat", price: { id: SEAT_TEAM }, quantity: 3 }] },
    metadata: { selfServe: "true", officeName: "Acme", seatCount: "3", dashboard: "false" },
    ...overrides,
  };
}

function fakeSession(overrides: any = {}): any {
  return {
    id: "cs_1",
    metadata: { selfServe: "true", officeName: "Acme", seatCount: "3", dashboard: "false" },
    customer_email: "buyer@example.com",
    customer_details: null,
    ...overrides,
  };
}

describe("provisionSelfServeOffice", () => {
  beforeEach(() => {
    offices = new Map();
    nextOfficeId = 1;
    signups = [];
    tokens = new Map();

    (storage as any).getOfficeByStripeSubscriptionId = async (s: string) =>
      [...offices.values()].find((o) => o.stripeSubscriptionId === s);
    (storage as any).getOfficeByInviteCode = async (code: string) =>
      [...offices.values()].find((o) => o.inviteCode === code);
    (storage as any).listOffices = async () => [...offices.values()];
    (storage as any).createOffice = async (data: any) => {
      const office = { id: nextOfficeId++, managerItemId: null, seatItemId: null, activeSeatCount: 0, ...data };
      offices.set(office.id, office);
      return office;
    };
    (storage as any).updateOffice = async (id: number, patch: Partial<Office>) => {
      const o = offices.get(id);
      if (!o) return undefined;
      const next = { ...o, ...patch };
      offices.set(id, next);
      return next;
    };
    (storage as any).createPaidOfficeSignup = async (data: any) => {
      const row = { id: signups.length + 1, ...data };
      signups.push(row);
      return row;
    };
    (storage as any).getOfficeSetupToken = async (t: string) => tokens.get(t);
    (storage as any).updateOfficeSetupToken = async (id: number, patch: any) => {
      const found = [...tokens.values()].find((t) => t.id === id);
      if (found) Object.assign(found, patch);
      return found;
    };
  });

  test("creates an ACTIVE office with an invite code and records the paid signup", async () => {
    const office = await provisionSelfServeOffice(fakeSession(), fakeSubscription());
    assert.ok(office);
    assert.equal(office!.status, "active");
    assert.equal(office!.subscriptionStatus, "active");
    assert.equal(office!.stripeSubscriptionId, "sub_ss_1");
    assert.ok(office!.inviteCode && office!.inviteCode.length > 0);
    assert.equal(offices.get(office!.id)!.activeSeatCount, 3, "seat count synced from the subscription");

    assert.equal(signups.length, 1);
    assert.equal(signups[0].officeName, office!.name);
    assert.equal(signups[0].seatCount, 3);
    assert.equal(signups[0].dashboard, false);
    assert.equal(signups[0].stripeSubscriptionId, "sub_ss_1");
  });

  test("is idempotent: a redelivered webhook returns the existing office, no duplicate signup", async () => {
    const first = await provisionSelfServeOffice(fakeSession(), fakeSubscription());
    const second = await provisionSelfServeOffice(fakeSession(), fakeSubscription());
    assert.equal(first!.id, second!.id);
    assert.equal(signups.length, 1, "no second paid-signup row on redelivery");
    assert.equal(offices.size, 1);
  });

  test("ignores non-self-serve sessions (existing-office manager checkout)", async () => {
    const result = await provisionSelfServeOffice(
      fakeSession({ metadata: {} }),
      fakeSubscription({ metadata: {} }),
    );
    assert.equal(result, undefined);
    assert.equal(offices.size, 0);
  });

  test("marks the originating setup token used", async () => {
    tokens.set("tok_1", {
      id: 7,
      token: "tok_1",
      contactId: null,
      email: "buyer@example.com",
      name: "Acme",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      usedAt: null,
    } as OfficeSetupToken);
    await provisionSelfServeOffice(
      fakeSession({ metadata: { selfServe: "true", officeName: "Acme", seatCount: "3", dashboard: "false", setupToken: "tok_1" } }),
      fakeSubscription({ metadata: { selfServe: "true", officeName: "Acme", seatCount: "3", dashboard: "false", setupToken: "tok_1" } }),
    );
    assert.ok(tokens.get("tok_1")!.usedAt, "token should be stamped used");
  });

  test("disambiguates a colliding office name", async () => {
    offices.set(nextOfficeId++, { id: 1, name: "Acme", inviteCode: "X", createdAt: "", stripeCustomerId: null, stripeSubscriptionId: "other", subscriptionStatus: "active", managerItemId: null, seatItemId: null, activeSeatCount: 0, status: "active" } as Office);
    const office = await provisionSelfServeOffice(fakeSession(), fakeSubscription());
    assert.notEqual(office!.name, "Acme");
    assert.match(office!.name, /^Acme \(\d+\)$/);
  });
});

// The checkout.session.completed handler must route to self-serve provisioning
// based on the authoritative selfServe metadata (source-of-truth subscription
// object), NOT on the absence of client_reference_id. These tests lock in that
// behavior after removing the old client_reference_id-absence heuristic (Gap 2).
describe("handleStripeEvent routing for self-serve", () => {
  let events: any[];

  beforeEach(() => {
    offices = new Map();
    nextOfficeId = 1;
    signups = [];
    tokens = new Map();
    events = [];

    (storage as any).getOffice = async (id: number) => offices.get(id);
    (storage as any).getOfficeByStripeCustomerId = async (c: string) =>
      [...offices.values()].find((o) => o.stripeCustomerId === c);
    (storage as any).getOfficeByStripeSubscriptionId = async (s: string) =>
      [...offices.values()].find((o) => o.stripeSubscriptionId === s);
    (storage as any).getOfficeByInviteCode = async (code: string) =>
      [...offices.values()].find((o) => o.inviteCode === code);
    (storage as any).listOffices = async () => [...offices.values()];
    (storage as any).createOffice = async (data: any) => {
      const office = { id: nextOfficeId++, managerItemId: null, seatItemId: null, activeSeatCount: 0, ...data };
      offices.set(office.id, office);
      return office;
    };
    (storage as any).updateOffice = async (id: number, patch: Partial<Office>) => {
      const o = offices.get(id);
      if (!o) return undefined;
      const next = { ...o, ...patch };
      offices.set(id, next);
      return next;
    };
    (storage as any).createPaidOfficeSignup = async (data: any) => {
      const row = { id: signups.length + 1, ...data };
      signups.push(row);
      return row;
    };
    (storage as any).getOfficeSetupToken = async (t: string) => tokens.get(t);
    (storage as any).updateOfficeSetupToken = async () => undefined;
    (storage as any).getBillingEventByStripeId = async (eid: string) =>
      events.find((e) => e.stripeEventId === eid);
    (storage as any).recordBillingEvent = async (e: any) => {
      events.push(e);
      return { id: events.length, ...e };
    };

    __setStripeForTests({
      subscriptions: { retrieve: async () => fakeSubscription() },
    } as any);
  });

  test("provisions when only the subscription metadata carries selfServe (no client_reference_id, session metadata dropped)", async () => {
    await handleStripeEvent({
      id: "evt_ss_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", subscription: "sub_ss_1" } },
    } as any);
    assert.equal(offices.size, 1, "a self-serve office was provisioned from subscription metadata");
    assert.equal(signups.length, 1);
    assert.equal([...offices.values()][0].stripeSubscriptionId, "sub_ss_1");
  });

  test("does NOT provision a self-serve office for a manager checkout (client_reference_id set, no selfServe metadata)", async () => {
    __setStripeForTests({
      subscriptions: { retrieve: async () => fakeSubscription({ metadata: { officeId: "1" } }) },
    } as any);
    await handleStripeEvent({
      id: "evt_mgr_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_2", client_reference_id: "1", customer: "cus_1", subscription: "sub_ss_1" } },
    } as any);
    assert.equal(offices.size, 0, "no new office should be provisioned for a manager checkout");
    assert.equal(signups.length, 0);
  });
});

describe("welcome email setup CTA (item 2)", () => {
  test("appends the Set Up Your Office link when a setupUrl is given", () => {
    const url = "https://app.test/#/office-setup/abc123";
    const body = buildWelcomeEmailBody("Dana", url);
    assert.match(body, /Set Up Your Office: https:\/\/app\.test\/#\/office-setup\/abc123/);
  });

  test("is byte-identical to the original body when no setupUrl is given", () => {
    const withUrl = buildWelcomeEmailBody("Dana", undefined);
    assert.doesNotMatch(withUrl, /Set Up Your Office/);
  });
});

describe("computeSalesRow status passthrough", () => {
  test("carries the provisioning status onto the sales row", () => {
    const base = {
      id: 1,
      name: "Acme",
      inviteCode: "X",
      createdAt: "",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: "active",
      managerItemId: null,
      seatItemId: null,
      activeSeatCount: 3,
    };
    assert.equal(computeSalesRow({ ...base, status: "pending" } as Office).status, "pending");
    assert.equal(computeSalesRow({ ...base, status: "active" } as Office).status, "active");
  });
});
