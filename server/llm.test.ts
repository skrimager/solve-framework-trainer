import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildCustomerReplyPrompt,
  buildCustomerReplyStablePrefix,
  CONVERSATION_REALISM_RULES,
  computeScoreCacheHash,
  scoreTranscript,
  type ScoreResponder,
  type ScoreCacheStore,
} from "./llm";
import type { TranscriptMessage, ScoreCache, InsertScoreCache } from "@shared/schema";

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
  CONSTRAINED_DEFERRAL_CAP,
  REFERRAL_MIN_EFFORT_THRESHOLD,
  MAX_ESCALATION_TIER,
  closeExpectationForTransactionType,
  anchorForExpectation,
  type CloseOutcome,
  type CloseExpectation,
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
// Constrained-close tiers — when a REAL scheduling constraint (vacation,
// installer availability, materials lead-time) legitimately prevents a same-day
// signature, the score must reflect how well the trainee ENGINEERED a solution
// around the constraint, NOT whether a contract was physically signed. Founder's
// calibration case (windows client going on vacation Wednesday, back in a week):
//   Tier A: "we'll call you when we're back" — vague, nothing locked in (lowest)
//   Tier B: agreed install timeline for the week they return (higher)
//   Tier C: deposit + windows ordered before they leave (highest, ~ same-day)
// ---------------------------------------------------------------------------

describe("computeConsultingOverall - constrained-close tiers", () => {
  // Tier A: real constraint surfaced (decent discovery) but the consultant let it
  // end on a vague deferral with a weak close — a solution-engineering miss.
  const tierA = rubric({
    needsDiscovery: 78,
    objectionPrevention: 72,
    trustBuilding: 76,
    naturalClose: 55,
    relationshipContinuity: 50,
  });
  // Tier B: concrete timeline the client committed to, strong close execution.
  const tierB = rubric({
    needsDiscovery: 85,
    objectionPrevention: 82,
    trustBuilding: 85,
    naturalClose: 85,
    relationshipContinuity: 85,
  });
  // Tier C: deposit + proactive logistics secured before the constraint window.
  const tierC = rubric({
    needsDiscovery: 88,
    objectionPrevention: 85,
    trustBuilding: 88,
    naturalClose: 90,
    relationshipContinuity: 90,
  });

  test("(a) a vague deferral despite a real constraint scores lower-middle — above a total failure, below tiers B/C", () => {
    const deferral = computeConsultingOverall(tierA, "constrained_deferral", "intermediate");
    // A genuine total discovery failure (weak process, no close at all).
    const totalFailure = computeConsultingOverall(
      rubric({ needsDiscovery: 40, objectionPrevention: 35, trustBuilding: 45, naturalClose: 40, relationshipContinuity: 40 }),
      "none",
      "intermediate"
    );
    assert.ok(deferral <= CONSTRAINED_DEFERRAL_CAP, `expected <= ${CONSTRAINED_DEFERRAL_CAP}, got ${deferral}`);
    assert.ok(deferral < ADVANCE_THRESHOLD, `Tier A must not qualify, got ${deferral}`);
    assert.ok(deferral > totalFailure + 15, `Tier A ${deferral} should clearly beat a total failure ${totalFailure}`);
    // A vague deferral is NOT nuked to the soft-close floor: the constraint is real.
    assert.ok(deferral > SOFT_CLOSE_CAP, `Tier A ${deferral} should exceed the soft-close cap ${SOFT_CLOSE_CAP}`);
  });

  test("(b) a concrete timeline-lock around the constraint scores well (no payment needed)", () => {
    const planned = computeConsultingOverall(tierB, "constrained_plan_committed", "intermediate");
    assert.ok(planned >= 80, `Tier B should score well, got ${planned}`);
  });

  test("(c) a deposit-plus-logistics close scores at or near the top tier", () => {
    const deposit = computeConsultingOverall(tierC, "constrained_deposit_secured", "intermediate");
    assert.ok(deposit >= ADVANCE_THRESHOLD, `Tier C should reach the top tier, got ${deposit}`);
  });

  test("the three tiers are strictly, meaningfully ordered A < B < C on identical logic", () => {
    // Hold the rubric constant so ONLY the outcome tier moves the score.
    const r = rubric({ needsDiscovery: 85, objectionPrevention: 85, trustBuilding: 85, naturalClose: 85, relationshipContinuity: 85 });
    const a = computeConsultingOverall(r, "constrained_deferral", "intermediate");
    const b = computeConsultingOverall(r, "constrained_plan_committed", "intermediate");
    const c = computeConsultingOverall(r, "constrained_deposit_secured", "intermediate");
    assert.ok(a < b, `Tier A ${a} should be below Tier B ${b}`);
    assert.ok(b < c, `Tier B ${b} should be below Tier C ${c}`);
    assert.ok(b - a >= 5, `A→B gap should be meaningful, got ${b - a}`);
  });

  test("(d) a normal same-day close (no constraint) is UNAFFECTED and still tops out", () => {
    // Tier C anchors alongside a full same-day agreement — neither is downgraded.
    const sameDay = computeConsultingOverall(
      rubric({ needsDiscovery: 88, objectionPrevention: 85, trustBuilding: 88, naturalClose: 90, relationshipContinuity: 90 }),
      "client_agreed",
      "intermediate"
    );
    assert.ok(sameDay >= ADVANCE_THRESHOLD, `same-day close should stay top-tier, got ${sameDay}`);
    const tierCScore = computeConsultingOverall(tierC, "constrained_deposit_secured", "intermediate");
    assert.equal(sameDay, tierCScore, "Tier C and a full same-day agreement should be scored alike on identical sub-scores");
  });

  test("(e) constrained tiers and the graceful_referral path are independent and don't interfere", () => {
    // Same strong sub-scores routed through each path land where each path dictates.
    const strong = rubric({ needsDiscovery: 85, objectionPrevention: 82, trustBuilding: 85, naturalClose: 85, relationshipContinuity: 85 });
    const referral = computeConsultingOverall(strong, "graceful_referral", "advanced");
    const deposit = computeConsultingOverall(strong, "constrained_deposit_secured", "advanced");
    // Both are legitimate strong outcomes, scored by their OWN logic.
    assert.ok(referral >= 80, `earned referral path should score well, got ${referral}`);
    assert.ok(deposit >= 80, `deposit tier should score well, got ${deposit}`);
    // A constrained deferral is NOT routed through the referral cap: it can exceed
    // PREMATURE_REFERRAL_CAP, proving the two paths are distinct.
    const deferral = computeConsultingOverall(tierA, "constrained_deferral", "advanced");
    assert.ok(deferral > PREMATURE_REFERRAL_CAP, `Tier A ${deferral} should not be capped as a premature referral`);
  });

  test("beginner leniency never rescues a Tier A (constrained deferral) miss to the bar", () => {
    const beginner = computeConsultingOverall(tierA, "constrained_deferral", "beginner");
    assert.ok(beginner < ADVANCE_THRESHOLD, `Tier A must not qualify even at beginner, got ${beginner}`);
    assert.ok(beginner <= CONSTRAINED_DEFERRAL_CAP, `Tier A cap must hold at beginner, got ${beginner}`);
  });

  test("weak discovery still caps a constrained tier — a deposit can't rescue shallow discovery", () => {
    const weak = rubric({ needsDiscovery: 40, objectionPrevention: 35, trustBuilding: 45, naturalClose: 80, relationshipContinuity: 80 });
    const deposit = computeConsultingOverall(weak, "constrained_deposit_secured", "intermediate");
    assert.ok(deposit <= WEAK_PROCESS_CAP, `weak process should still cap Tier C, got ${deposit}`);
  });

  test("all constrained outcomes normalize and stay within 0..100", () => {
    for (const o of ["constrained_deferral", "constrained_plan_committed", "constrained_deposit_secured"] as const) {
      assert.equal(normalizeCloseOutcome(o), o);
      const hi = computeConsultingOverall(rubric({ needsDiscovery: 100, objectionPrevention: 100, trustBuilding: 100, naturalClose: 100, relationshipContinuity: 100 }), o);
      const lo = computeConsultingOverall(rubric({ needsDiscovery: 0, objectionPrevention: 0, trustBuilding: 0, naturalClose: 0, relationshipContinuity: 0 }), o);
      assert.ok(hi >= 0 && hi <= 100);
      assert.ok(lo >= 0 && lo <= 100);
    }
  });
});

// ---------------------------------------------------------------------------
// Real-estate transaction-type-aware close expectations. The internal-only
// scenarios.transactionType picks a close-expectation baseline: "same_day"
// (manufactured COMMUNITY, real-estate LISTING agent) behaves exactly like the
// pre-existing default; "multi_step" (manufactured DEALER, real-estate BUYER'S
// agent) must NOT penalize the absence of a same-day signature and re-anchors a
// committed next step to the top tier. All of this is driven purely by the
// transaction type — never surfaced to the trainee.
// ---------------------------------------------------------------------------

describe("closeExpectationForTransactionType", () => {
  test("dealer and buyer's-agent are the only multi_step types", () => {
    assert.equal(closeExpectationForTransactionType("manufactured_dealer"), "multi_step");
    assert.equal(closeExpectationForTransactionType("re_buyer_agent"), "multi_step");
  });

  test("community and listing-agent stay same_day (top-tier same-day close realistic)", () => {
    assert.equal(closeExpectationForTransactionType("manufactured_community"), "same_day");
    assert.equal(closeExpectationForTransactionType("re_listing_agent"), "same_day");
  });

  test("unknown / null / undefined default to same_day so every non-RE scenario is unchanged", () => {
    assert.equal(closeExpectationForTransactionType(null), "same_day");
    assert.equal(closeExpectationForTransactionType(undefined), "same_day");
    assert.equal(closeExpectationForTransactionType("hvac_service"), "same_day");
    assert.equal(closeExpectationForTransactionType(""), "same_day");
  });
});

describe("anchorForExpectation", () => {
  test("same_day is the identity — base anchors are untouched", () => {
    for (const o of CLOSE_OUTCOMES) {
      assert.equal(anchorForExpectation(o, "same_day"), closeOutcomeAnchor(o), `same_day should not move ${o}`);
    }
  });

  test("multi_step raises ONLY committed-next-step outcomes to the top tier", () => {
    // The two forward-motion outcomes that are the strongest realistic result on
    // a first multi-step conversation get re-anchored up to a full agreement.
    assert.equal(anchorForExpectation("client_asked_next_steps", "multi_step"), 85);
    assert.equal(anchorForExpectation("constrained_plan_committed", "multi_step"), 85);
    // Everything else is identical to same_day — no double-counting, no downgrade.
    for (const o of CLOSE_OUTCOMES) {
      if (o === "client_asked_next_steps" || o === "constrained_plan_committed") continue;
      assert.equal(anchorForExpectation(o, "multi_step"), closeOutcomeAnchor(o), `multi_step must not move ${o}`);
    }
  });
});

describe("computeConsultingOverall - transaction-type close expectations", () => {
  // Strong, uniform discovery/close execution so ONLY the outcome + expectation
  // move the score.
  const strong = rubric();
  const multi: CloseExpectation = "multi_step";
  const same: CloseExpectation = "same_day";

  test("(a) manufactured COMMUNITY: a same-day deposit/agreement scores top tier", () => {
    // Community sells on-site inventory — a same-day close is realistic and tops out.
    assert.equal(closeExpectationForTransactionType("manufactured_community"), same);
    const agreed = computeConsultingOverall(strong, "client_agreed", "intermediate", same);
    const deposit = computeConsultingOverall(strong, "constrained_deposit_secured", "intermediate", same);
    assert.ok(agreed >= ADVANCE_THRESHOLD, `community same-day agreement should qualify, got ${agreed}`);
    assert.ok(deposit >= ADVANCE_THRESHOLD, `community same-day deposit should qualify, got ${deposit}`);
  });

  test("(b) manufactured DEALER: a committed plan (no same-day signature) scores well and qualifies", () => {
    assert.equal(closeExpectationForTransactionType("manufactured_dealer"), multi);
    const committed = computeConsultingOverall(strong, "constrained_plan_committed", "intermediate", multi);
    assert.ok(committed >= ADVANCE_THRESHOLD, `dealer committed plan should qualify without a same-day close, got ${committed}`);
    // Same outcome under the same-day baseline falls just short — proving the
    // dealer profile is what rescues a legitimately longer-cycle close.
    const sameDayEquivalent = computeConsultingOverall(strong, "constrained_plan_committed", "intermediate", same);
    assert.ok(sameDayEquivalent < committed, `multi_step should lift a committed plan above the same_day baseline (${sameDayEquivalent} vs ${committed})`);
  });

  test("(c) real-estate LISTING agent: a same-day listing agreement scores top tier", () => {
    assert.equal(closeExpectationForTransactionType("re_listing_agent"), same);
    const agreed = computeConsultingOverall(strong, "client_agreed", "intermediate", same);
    assert.ok(agreed >= ADVANCE_THRESHOLD, `listing agreement should score top tier, got ${agreed}`);
  });

  test("(d) real-estate BUYER'S agent: multi-visit progression scores well and is NOT penalized for no same-day close", () => {
    assert.equal(closeExpectationForTransactionType("re_buyer_agent"), multi);
    // Client proactively asking for next steps / scheduling the next showing is
    // the top realistic outcome on a first buyer conversation.
    const progression = computeConsultingOverall(strong, "client_asked_next_steps", "advanced", multi);
    assert.ok(progression >= ADVANCE_THRESHOLD, `buyer-agent progression should qualify, got ${progression}`);
    // Under the default same-day baseline the identical conversation falls short —
    // i.e. WITHOUT the buyer-agent profile it would be wrongly penalized.
    const penalized = computeConsultingOverall(strong, "client_asked_next_steps", "advanced", same);
    assert.ok(penalized < ADVANCE_THRESHOLD, `same_day baseline would (wrongly) fall short here, got ${penalized}`);
    assert.ok(progression > penalized, `buyer-agent profile must lift the score, got ${progression} vs ${penalized}`);
  });

  test("(e-1) multi_step does NOT rescue a vague deferral — PR#25 Tier A cap still holds", () => {
    // constrained_deferral is deliberately NOT in the multi_step overrides, so a
    // no-plan ending stays capped even for a longer-cycle deal — no double-count.
    const tierA = rubric({ needsDiscovery: 78, objectionPrevention: 72, trustBuilding: 76, naturalClose: 55, relationshipContinuity: 50 });
    const deferralMulti = computeConsultingOverall(tierA, "constrained_deferral", "intermediate", multi);
    const deferralSame = computeConsultingOverall(tierA, "constrained_deferral", "intermediate", same);
    assert.ok(deferralMulti <= CONSTRAINED_DEFERRAL_CAP, `deferral cap must hold under multi_step, got ${deferralMulti}`);
    assert.equal(deferralMulti, deferralSame, "a vague deferral is unaffected by the transaction type");
  });

  test("(e-2) multi_step leaves the graceful-referral path (PR#24) untouched", () => {
    const strongReferral = rubric({ needsDiscovery: 85, objectionPrevention: 82, trustBuilding: 85 });
    const earnedMulti = computeConsultingOverall(strongReferral, "graceful_referral", "advanced", multi);
    const earnedSame = computeConsultingOverall(strongReferral, "graceful_referral", "advanced", same);
    assert.equal(earnedMulti, earnedSame, "referral scoring is driven by effort, not the transaction type");
    // A premature referral (weak process) stays capped low regardless of expectation.
    const weak = rubric({ needsDiscovery: 40, objectionPrevention: 35, trustBuilding: 45 });
    const premature = computeConsultingOverall(weak, "graceful_referral", "advanced", multi);
    assert.ok(premature <= PREMATURE_REFERRAL_CAP, `premature referral still capped under multi_step, got ${premature}`);
  });

  test("(e-3) weak discovery still caps a multi_step committed plan — the profile can't rescue shallow discovery", () => {
    const weak = rubric({ needsDiscovery: 40, objectionPrevention: 35, trustBuilding: 45, naturalClose: 80, relationshipContinuity: 80 });
    const committed = computeConsultingOverall(weak, "constrained_plan_committed", "intermediate", multi);
    assert.ok(committed <= WEAK_PROCESS_CAP, `weak process must still cap a multi_step close, got ${committed}`);
  });

  test("default expectation arg keeps every existing (non-RE) caller unchanged", () => {
    for (const o of CLOSE_OUTCOMES) {
      const withDefault = computeConsultingOverall(strong, o, "intermediate");
      const explicitSameDay = computeConsultingOverall(strong, o, "intermediate", same);
      assert.equal(withDefault, explicitSameDay, `default must equal same_day for ${o}`);
    }
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

// ---------------------------------------------------------------------------
// scoreTranscript deterministic content-hash cache.
//
// OpenAI's Responses API has no seed parameter and does not guarantee identical
// output even at temperature 0, so identical input can score differently on a
// repeat call. scoreTranscript makes scoring deterministic by construction: it
// hashes the inputs and, on a hit, returns the stored result WITHOUT calling the
// API. These tests inject a spy responder (to count API calls) and an in-memory
// cache (so no Postgres is touched).
// ---------------------------------------------------------------------------

// Minimal in-memory ScoreCacheStore mirroring the storage methods' contract.
function makeInMemoryCache(): ScoreCacheStore & { size: () => number } {
  const rows = new Map<string, ScoreCache>();
  let nextId = 1;
  return {
    async getScoreCacheEntry(contentHash: string) {
      return rows.get(contentHash);
    },
    async createScoreCacheEntry(entry: InsertScoreCache) {
      const row = { id: nextId++, ...entry } as ScoreCache;
      rows.set(entry.contentHash, row);
      return row;
    },
    size: () => rows.size,
  };
}

// A spy responder that counts calls and returns valid scoring JSON. Each call
// returns distinct feedback so we can prove two genuine API calls can differ.
function makeSpyResponder(): ScoreResponder & { calls: () => number } {
  let count = 0;
  const fn = (async () => {
    count += 1;
    return JSON.stringify({
      needsDiscovery: 8,
      objectionPrevention: 7,
      trustBuilding: 9,
      naturalClose: 6,
      relationshipContinuity: 7,
      closeOutcome: "scheduled_next_step",
      feedback: `feedback #${count}`,
    });
  }) as ScoreResponder & { calls: () => number };
  fn.calls = () => count;
  return fn;
}

function turn(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("scoreTranscript - deterministic content-hash cache", () => {
  const baseTranscript = [
    turn("consultant", "Hi, what brings you in today?"),
    turn("customer", "I'm looking at a manufactured home but worried about lot rent."),
    turn("consultant", "Tell me more about that concern."),
  ];

  test("identical input hits the cache: result is reused and the API is called only ONCE", async () => {
    const cache = makeInMemoryCache();
    const responder = makeSpyResponder();

    const first = await scoreTranscript(baseTranscript, "intermediate", "consulting", null, { responder, cache });
    const second = await scoreTranscript(baseTranscript, "intermediate", "consulting", null, { responder, cache });

    assert.equal(responder.calls(), 1, "second identical call must be served from cache, not the API");
    assert.deepEqual(second, first, "cached result must deep-equal the originally computed result");
    assert.equal(cache.size(), 1, "one cache entry for one distinct input");
  });

  test("genuinely different transcript content does NOT collide: API called TWICE, results may differ", async () => {
    const cache = makeInMemoryCache();
    const responder = makeSpyResponder();

    const a = await scoreTranscript(baseTranscript, "intermediate", "consulting", null, { responder, cache });
    // One extra sentence -> different content -> different hash -> cache miss.
    const longer = [...baseTranscript, turn("customer", "Also, can I keep my current lender?")];
    const b = await scoreTranscript(longer, "intermediate", "consulting", null, { responder, cache });

    assert.equal(responder.calls(), 2, "different content must each hit the API (no false-positive collision)");
    assert.equal(cache.size(), 2, "two distinct inputs -> two cache entries");
    assert.notDeepEqual(a.feedback, b.feedback, "independent scorings are free to differ");
  });

  test("a single changed word in the transcript is a cache miss", async () => {
    const cache = makeInMemoryCache();
    const responder = makeSpyResponder();

    await scoreTranscript(baseTranscript, "intermediate", "consulting", null, { responder, cache });
    const edited = [
      baseTranscript[0],
      turn("customer", "I'm looking at a manufactured house but worried about lot rent."),
      baseTranscript[2],
    ];
    await scoreTranscript(edited, "intermediate", "consulting", null, { responder, cache });

    assert.equal(responder.calls(), 2, "one different word must produce a different hash and a fresh API call");
  });

  test("changing only difficulty is a cache miss", async () => {
    const cache = makeInMemoryCache();
    const responder = makeSpyResponder();

    await scoreTranscript(baseTranscript, "intermediate", "consulting", null, { responder, cache });
    await scoreTranscript(baseTranscript, "advanced", "consulting", null, { responder, cache });

    assert.equal(responder.calls(), 2, "same transcript, different difficulty -> different hash -> API called again");
  });

  test("changing only track is a cache miss", async () => {
    const cache = makeInMemoryCache();
    const responder = makeSpyResponder();

    await scoreTranscript(baseTranscript, "intermediate", "consulting", null, { responder, cache });
    await scoreTranscript(baseTranscript, "intermediate", "leadership", null, { responder, cache });

    assert.equal(responder.calls(), 2, "same transcript, different track -> different hash -> API called again");
  });

  test("changing only transactionType is a cache miss", async () => {
    const cache = makeInMemoryCache();
    const responder = makeSpyResponder();

    await scoreTranscript(baseTranscript, "intermediate", "consulting", null, { responder, cache });
    await scoreTranscript(baseTranscript, "intermediate", "consulting", "resale_buyer", { responder, cache });

    assert.equal(responder.calls(), 2, "same transcript, different transactionType -> different hash -> API called again");
  });
});

describe("computeScoreCacheHash - stability and sensitivity", () => {
  const transcript = [
    turn("consultant", "Hello there."),
    turn("customer", "Hi, I have some questions."),
  ];

  test("is stable across calls for byte-identical input", () => {
    const h1 = computeScoreCacheHash(transcript, "intermediate", "consulting", null);
    const h2 = computeScoreCacheHash(transcript, "intermediate", "consulting", null);
    assert.equal(h1, h2);
  });

  test("null and undefined transactionType hash the same (both mean 'no type')", () => {
    const h1 = computeScoreCacheHash(transcript, "intermediate", "consulting", null);
    const h2 = computeScoreCacheHash(transcript, "intermediate", "consulting", undefined);
    assert.equal(h1, h2);
  });

  test("turn order matters (role+content sequence is part of the hash)", () => {
    const reordered = [transcript[1], transcript[0]];
    assert.notEqual(
      computeScoreCacheHash(transcript, "intermediate", "consulting", null),
      computeScoreCacheHash(reordered, "intermediate", "consulting", null),
    );
  });

  test("each of the four inputs independently changes the hash", () => {
    const base = computeScoreCacheHash(transcript, "intermediate", "consulting", null);
    const diffText = computeScoreCacheHash(
      [transcript[0], turn("customer", "Hi, I have a question.")],
      "intermediate",
      "consulting",
      null,
    );
    assert.notEqual(base, diffText);
    assert.notEqual(base, computeScoreCacheHash(transcript, "advanced", "consulting", null));
    assert.notEqual(base, computeScoreCacheHash(transcript, "intermediate", "leadership", null));
    assert.notEqual(base, computeScoreCacheHash(transcript, "intermediate", "consulting", "resale_buyer"));
  });
});
