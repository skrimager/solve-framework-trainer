import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MEMBER_OPTION,
  MEMBER_SIGNUP_PATH,
  PAID_RETURN_NOTICE,
  PAY_PER_SESSION_OPTION,
} from "./demoPaywall";

const demoPageSource = readFileSync(
  fileURLToPath(new URL("../pages/demo-v2.tsx", import.meta.url)),
  "utf8",
);
const appSource = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

describe("post-free-session fork copy", () => {
  test("both options exist with their headline wording", () => {
    assert.equal(MEMBER_OPTION.headline, "Become a Member");
    assert.equal(MEMBER_OPTION.subhead, "Unlock the complete SOLVE experience.");
    assert.equal(PAY_PER_SESSION_OPTION.headline, "Purchase Individual Demo Sessions");
    assert.equal(PAY_PER_SESSION_OPTION.priceLine, "$4.99 per session");
  });

  test("membership is the recommended path and lists the full member benefits", () => {
    assert.equal(MEMBER_OPTION.badge, "Recommended");
    assert.equal(MEMBER_OPTION.features.length, 14);
    assert.equal(MEMBER_OPTION.features[0], "Up to 10 hours of practice sessions every month");
    assert.ok(MEMBER_OPTION.features.includes("Certifications"));
    assert.ok(MEMBER_OPTION.features.includes("SOLVE Academy access"));
  });

  test("the per-session option is honest about what it leaves out", () => {
    assert.ok(PAY_PER_SESSION_OPTION.includes.includes("One AI practice session"));
    for (const excluded of ["Manager Dashboard", "SOLVE Academy", "Certifications"]) {
      assert.ok(PAY_PER_SESSION_OPTION.excludes.includes(excluded), excluded);
      assert.ok(!PAY_PER_SESSION_OPTION.includes.includes(excluded), excluded);
    }
    assert.match(PAY_PER_SESSION_OPTION.disclaimer, /intended for practice only/);
  });

  test("the fork renders both options and both buttons", () => {
    for (const marker of [
      "demo-v2-fork-member",
      "demo-v2-fork-pay-per-session",
      "button-demo-v2-become-member",
      "button-demo-v2-pay-per-session",
    ]) {
      assert.ok(demoPageSource.includes(marker), `missing ${marker}`);
    }
    assert.ok(demoPageSource.includes("MEMBER_OPTION"));
    assert.ok(demoPageSource.includes("PAY_PER_SESSION_OPTION"));
  });

  test("copy says 'practice', never 'train', and carries no em dashes", () => {
    const copy = [
      ...Object.values(MEMBER_OPTION).flat(),
      ...Object.values(PAY_PER_SESSION_OPTION).flat(),
      ...Object.values(PAID_RETURN_NOTICE).flat(),
    ].join(" ");
    assert.ok(!copy.includes("—"), "no em dashes in customer-facing copy");
    assert.doesNotMatch(copy, /\btrain(ing|s|ed)?\b/i);
    assert.match(copy, /practice/i);
  });

  // Lime green is reserved for admin/vault, so the fork earns its emphasis from
  // size, border and weight instead. Orange is the only hard-coded color here.
  test("the demo page hard-codes no color other than brand orange", () => {
    const hexes = new Set(demoPageSource.match(/#[0-9A-Fa-f]{3,8}/g) ?? []);
    assert.deepEqual([...hexes], ["#E06D00"]);
  });
});

describe("Become a Member routing", () => {
  test("routes to the existing self-serve signup entry point", () => {
    assert.equal(MEMBER_SIGNUP_PATH, "/signup");
  });

  test("that entry point is a real route in the app", () => {
    assert.match(appSource, /<Route path="\/signup" component=\{Signup\} \/>/);
  });
});

describe("pay-per-session button takes a real one-time charge", () => {
  // Comments stripped so prose in a comment cannot satisfy an assertion about
  // the code itself.
  const demoPageCode = demoPageSource.replace(/\/\/.*$/gm, "");

  test("the button opens Stripe Checkout via the demo checkout endpoint", () => {
    assert.match(demoPageCode, /demoV2Api\.createPaidSessionCheckout\(token \?\? ""\)/);
    assert.match(demoPageCode, /window\.location\.href = data\.url/);
  });

  test("the token is parked before the app hands off to Stripe", () => {
    assert.match(demoPageCode, /parkDemoTokenForCheckout\(token, email\)/);
    assert.match(demoPageCode, /window\.sessionStorage\.setItem\(PAID_ROUND_TRIP_KEY/);
  });

  test("the button shows a pending state and stays clickable after a failure", () => {
    assert.match(demoPageCode, /disabled=\{checkout\.isPending\}/);
    assert.match(demoPageCode, /checkout\.isPending \? PAY_PER_SESSION_OPTION\.pendingLabel/);
    assert.match(demoPageCode, /setCheckoutError\(e\.message \|\| PAY_PER_SESSION_OPTION\.errorMessage\)/);
    assert.match(PAY_PER_SESSION_OPTION.pendingLabel, /checkout/i);
    assert.ok(PAY_PER_SESSION_OPTION.errorMessage.length > 0);
  });

  test("the interest-capture stub is gone, not left orphaned", () => {
    assert.doesNotMatch(demoPageSource, /PayPerSessionInterestForm/);
    assert.doesNotMatch(demoPageSource, /showInterest/);
    assert.doesNotMatch(demoPageSource, /PAY_PER_SESSION_INTEREST/);
  });

  test("the displayed price is cross-referenced to the charged amount", () => {
    const paywallSource = readFileSync(
      fileURLToPath(new URL("./demoPaywall.ts", import.meta.url)),
      "utf8",
    );
    assert.match(paywallSource, /DEMO_SESSION_PRICE_CENTS in[\s\S]{0,10}server\/demoPayments\.ts/);
  });
});

describe("returning from Stripe Checkout", () => {
  test("a completed purchase is confirmed on the welcome screen", () => {
    assert.equal(PAID_RETURN_NOTICE.headline, "Payment received.");
    assert.match(PAID_RETURN_NOTICE.body, /one practice session ready/);
    assert.ok(demoPageSource.includes("banner-demo-v2-paid-return"));
    assert.match(demoPageSource, /get\("paid"\)/);
    assert.match(demoPageSource, /paid === "success"/);
  });

  test("the Stripe session id is stripped from the address bar", () => {
    assert.match(demoPageSource, /window\.history\.replaceState\(\{\}, "", "#\/demo"\)/);
  });
});
