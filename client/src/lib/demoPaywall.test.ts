import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MEMBER_OPTION,
  MEMBER_SIGNUP_PATH,
  PAY_PER_SESSION_INTEREST,
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
    assert.equal(MEMBER_OPTION.features[0], "Unlimited practice sessions (based on your membership plan)");
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
      ...Object.values(PAY_PER_SESSION_INTEREST).flat(),
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

describe("pay-per-session button is a stub, not a charge", () => {
  // Comments stripped so the deliberate "Stripe charge deferred" note at the
  // click handler does not mask a real Stripe reference in the code itself.
  const demoPageCode = demoPageSource.replace(/\/\/.*$/gm, "");

  test("the demo page contains no Stripe or checkout code at all", () => {
    assert.doesNotMatch(demoPageCode, /stripe/i);
    assert.doesNotMatch(demoPageCode, /checkout/i);
    assert.doesNotMatch(demoPageCode, /createSelfServeCheckoutSession/);
    assert.doesNotMatch(demoPageCode, /payment/i);
  });

  test("the click handler only opens interest capture", () => {
    assert.match(
      demoPageSource,
      /Live \$4\.99 one-time Stripe charge intentionally deferred to a follow-up PR per product decision \(see demo_paywall_redesign_spec\.md\)\. This currently captures interest only\./,
    );
    assert.match(demoPageSource, /onClick=\{\(\) => setShowInterest\(true\)\}/);
  });

  test("interest capture reuses the existing demo lead endpoint", () => {
    assert.match(demoPageSource, /demoV2Api\.submitLead\(\{\s*name: leadEmail/);
    assert.match(PAY_PER_SESSION_INTEREST.leadMessage, /\$4\.99 per session/);
  });
});
