import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildCustomerReplyPrompt,
  buildCustomerReplyStablePrefix,
  CONVERSATION_REALISM_RULES,
} from "./llm";
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

describe("buildCustomerReplyPrompt - prompt-cache ordering (stable prefix first)", () => {
  const transcript = [
    msg("customer", "I just don't want any increases in lot rent."),
    msg("consultant", "Can you tell me more about that?"),
  ];

  test("the stable prefix (persona + difficulty + rules) precedes the volatile transcript", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, transcript, "advanced");
    const personaIdx = prompt.indexOf(PERSONA);
    const rulesIdx = prompt.indexOf(CONVERSATION_REALISM_RULES);
    const transcriptIdx = prompt.indexOf("Conversation so far:");
    // persona -> difficulty behavior -> realism rules must all come before the
    // growing transcript so the prefix stays byte-identical (and cacheable)
    // across turns.
    assert.ok(personaIdx >= 0 && rulesIdx >= 0 && transcriptIdx >= 0);
    assert.ok(personaIdx < rulesIdx, "persona should precede the realism rules");
    assert.ok(rulesIdx < transcriptIdx, "realism rules should precede the transcript");
  });

  test("the prompt begins with the exact stable prefix block", () => {
    const stable = buildCustomerReplyStablePrefix(PERSONA, "advanced");
    const prompt = buildCustomerReplyPrompt(PERSONA, transcript, "advanced");
    assert.ok(prompt.startsWith(stable), "prompt must start with the stable prefix");
  });

  test("the stable prefix is byte-identical across turns when persona/difficulty are unchanged", () => {
    // The prefix must not vary as the transcript grows — that byte-identity is
    // exactly what lets OpenAI serve it from cache on turns 2, 3, 4...
    const turn1 = buildCustomerReplyStablePrefix(PERSONA, "intermediate");
    const turn5 = buildCustomerReplyStablePrefix(PERSONA, "intermediate");
    assert.equal(turn1, turn5);

    // And it is genuinely the leading substring of prompts built at different
    // conversation lengths.
    const shortPrompt = buildCustomerReplyPrompt(PERSONA, [], "intermediate");
    const longPrompt = buildCustomerReplyPrompt(PERSONA, transcript, "intermediate");
    assert.ok(shortPrompt.startsWith(turn1));
    assert.ok(longPrompt.startsWith(turn1));
  });

  test("the stable prefix contains no volatile transcript content", () => {
    const stable = buildCustomerReplyStablePrefix(PERSONA, "advanced");
    assert.ok(!stable.includes("lot rent"));
    assert.ok(!stable.includes("Conversation so far:"));
  });
});

import {
  detectCloseIntent,
  closeOutcomeAnchor,
  normalizeCloseOutcome,
  computeConsultingOverall,
  computeEscalationTier,
  escalationAddon,
  CLOSE_OUTCOMES,
  ADVANCE_THRESHOLD,
  WEAK_PROCESS_CAP,
  SOFT_CLOSE_CAP,
  PREMATURE_REFERRAL_CAP,
  REFERRAL_MIN_EFFORT_THRESHOLD,
  MAX_ESCALATION_TIER,
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

// ---------------------------------------------------------------------------
// Beginner leniency — a strong-but-imperfect beginner attempt (good discovery,
// rapport, and close, with one topic like financing raised a little late) must
// land in the low 80s, not the high 70s, WITHOUT letting leniency manufacture a
// qualifying (85+) session. This encodes the founder's spec directly.
// ---------------------------------------------------------------------------

describe("computeConsultingOverall - beginner leniency", () => {
  // The exact profile from the founder's real test: strong discovery + rapport
  // and a natural close the client agreed to, but financing was raised late so
  // objection-prevention took a hit. At intermediate this scores 79; at beginner
  // the timing should barely matter and it should land 80-82.
  const lateFinancing = rubric({
    needsDiscovery: 80,
    objectionPrevention: 60, // dinged for late financing
    trustBuilding: 85,
    naturalClose: 82,
    relationshipContinuity: 80,
  });

  test("the same late-financing attempt scores 79 at intermediate", () => {
    const score = computeConsultingOverall(lateFinancing, "client_agreed", "intermediate");
    assert.equal(score, 79);
  });

  test("the same attempt scores 80-82 at beginner (the founder's target)", () => {
    const score = computeConsultingOverall(lateFinancing, "client_agreed", "beginner");
    assert.ok(score >= 80 && score <= 82, `expected 80-82 at beginner, got ${score}`);
  });

  test("leniency only ever raises a beginner score, never lowers it", () => {
    // Sweep a range of sub-scores; beginner must always be >= intermediate.
    for (let base = 40; base <= 95; base += 5) {
      const r = rubric({ needsDiscovery: base, objectionPrevention: base, trustBuilding: base });
      const beginner = computeConsultingOverall(r, "client_agreed", "beginner");
      const intermediate = computeConsultingOverall(r, "client_agreed", "intermediate");
      assert.ok(beginner >= intermediate, `beginner ${beginner} < intermediate ${intermediate} at base ${base}`);
    }
  });

  test("leniency alone cannot manufacture a qualifying (85+) beginner session", () => {
    // A borderline-strong beginner attempt that computes to the low 80s must stay
    // below the 85 bar after leniency — advancement has to be earned outright.
    const strongButImperfect = rubric({
      needsDiscovery: 82,
      objectionPrevention: 78,
      trustBuilding: 85,
      naturalClose: 85,
      relationshipContinuity: 85,
    });
    const score = computeConsultingOverall(strongButImperfect, "client_agreed", "beginner");
    assert.ok(score < ADVANCE_THRESHOLD, `leniency should not reach the bar, got ${score}`);
  });

  test("a genuinely excellent beginner attempt still qualifies on its own merit", () => {
    const excellent = rubric({
      needsDiscovery: 92,
      objectionPrevention: 90,
      trustBuilding: 92,
      naturalClose: 90,
      relationshipContinuity: 90,
    });
    const score = computeConsultingOverall(excellent, "client_agreed", "beginner");
    assert.ok(score >= ADVANCE_THRESHOLD, `expected >= ${ADVANCE_THRESHOLD}, got ${score}`);
  });

  test("beginner leniency never rescues a weak-process or soft-close attempt", () => {
    const weak = rubric({ needsDiscovery: 40, objectionPrevention: 35, trustBuilding: 45 });
    assert.ok(computeConsultingOverall(weak, "client_agreed", "beginner") <= WEAK_PROCESS_CAP);
    const strong = rubric();
    assert.ok(computeConsultingOverall(strong, "none", "beginner") <= SOFT_CLOSE_CAP);
    assert.ok(computeConsultingOverall(strong, "handoff_no_commitment", "beginner") <= SOFT_CLOSE_CAP);
  });
});

// ---------------------------------------------------------------------------
// Graceful referral — a legitimate high-scoring outcome when EARNED by genuine
// discovery, but capped low when the referral was premature/lazy. Guards against
// abuse: referring out to dodge the work must never score well.
// ---------------------------------------------------------------------------

describe("computeConsultingOverall - graceful referral path", () => {
  test("a graceful referral after a good-faith effort scores well (not a failed close)", () => {
    const goodFaith = rubric({
      needsDiscovery: 82,
      objectionPrevention: 78,
      trustBuilding: 85,
      naturalClose: 85, // graceful handoff
      relationshipContinuity: 85, // pointed them somewhere genuinely helpful
    });
    const referral = computeConsultingOverall(goodFaith, "graceful_referral", "advanced");
    assert.ok(referral >= 80, `earned referral should score well, got ${referral}`);

    // Crucially, the SAME strong discovery ending with no proposal at all ("none")
    // is treated as a soft close and scores far lower — proving the referral is
    // NOT penalized as a failed close.
    const noClose = computeConsultingOverall(goodFaith, "none", "advanced");
    assert.ok(referral > noClose + 20, `referral ${referral} should vastly outscore a no-close ${noClose}`);
  });

  test("an excellent good-faith referral can clear the qualifying bar", () => {
    const excellent = rubric({
      needsDiscovery: 88,
      objectionPrevention: 85,
      trustBuilding: 90,
      naturalClose: 90,
      relationshipContinuity: 90,
    });
    const score = computeConsultingOverall(excellent, "graceful_referral", "advanced");
    assert.ok(score >= ADVANCE_THRESHOLD, `expected >= ${ADVANCE_THRESHOLD}, got ${score}`);
  });

  test("a lazy/premature referral (weak discovery, gave up early) scores LOW", () => {
    const lazy = rubric({
      needsDiscovery: 45,
      objectionPrevention: 40,
      trustBuilding: 42,
      naturalClose: 60,
      relationshipContinuity: 55,
    });
    const score = computeConsultingOverall(lazy, "graceful_referral", "advanced");
    assert.ok(score <= PREMATURE_REFERRAL_CAP, `expected <= ${PREMATURE_REFERRAL_CAP}, got ${score}`);
    assert.ok(score < ADVANCE_THRESHOLD);
  });

  test("the good-faith gate is a real cliff: process just below the bar is still capped", () => {
    // Process of 65 is decent but below the REFERRAL_MIN_EFFORT_THRESHOLD (70):
    // this reads as insufficient effort, so the referral is capped low.
    const belowBar = rubric({
      needsDiscovery: 66,
      objectionPrevention: 64,
      trustBuilding: 65,
      naturalClose: 70,
      relationshipContinuity: 68,
    });
    const below = computeConsultingOverall(belowBar, "graceful_referral", "advanced");
    assert.ok(below <= PREMATURE_REFERRAL_CAP, `below-bar referral should be capped, got ${below}`);

    // Process of exactly the threshold clears the gate and scores well above the cap.
    const atBar = rubric({
      needsDiscovery: REFERRAL_MIN_EFFORT_THRESHOLD,
      objectionPrevention: REFERRAL_MIN_EFFORT_THRESHOLD,
      trustBuilding: REFERRAL_MIN_EFFORT_THRESHOLD,
      naturalClose: 80,
      relationshipContinuity: 80,
    });
    const earned = computeConsultingOverall(atBar, "graceful_referral", "advanced");
    assert.ok(earned > PREMATURE_REFERRAL_CAP, `at-threshold referral should clear the cap, got ${earned}`);
    assert.ok(earned - below > 15, `expected a clear cliff between insufficient and good-faith effort`);
  });
});

// ---------------------------------------------------------------------------
// detectCloseIntent — graceful-referral phrasing must also trigger the
// end-and-score checkpoint (a referral is a way of ending the conversation).
// ---------------------------------------------------------------------------

describe("detectCloseIntent - graceful referral phrasing", () => {
  test("detects 'not the best fit' style referrals", () => {
    assert.equal(detectCloseIntent("Honestly, I don't think we're the best fit for you."), true);
    assert.equal(detectCloseIntent("Let me refer you to someone who can help."), true);
    assert.equal(detectCloseIntent("I can point you toward a colleague who specializes in this."), true);
    assert.equal(detectCloseIntent("You'd be better served by someone who focuses on rentals."), true);
  });

  test("still ignores ordinary discovery questions", () => {
    assert.equal(detectCloseIntent("What would a great outcome look like for you?"), false);
    assert.equal(detectCloseIntent("Tell me more about what's driving the timeline."), false);
  });
});

// ---------------------------------------------------------------------------
// Within-level difficulty escalation ("dangle the carrot") — gradual, one notch
// at a time, kicking in only once the trainee strings together qualifying scores.
// ---------------------------------------------------------------------------

describe("computeEscalationTier", () => {
  test("stays at base until a couple of qualifying sessions are earned", () => {
    assert.equal(computeEscalationTier(0), 0);
    assert.equal(computeEscalationTier(1), 0);
  });

  test("nudges up one notch at a time as mastery accumulates", () => {
    assert.equal(computeEscalationTier(2), 1);
    assert.equal(computeEscalationTier(3), 1);
    assert.equal(computeEscalationTier(4), 2);
    assert.equal(computeEscalationTier(5), 2);
  });

  test("never exceeds the max escalation tier", () => {
    assert.equal(computeEscalationTier(50), MAX_ESCALATION_TIER);
  });
});

describe("escalationAddon + buildCustomerReplyStablePrefix escalation", () => {
  test("tier 0 adds nothing and keeps the prefix byte-identical to the base format", () => {
    assert.equal(escalationAddon(0), "");
    const base = buildCustomerReplyStablePrefix(PERSONA, "advanced");
    const explicitZero = buildCustomerReplyStablePrefix(PERSONA, "advanced", 0);
    assert.equal(base, explicitZero);
    assert.ok(!base.includes("Escalation"));
  });

  test("higher tiers append progressively harder behavioral guidance", () => {
    assert.match(escalationAddon(1), /slightly harder/i);
    assert.match(escalationAddon(2), /noticeably harder/i);
  });

  test("escalation addon is layered into the stable prefix without dropping persona/rules", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "intermediate", 1);
    assert.ok(prefix.includes(PERSONA));
    assert.ok(prefix.includes(CONVERSATION_REALISM_RULES));
    assert.ok(prefix.includes("Escalation"));
  });

  test("clamps out-of-range tiers", () => {
    assert.equal(escalationAddon(-5), "");
    assert.equal(escalationAddon(99), escalationAddon(MAX_ESCALATION_TIER));
  });
});

// ---------------------------------------------------------------------------
// Persona guardedness by difficulty (item 4) — testable at the prompt level:
// beginner personas are forthcoming, intermediate guarded/need rapport, advanced
// skeptical and hidden.
// ---------------------------------------------------------------------------

describe("DIFFICULTY_BEHAVIOR progression (prompt construction)", () => {
  test("beginner personas are forthcoming", () => {
    const p = buildCustomerReplyStablePrefix(PERSONA, "beginner").toLowerCase();
    assert.ok(p.includes("forthcoming") || p.includes("readily"));
  });

  test("intermediate personas are guarded and require rapport", () => {
    const p = buildCustomerReplyStablePrefix(PERSONA, "intermediate").toLowerCase();
    assert.ok(p.includes("guarded"));
    assert.ok(p.includes("rapport"));
  });

  test("advanced personas are skeptical and keep needs hidden", () => {
    const p = buildCustomerReplyStablePrefix(PERSONA, "advanced").toLowerCase();
    assert.ok(p.includes("skeptical"));
    assert.ok(p.includes("hidden"));
  });
});
