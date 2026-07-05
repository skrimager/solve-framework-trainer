import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildCustomerReplyPrompt, CONVERSATION_REALISM_RULES } from "./llm";
import type { TranscriptMessage } from "@shared/schema";

const PERSONA = "You are Denise, 52, looking at a home in a manufactured-housing community.";

function msg(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

describe("buildCustomerReplyPrompt - conversation realism (anti-looping)", () => {
  test("always embeds the conversation realism rules", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, [], "intermediate");
    assert.ok(prompt.includes(CONVERSATION_REALISM_RULES));
  });

  test("instructs the persona not to restate an already-raised concern (issue 3b)", () => {
    const rules = CONVERSATION_REALISM_RULES.toLowerCase();
    // Must forbid repeating/rewording a concern already voiced.
    assert.ok(rules.includes("already"));
    assert.ok(rules.includes("reworded") || rules.includes("rephrased"));
  });

  test("instructs the persona to give NEW information when asked to clarify (issue 3c)", () => {
    const rules = CONVERSATION_REALISM_RULES.toLowerCase();
    assert.ok(rules.includes("clarify"));
    assert.ok(rules.includes("new"));
    // Should explicitly discourage mere paraphrasing.
    assert.ok(rules.includes("paraphrase") || rules.includes("restate"));
  });

  test("instructs the persona to acknowledge and move on once a concern is addressed (issue 3d)", () => {
    const rules = CONVERSATION_REALISM_RULES.toLowerCase();
    assert.ok(rules.includes("move on") || rules.includes("moving forward") || rules.includes("forward"));
    assert.ok(rules.includes("acknowledge"));
  });

  test("still includes the persona, difficulty behavior, and conversation history", () => {
    const transcript = [
      msg("customer", "I just don't want any increases in lot rent."),
      msg("consultant", "Can you tell me more about that?"),
    ];
    const prompt = buildCustomerReplyPrompt(PERSONA, transcript, "advanced");
    assert.ok(prompt.includes(PERSONA));
    assert.ok(prompt.includes("ADVANCED"));
    assert.ok(prompt.includes("lot rent"));
    assert.ok(prompt.includes("Consultant: Can you tell me more about that?"));
    assert.ok(prompt.includes("Customer (you): I just don't want any increases in lot rent."));
  });

  test("falls back to intermediate calibration for an unknown difficulty", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, [], "nonsense-level");
    assert.ok(prompt.includes("INTERMEDIATE"));
  });

  test("handles an empty transcript with a sensible placeholder", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, [], "beginner");
    assert.ok(prompt.includes("The consultant is about to greet you"));
  });
});

import {
  detectCloseIntent,
  closeOutcomeAnchor,
  normalizeCloseOutcome,
  computeConsultingOverall,
  CLOSE_OUTCOMES,
  ADVANCE_THRESHOLD,
  WEAK_PROCESS_CAP,
  SOFT_CLOSE_CAP,
  type CloseOutcome,
} from "./llm";
import type { RubricScores } from "@shared/schema";

// Helper: build a consulting rubric with sensible defaults, overridable per test.
function rubric(overrides: Partial<RubricScores> = {}): RubricScores {
  return {
    needsDiscovery: 85,
    objectionPrevention: 85,
    trustBuilding: 85,
    naturalClose: 85,
    relationshipContinuity: 85,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectCloseIntent — soft-close / wrap-up detection
// ---------------------------------------------------------------------------

describe("detectCloseIntent", () => {
  test("detects explicit goodbyes and thank-offs", () => {
    assert.equal(detectCloseIntent("Okay, thanks for your time, goodbye!"), true);
    assert.equal(detectCloseIntent("Thank you for your time today."), true);
    assert.equal(detectCloseIntent("Alright, take care!"), true);
    assert.equal(detectCloseIntent("Have a great day."), true);
  });

  test("detects handoff-without-commitment phrasing", () => {
    assert.equal(detectCloseIntent("Here's my card, call me when you're ready."), true);
    assert.equal(detectCloseIntent("I'll leave you my number, give me a call."), true);
    assert.equal(detectCloseIntent("Let me hand you my business card."), true);
    assert.equal(detectCloseIntent("I'll follow up with you next week."), true);
    assert.equal(detectCloseIntent("Feel free to reach out whenever you're ready."), true);
  });

  test("does NOT fire on ordinary mid-conversation discovery messages", () => {
    assert.equal(detectCloseIntent("What's prompting you to look into this right now?"), false);
    assert.equal(detectCloseIntent("Tell me more about how your current setup is working."), false);
    assert.equal(detectCloseIntent("So the budget is the main concern for you?"), false);
    assert.equal(detectCloseIntent(""), false);
  });
});

// ---------------------------------------------------------------------------
// closeOutcomeAnchor / normalizeCloseOutcome
// ---------------------------------------------------------------------------

describe("close outcome anchors", () => {
  test("anchors follow the tiered rubric ordering", () => {
    assert.ok(closeOutcomeAnchor("none") < closeOutcomeAnchor("handoff_no_commitment"));
    assert.ok(closeOutcomeAnchor("handoff_no_commitment") < closeOutcomeAnchor("recommendation_made"));
    assert.ok(closeOutcomeAnchor("recommendation_made") < closeOutcomeAnchor("client_asked_next_steps"));
    assert.ok(closeOutcomeAnchor("client_asked_next_steps") < closeOutcomeAnchor("client_agreed"));
  });

  test("client-asked anchors ~80 and client-agreed anchors ~85", () => {
    assert.equal(closeOutcomeAnchor("client_asked_next_steps"), 80);
    assert.equal(closeOutcomeAnchor("client_agreed"), 85);
  });

  test("normalizeCloseOutcome accepts known values and falls back safely", () => {
    for (const o of CLOSE_OUTCOMES) {
      assert.equal(normalizeCloseOutcome(o), o);
    }
    assert.equal(normalizeCloseOutcome("Client_Agreed"), "client_agreed");
    assert.equal(normalizeCloseOutcome("garbage"), "recommendation_made");
    assert.equal(normalizeCloseOutcome(undefined), "recommendation_made");
  });
});

// ---------------------------------------------------------------------------
// computeConsultingOverall — the tiered, weighted scoring rule
// ---------------------------------------------------------------------------

describe("computeConsultingOverall", () => {
  test("no recommendation / handoff-only close scores LOW", () => {
    const strongProcess = rubric();
    const noRec = computeConsultingOverall(strongProcess, "none");
    const handoff = computeConsultingOverall(strongProcess, "handoff_no_commitment");
    // Even with otherwise strong discovery, a soft close is capped low.
    assert.ok(noRec <= SOFT_CLOSE_CAP, `expected <= ${SOFT_CLOSE_CAP}, got ${noRec}`);
    assert.ok(handoff <= SOFT_CLOSE_CAP, `expected <= ${SOFT_CLOSE_CAP}, got ${handoff}`);
    assert.ok(noRec < ADVANCE_THRESHOLD);
    assert.ok(handoff < ADVANCE_THRESHOLD);
  });

  test("recommendation made but WEAK rapport/discovery still fails", () => {
    const weak = rubric({
      needsDiscovery: 40,
      objectionPrevention: 35,
      trustBuilding: 45,
      naturalClose: 70,
      relationshipContinuity: 70,
    });
    // A recommendation was stated (necessary) — but not sufficient.
    const withRec = computeConsultingOverall(weak, "recommendation_made");
    const withAgreement = computeConsultingOverall(weak, "client_agreed");
    assert.ok(withRec <= WEAK_PROCESS_CAP, `expected <= ${WEAK_PROCESS_CAP}, got ${withRec}`);
    // Even explicit client agreement cannot rescue too-shallow discovery.
    assert.ok(withAgreement <= WEAK_PROCESS_CAP, `expected <= ${WEAK_PROCESS_CAP}, got ${withAgreement}`);
    assert.ok(withRec < ADVANCE_THRESHOLD);
    assert.ok(withAgreement < ADVANCE_THRESHOLD);
  });

  test("client asking 'what are the next steps?' lands in the ~80 range when the rest is solid", () => {
    const solid = rubric({
      needsDiscovery: 85,
      objectionPrevention: 80,
      trustBuilding: 85,
      naturalClose: 80,
      relationshipContinuity: 80,
    });
    const score = computeConsultingOverall(solid, "client_asked_next_steps");
    assert.ok(score >= 78 && score <= 86, `expected ~80 range, got ${score}`);
  });

  test("client explicitly agreeing anchors ~85 and can exceed it with strong sub-scores", () => {
    const strong = rubric({
      needsDiscovery: 92,
      objectionPrevention: 90,
      trustBuilding: 92,
      naturalClose: 90,
      relationshipContinuity: 90,
    });
    const score = computeConsultingOverall(strong, "client_agreed");
    assert.ok(score >= 85, `expected >= 85, got ${score}`);
  });

  test("a strong-process recommendation with no explicit buy-in signal outranks a soft close", () => {
    const solid = rubric();
    const recommendation = computeConsultingOverall(solid, "recommendation_made");
    const handoff = computeConsultingOverall(solid, "handoff_no_commitment");
    assert.ok(recommendation > handoff);
  });

  test("scores stay within 0..100", () => {
    const outcomes: CloseOutcome[] = [...CLOSE_OUTCOMES];
    for (const o of outcomes) {
      const hi = computeConsultingOverall(rubric({ needsDiscovery: 100, objectionPrevention: 100, trustBuilding: 100, naturalClose: 100, relationshipContinuity: 100 }), o);
      const lo = computeConsultingOverall(rubric({ needsDiscovery: 0, objectionPrevention: 0, trustBuilding: 0, naturalClose: 0, relationshipContinuity: 0 }), o);
      assert.ok(hi >= 0 && hi <= 100);
      assert.ok(lo >= 0 && lo <= 100);
    }
  });
});
