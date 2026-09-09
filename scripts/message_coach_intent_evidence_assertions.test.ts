import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  preservesContingentPromotionCommissionPartnership,
  preservesDemoReviewInvitation,
  preservesMultiOfficeCoordinationContext,
  preservesTeachingPracticeMechanism,
} from "./message_coach_intent_evidence_assertions";

describe("Message Coach evidence harness semantic assertions", () => {
  it("accepts faithful teaching-mechanism paraphrases without requiring the word complement", () => {
    assert.equal(
      preservesTeachingPracticeMechanism(
        "The platform helps teams understand and practice the concepts you teach.",
      ),
      true,
    );
    assert.equal(
      preservesTeachingPracticeMechanism(
        "Teams can comprehend and apply your training methods in daily work.",
      ),
      true,
    );
    assert.equal(
      preservesTeachingPracticeMechanism(
        "The platform helps teams actively engage with and practice the concepts you teach.",
      ),
      true,
    );
  });

  it("still rejects vague value language that drops the concrete teaching mechanism", () => {
    assert.equal(
      preservesTeachingPracticeMechanism(
        "The platform enhances how teams engage and empowers your business.",
      ),
      false,
    );
    assert.equal(
      preservesTeachingPracticeMechanism("The platform helps teams understand your concepts."),
      false,
    );
    assert.equal(
      preservesTeachingPracticeMechanism(
        "The platform enhances engagement with your training, adds value, and empowers your business.",
      ),
      false,
    );
  });

  it("requires a demonstration plus an invitation to review it", () => {
    assert.equal(
      preservesDemoReviewInvitation(
        "I’d love to show you a quick demo. Would you be open to a brief demonstration?",
      ),
      true,
    );
    assert.equal(preservesDemoReviewInvitation("The platform includes a demo."), false);
  });

  it("requires promotion, referral outcome, commission, and contingency together", () => {
    for (const message of [
      "If it aligns with your needs, I’d advertise your services and offer commission for subscribers who join.",
      "If it fits, I’d promote your services and pay a commission for referred customers.",
      "If it is useful, I can feature your services and offer referral compensation for new clients.",
      "If you like what you see, I’d market your services and share revenue from subscribers.",
      "If it makes sense, I’d be happy to promote your services and offer a commission for referrals.",
      "If it’s a fit, I’d be happy to promote your services and offer a commission for new subscribers.",
    ]) {
      assert.equal(
        preservesContingentPromotionCommissionPartnership(message),
        true,
        message,
      );
    }
    assert.equal(
      preservesContingentPromotionCommissionPartnership(
        "I can promote your services and pay commission for subscribers.",
      ),
      false,
    );
    assert.equal(
      preservesContingentPromotionCommissionPartnership(
        "If it’s useful, I can add value and empower your business.",
      ),
      false,
    );
    assert.equal(
      preservesContingentPromotionCommissionPartnership(
        "If it aligns with your needs, I’d be happy to show you a demo. I advertise services and pay commission for subscribers.",
      ),
      false,
    );
    assert.equal(
      preservesContingentPromotionCommissionPartnership(
        "If it aligns, I’d show you a demo; regardless, I always advertise services and pay commission for subscribers.",
      ),
      false,
    );
  });

  it("accepts handoff, coordination, and transfer paraphrases between multiple offices", () => {
    assert.equal(
      preservesMultiOfficeCoordinationContext(
        "What are the biggest challenges in coordinating between the two offices?",
      ),
      true,
    );
    assert.equal(
      preservesMultiOfficeCoordinationContext("How are handoffs working across both locations?"),
      true,
    );
    assert.equal(
      preservesMultiOfficeCoordinationContext(
        "Where does information transfer break down between your branches?",
      ),
      true,
    );
  });

  it("rejects generic challenges that omit the inter-office operating context", () => {
    assert.equal(
      preservesMultiOfficeCoordinationContext("What are your biggest challenges right now?"),
      false,
    );
    assert.equal(
      preservesMultiOfficeCoordinationContext("How is the second office going?"),
      false,
    );
  });
});
