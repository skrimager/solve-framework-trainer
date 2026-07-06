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
