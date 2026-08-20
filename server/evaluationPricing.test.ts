import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ENTERPRISE_MIN_SEATS,
  EVALUATION_PRICING,
  isEnterpriseSeatCount,
  meetsConversionSeatFloor,
  monthlySeatAmountCents,
  planForSeatCount,
  quoteEvaluation,
  validateEvaluationParticipantCount,
} from "@shared/pricing";

describe("locked self-serve pricing", () => {
  test("maps the 5→6 Team to Office break", () => {
    assert.equal(planForSeatCount(5)?.tier, "team");
    assert.equal(monthlySeatAmountCents(5), 64_500);
    assert.equal(planForSeatCount(6)?.tier, "office");
    assert.equal(monthlySeatAmountCents(6), 69_000);
  });

  test("maps the intentional 15→16 Office to Company price break", () => {
    assert.equal(planForSeatCount(15)?.tier, "office");
    assert.equal(monthlySeatAmountCents(15), 172_500);
    assert.equal(planForSeatCount(16)?.tier, "company");
    assert.equal(monthlySeatAmountCents(16), 158_400);
    assert.ok(monthlySeatAmountCents(16)! < monthlySeatAmountCents(15)!);
  });

  test("does not offer checkout at the 22-seat Enterprise boundary", () => {
    assert.equal(ENTERPRISE_MIN_SEATS, 22);
    assert.equal(isEnterpriseSeatCount(21), false);
    assert.equal(isEnterpriseSeatCount(22), true);
    assert.equal(planForSeatCount(22), null);
    assert.equal(monthlySeatAmountCents(22), null);
  });
});

describe("14-Day Team Evaluation quote math", () => {
  test("keeps the internal 1-2 participant rate flat", () => {
    assert.deepEqual(quoteEvaluation(1), {
      participantCount: 1,
      tier: "small",
      additionalParticipantCount: 0,
      totalAmountCents: 17_500,
    });
    assert.equal(quoteEvaluation(2).totalAmountCents, 17_500);
  });

  test("uses the public 3-5 participant base rate", () => {
    for (const count of [3, 4, 5]) {
      const quote = quoteEvaluation(count);
      assert.equal(quote.tier, "standard");
      assert.equal(quote.additionalParticipantCount, 0);
      assert.equal(quote.totalAmountCents, 24_900);
    }
  });

  test("adds $50 for every participant after five through the ten-person cap", () => {
    assert.equal(quoteEvaluation(6).totalAmountCents, 29_900);
    assert.equal(quoteEvaluation(7).totalAmountCents, 34_900);
    assert.equal(quoteEvaluation(8).totalAmountCents, 39_900);
    assert.equal(quoteEvaluation(9).totalAmountCents, 44_900);
    assert.equal(quoteEvaluation(10).totalAmountCents, 49_900);
    assert.equal(quoteEvaluation(10).additionalParticipantCount, 5);
  });

  test("rejects participant counts outside the hard cap", () => {
    assert.throws(() => validateEvaluationParticipantCount(0), /1 to 10/);
    assert.throws(() => validateEvaluationParticipantCount(11), /1 to 10/);
    assert.throws(() => quoteEvaluation(2.5), /integer/);
  });

  test("sets exactly a 14-day offer and enforces conversion seat parity", () => {
    assert.equal(EVALUATION_PRICING.productName, "14-Day Team Evaluation");
    assert.equal(EVALUATION_PRICING.durationDays, 14);
    assert.equal(meetsConversionSeatFloor(5, 6), false);
    assert.equal(meetsConversionSeatFloor(6, 6), true);
    assert.equal(meetsConversionSeatFloor(7, 6), true);
    assert.equal(meetsConversionSeatFloor(1, 1), false, "a $129 invoice cannot absorb a $175 credit");
    assert.equal(meetsConversionSeatFloor(2, 1), true);
  });
});
