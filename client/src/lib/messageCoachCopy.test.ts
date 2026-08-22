import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FUNNEL_COPY,
  INDUSTRY_OPTIONS,
  INPUT_COPY,
  MESSAGE_COACH_HEADER,
  MESSAGE_COACH_PATH,
  PAID_RETURN_COPY,
  PAYWALL_COPY,
  POSITIONING_COPY,
  RESULT_COPY,
  UNAVAILABLE_COPY,
} from "./messageCoachCopy";
import { MEMBER_OPTION } from "./demoPaywall";

const pageSource = readFileSync(
  fileURLToPath(new URL("../pages/message-coach.tsx", import.meta.url)),
  "utf8",
);
const appSource = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const homeSource = readFileSync(
  fileURLToPath(new URL("../pages/home.tsx", import.meta.url)),
  "utf8",
);
const routesSource = readFileSync(
  fileURLToPath(new URL("../../../server/messageCoachRoutes.ts", import.meta.url)),
  "utf8",
);

// Every customer-facing string this feature ships, flattened.
const ALL_COPY = [
  ...Object.values(MESSAGE_COACH_HEADER),
  POSITIONING_COPY,
  ...Object.values(INPUT_COPY),
  ...INDUSTRY_OPTIONS,
  ...Object.values(RESULT_COPY),
  ...Object.values(PAYWALL_COPY),
  ...Object.values(PAID_RETURN_COPY),
  ...Object.values(FUNNEL_COPY),
  ...Object.values(UNAVAILABLE_COPY),
];

describe("Message Coach copy", () => {
  // House voice standard. A dash slipping into shipped copy is the kind of thing
  // nobody notices in review, so it is asserted rather than trusted.
  test("carries no em dashes and no en dashes anywhere", () => {
    for (const line of ALL_COPY) {
      assert.ok(!line.includes("—"), `em dash in: ${line}`);
      assert.ok(!line.includes("–"), `en dash in: ${line}`);
    }
  });

  // Contractual with the marketing site: this paragraph is quoted from the spec,
  // so a change here is a copy decision, not a code change.
  test("the positioning paragraph is the spec's wording, verbatim", () => {
    assert.equal(
      POSITIONING_COPY,
      "ChatGPT can write you a nice, professional message. That's not the same thing. SOLVE rewrites your message against a published rubric, scores it, and shows you exactly why the rewrite gets responses instead of STOP replies. You're not just getting a better message, you're learning what makes messages work. Write them yourself once you've got it, or keep letting the system do it. Either way, you'll know why it works.",
    );
  });

  test("the price shown matches the price charged, in both places it appears", () => {
    assert.equal(PAYWALL_COPY.priceLine, "$4.99 for this score");
    assert.match(PAYWALL_COPY.buttonLabel, /\$4\.99/);
    const copySource = readFileSync(
      fileURLToPath(new URL("./messageCoachCopy.ts", import.meta.url)),
      "utf8",
    );
    // Cross-referenced to the charged amount the same way demoPaywall.ts is.
    assert.match(copySource, /MESSAGE_COACH_PRICE_CENTS in[\s\S]{0,20}server\/messageCoach\.ts/);
  });

  // The dropdown is sent to the server verbatim, so a drift between the two
  // lists would 400 every request that picked the drifted option.
  test("the industry options match the server's accepted enum exactly", () => {
    assert.deepEqual(
      [...INDUSTRY_OPTIONS],
      ["Auto", "Real Estate", "Mortgage", "Home Services", "Other"],
    );
    const serverList = routesSource.match(/const INDUSTRIES = \[([^\]]+)\]/)?.[1] ?? "";
    for (const option of INDUSTRY_OPTIONS) {
      assert.ok(serverList.includes(`"${option}"`), `server does not accept ${option}`);
    }
    assert.equal((serverList.match(/"/g) ?? []).length / 2, INDUSTRY_OPTIONS.length);
  });

  test("the email gate explains why the email is being asked for", () => {
    assert.match(INPUT_COPY.gateNote, /score/i);
    assert.ok(INPUT_COPY.emailLabel.length > 0);
    assert.ok(INPUT_COPY.nameLabel.length > 0);
  });

  test("the funnel footer points at routes that exist in the app", () => {
    assert.equal(FUNNEL_COPY.demoPath, "/demo");
    assert.equal(FUNNEL_COPY.pricingPath, "/signup");
    assert.match(appSource, /<Route path="\/demo" component=\{DemoV2\} \/>/);
    assert.match(appSource, /<Route path="\/signup" component=\{Signup\} \/>/);
  });
});

describe("Message Coach page wiring", () => {
  test("the page is mounted at the path the copy module names", () => {
    assert.equal(MESSAGE_COACH_PATH, "/message-coach");
    assert.match(
      appSource,
      /<Route path="\/message-coach" component=\{MessageCoach\} \/>/,
    );
    assert.match(appSource, /import MessageCoach from "@\/pages\/message-coach";/);
  });

  test("the root chooser does not advertise the paid feature", () => {
    assert.doesNotMatch(homeSource, /\/message-coach/);
    assert.ok(!homeSource.includes("link-choose-message-coach"));
  });

  test("the page renders every part of the result, not just the score", () => {
    for (const marker of [
      "text-message-coach-score",
      "text-message-coach-stalled",
      "text-message-coach-coaching",
      "text-message-coach-rewrite",
      "button-message-coach-copy",
      "card-message-coach-follow-up",
      "text-message-coach-follow-up",
      "button-message-coach-copy-follow-up",
    ]) {
      assert.ok(pageSource.includes(marker), `missing ${marker}`);
    }
  });

  // An anonymous visitor must verify their email with a 6-digit code before
  // the message/industry form unlocks; a signed-in member skips this
  // entirely. Same place in the flow as the demo's email step used to be,
  // now gated on isVerified rather than a bare filled-in email.
  test("the score button cannot be pressed before the email is verified", () => {
    const code = pageSource.replace(/\/\/.*$/gm, "");
    assert.match(code, /const isVerified = isMember \|\| Boolean\(verificationToken\)/);
    assert.match(code, /const canSubmit = message\.trim\(\)\.length > 0 && isVerified/);
    assert.match(code, /disabled=\{!canSubmit \|\| scoreMutation\.isPending\}/);
  });

  // A signed-in member is already captured as a user and must not be asked
  // to verify their email at all.
  test("a signed-in member is not shown the email verification gate", () => {
    const code = pageSource.replace(/\/\/.*$/gm, "");
    assert.match(code, /const isMember = Boolean\(user\?\.id\)/);
    assert.match(code, /\{!isMember && !isVerified && verifyStep === "email" && \(/);
    assert.match(code, /\{!isMember && !isVerified && verifyStep === "code" && \(/);
    assert.match(code, /\{isVerified && \(/);
  });

  test("the paywall opens Stripe Checkout, forwards the verification token, and parks the draft first", () => {
    const code = pageSource.replace(/\/\/.*$/gm, "");
    assert.match(code, /messageCoachApi\.checkout\(/);
    assert.match(code, /verificationToken,/);
    assert.match(
      code,
      /parkDraftForCheckout\(\{ message, industry, name, email, verificationToken \}\)/,
    );
    assert.match(code, /window\.location\.href = url/);
    assert.match(code, /disabled=\{checkoutMutation\.isPending \|\| !email\.trim\(\)\}/);
  });

  test("the Stripe session id is stripped from the address bar on return", () => {
    assert.match(pageSource, /paid === "success"/);
    assert.match(pageSource, /setPaidSessionId\(params\.get\("session_id"\)\)/);
    assert.match(
      pageSource,
      /window\.history\.replaceState\(\{\}, "", "#\/message-coach"\)/,
    );
  });

  // 402 is the paywall and 409 is "the webhook has not landed yet". Neither is
  // an error to show raw, and 409 in particular must not read like a failure to
  // someone who has just paid.
  test("a refusal is a UI state, not a raw error message", () => {
    const code = pageSource.replace(/\/\/.*$/gm, "");
    assert.match(code, /data\.kind === "payment_required"/);
    assert.match(code, /setConfirming\(true\)/);
    assert.equal(PAID_RETURN_COPY.headline, "Payment received.");
    assert.match(PAID_RETURN_COPY.confirming, /Confirming your payment/);
  });

  // The whole feature is dark unless the server flag is on, so the page has to
  // render something coherent rather than a broken form.
  test("the page has an off-flag state driven by the config 404", () => {
    assert.ok(pageSource.includes("text-message-coach-unavailable"));
    assert.match(pageSource, /if \(!config\.data\)/);
    assert.match(UNAVAILABLE_COPY.headline, /isn't available yet/);
  });

  // Lime green is reserved for admin/vault. Orange is the only hard-coded color.
  test("the page hard-codes no color other than brand orange", () => {
    const hexes = new Set(pageSource.match(/#[0-9A-Fa-f]{3,8}/g) ?? []);
    assert.deepEqual([...hexes], ["#E06D00"]);
  });
});

describe("the member checklist", () => {
  test("names Message Coach as included with a seat", () => {
    assert.ok(
      MEMBER_OPTION.features.includes(
        "Unlimited Message Coach, score and rewrite your outreach before you send it.",
      ),
      "the seat-includes checklist must name Message Coach",
    );
  });
});
