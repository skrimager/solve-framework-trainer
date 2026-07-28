import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { AUDIO_TAIL_GUARD_MS, echoContainmentRatio, isLikelyEchoOfCustomer } from "./echoGuard";

// Bug 1, live-voice half. The mic reopens on an estimated audio end time, so the
// tail of the AI customer's speech can still be audible and get transcribed by
// the browser recognizer, then posted as a CONSULTANT turn. That single bad turn
// is what later makes the coach credit the rep for something the customer said,
// so it has to be dropped before it is ever sent.
describe("isLikelyEchoOfCustomer", () => {
  const CUSTOMER =
    "I have been driving that truck for eight years and the fuel cost is finally getting to me.";

  test("verbatim echo of the customer's line is caught", () => {
    assert.equal(isLikelyEchoOfCustomer(CUSTOMER, CUSTOMER), true);
  });

  test("a recognized tail fragment of the customer's line is caught", () => {
    assert.equal(isLikelyEchoOfCustomer("the fuel cost is finally getting to me", CUSTOMER), true);
  });

  test("casing and punctuation differences do not defeat it", () => {
    assert.equal(isLikelyEchoOfCustomer("The Fuel Cost Is Finally Getting To Me!", CUSTOMER), true);
  });

  test("a genuine rep reply is never dropped", () => {
    assert.equal(
      isLikelyEchoOfCustomer("That makes sense, how many miles a week are you putting on it?", CUSTOMER),
      false,
    );
  });

  test("a rep reply that quotes a couple of the customer's words is kept", () => {
    // Reflective listening reuses the customer's words on purpose; only a near
    // total overlap counts as an echo.
    assert.equal(isLikelyEchoOfCustomer("So the fuel cost is the real driver here for you", CUSTOMER), false);
  });

  test("very short utterances are never treated as echoes", () => {
    assert.equal(isLikelyEchoOfCustomer("to me", CUSTOMER), false);
    assert.equal(isLikelyEchoOfCustomer("yeah", CUSTOMER), false);
  });

  test("no customer text means nothing is dropped", () => {
    assert.equal(isLikelyEchoOfCustomer("anything at all here", ""), false);
  });
});

describe("echoContainmentRatio", () => {
  test("is 1 for a draft fully contained in the customer line", () => {
    assert.equal(echoContainmentRatio("fuel cost is finally", "the fuel cost is finally getting to me"), 1);
  });

  test("is 0 when there is no shared run of words", () => {
    assert.equal(echoContainmentRatio("how many miles", "the fuel cost"), 0);
  });

  test("is 0 for empty input on either side", () => {
    assert.equal(echoContainmentRatio("", "the fuel cost"), 0);
    assert.equal(echoContainmentRatio("the fuel cost", ""), 0);
  });
});

describe("AUDIO_TAIL_GUARD_MS", () => {
  test("leaves real headroom past the estimated end of the audio", () => {
    // The Web Audio path finishes on a timeline estimate, not a real event, so
    // the guard has to cover the estimate being slightly early.
    assert.ok(AUDIO_TAIL_GUARD_MS >= 250, `expected a meaningful guard, got ${AUDIO_TAIL_GUARD_MS}`);
    assert.ok(AUDIO_TAIL_GUARD_MS <= 800, `guard must not feel laggy, got ${AUDIO_TAIL_GUARD_MS}`);
  });
});
