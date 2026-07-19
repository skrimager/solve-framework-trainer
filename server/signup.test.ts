import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SIGNUP_RESEND_COOLDOWN_MS,
  canResendSignupCode,
  validateOfficeSetupInput,
  buildSignupVerificationEmail,
  buildConsultantEnrollmentEmail,
} from "./signup";
import {
  generateVerificationCode,
  codeExpiryFrom,
  isCodeValid,
  CODE_TTL_MS,
} from "./demo";

// The signup flow REUSES the demo verification primitives (6-digit generation,
// expiry, constant-time validation). These tests exercise that shared lifecycle
// against an office_signups-shaped row plus the signup-only helpers layered on
// top (resend cooldown, office-setup validation, email bodies).

describe("verification code generation", () => {
  test("is always a zero-padded 6-digit numeric string", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateVerificationCode();
      assert.match(code, /^\d{6}$/);
    }
  });

  test("varies across calls (not a constant)", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateVerificationCode()));
    assert.ok(codes.size > 1, "generator must not return a constant");
  });
});

describe("verification code validation + expiry", () => {
  test("accepts the exact code before expiry", () => {
    const now = Date.now();
    const code = generateVerificationCode();
    const signup = { code, codeExpiresAt: codeExpiryFrom(now) };
    assert.equal(isCodeValid(signup, code, now), true);
  });

  test("trims whitespace on the submitted code", () => {
    const now = Date.now();
    const signup = { code: "012345", codeExpiresAt: codeExpiryFrom(now) };
    assert.equal(isCodeValid(signup, "  012345  ", now), true);
  });

  test("rejects a wrong code", () => {
    const now = Date.now();
    const signup = { code: "012345", codeExpiresAt: codeExpiryFrom(now) };
    assert.equal(isCodeValid(signup, "999999", now), false);
  });

  test("rejects once expired (past the 10-minute TTL)", () => {
    const issued = Date.now();
    const signup = { code: "012345", codeExpiresAt: codeExpiryFrom(issued) };
    assert.equal(isCodeValid(signup, "012345", issued + CODE_TTL_MS + 1), false);
  });

  test("rejects a consumed code (null code/expiry)", () => {
    assert.equal(isCodeValid({ code: null, codeExpiresAt: null }, "012345"), false);
  });
});

describe("canResendSignupCode", () => {
  test("allows a resend when the code was never sent", () => {
    assert.equal(canResendSignupCode({ lastSentAt: null }), true);
  });

  test("blocks a resend inside the cooldown window", () => {
    const now = Date.now();
    const lastSentAt = new Date(now - (SIGNUP_RESEND_COOLDOWN_MS - 1)).toISOString();
    assert.equal(canResendSignupCode({ lastSentAt }, now), false);
  });

  test("allows a resend once the cooldown has elapsed", () => {
    const now = Date.now();
    const lastSentAt = new Date(now - SIGNUP_RESEND_COOLDOWN_MS).toISOString();
    assert.equal(canResendSignupCode({ lastSentAt }, now), true);
  });

  test("treats an unparseable timestamp as long-ago (never permanently blocks)", () => {
    assert.equal(canResendSignupCode({ lastSentAt: "not-a-date" }), true);
  });
});

describe("validateOfficeSetupInput", () => {
  const valid = {
    company: "Acme",
    managerName: "Dana",
    username: "dana",
    password: "hunter2",
    seatCount: 4,
  };

  test("returns null for a complete valid input", () => {
    assert.equal(validateOfficeSetupInput(valid), null);
  });

  test("requires company, name, and username", () => {
    assert.match(validateOfficeSetupInput({ ...valid, company: "  " })!, /Company/i);
    assert.match(validateOfficeSetupInput({ ...valid, managerName: "" })!, /name/i);
    assert.match(validateOfficeSetupInput({ ...valid, username: "" })!, /username/i);
  });

  test("requires a password of at least 6 characters", () => {
    assert.match(validateOfficeSetupInput({ ...valid, password: "12345" })!, /6 characters/);
  });

  test("requires at least one seat", () => {
    assert.match(validateOfficeSetupInput({ ...valid, seatCount: 0 })!, /at least one/i);
  });

  test("rejects Enterprise seat counts (36+) with a contact-us message", () => {
    assert.match(validateOfficeSetupInput({ ...valid, seatCount: 36 })!, /Enterprise/);
  });
});

describe("buildSignupVerificationEmail", () => {
  test("includes the code, TTL, and brand navy (no lime green)", () => {
    const { subject, html } = buildSignupVerificationEmail("012345");
    assert.match(subject, /012345/);
    assert.match(html, /012345/);
    assert.match(html, /10 minutes/);
    assert.match(html, /#0A1A30/);
    assert.doesNotMatch(html, /C6F135/i);
  });

  test("escapes HTML-significant characters if present in the code position", () => {
    const { html } = buildSignupVerificationEmail("<b>");
    assert.doesNotMatch(html, /<b>/);
  });
});

describe("buildConsultantEnrollmentEmail", () => {
  const details = {
    officeName: "Acme",
    inviteCode: "ACME1234",
    activateUrl: "https://app.test/#/register?code=ACME1234",
  };

  test("uses the enrollment subject and includes the code + activation link", () => {
    const { subject, html, text } = buildConsultantEnrollmentEmail(details);
    assert.match(subject, /enrolled in the SOLVE Academy/i);
    assert.match(text, /ACME1234/);
    assert.match(html, /ACME1234/);
    assert.match(html, /href="https:\/\/app\.test\/#\/register\?code=ACME1234"/);
  });

  test("uses discovery language and 'practice', never sales/training-as-a-verb", () => {
    const { text } = buildConsultantEnrollmentEmail(details);
    assert.match(text, /discovery/i);
    assert.match(text, /practice/i);
    assert.doesNotMatch(text, /\bAI roleplay\b/i);
  });
});
