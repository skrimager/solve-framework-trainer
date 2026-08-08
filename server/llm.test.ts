import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildCustomerReplyPrompt,
  buildCustomerReplyStablePrefix,
  buildTurnStateBlock,
  CONVERSATION_REALISM_RULES,
  CUSTOMER_ROLE_BOUNDARY_RULES,
  HIDDEN_MOTIVATION_DISCOVERY_RULES,
  LOW_KEY_CUSTOMER_CONVERSATION_RULES,
  computeScoreCacheHash,
  scoreTranscript,
  getCustomerReply,
  setCustomerReplyTestResponder,
  streamCustomerReply,
  checkVulgarBaitStrike,
  STALL_DIAGNOSIS_RULES,
  type ScoreResponder,
  type ScoreCacheStore,
} from "./llm";
import { detectVulgarBait, countPriorVulgarStrikes, VULGAR_STRIKE_ONE_REPLY, VULGAR_STRIKE_TWO_REPLY } from "./vulgarBait";
import { personaVariantSeed } from "./personaVariants";
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

describe("CONVERSATION_REALISM_RULES - state awareness and forward motion", () => {
  const rules = CONVERSATION_REALISM_RULES.toLowerCase();

  test("forbids repeating a line verbatim or lightly reworded, with no unmet-want loophole", () => {
    assert.ok(rules.includes("never repeat yourself"));
    assert.ok(rules.includes("lightly reworded"));
    // The old rules allowed re-raising a concern whenever the consultant's last
    // reply "failed to address it", which the model used as license to re-issue
    // the opening demand verbatim. That escape hatch must be gone.
    assert.ok(!rules.includes("unless the consultant's most recent reply"));
  });

  test("requires reacting to the consultant's last move before anything else", () => {
    assert.ok(rules.includes("react, then advance"));
    assert.ok(rules.includes("most recent message"));
    assert.ok(rules.includes("only make sense if the consultant's last message had not happened"));
  });

  test("requires every turn to advance the conversation somewhere new", () => {
    assert.ok(rules.includes("has not been yet"));
    assert.ok(rules.includes("never leave the conversation exactly where you found it"));
  });

  test("covers the state the customer must not contradict", () => {
    // A promise to fetch something is pending, not a fresh reason to re-demand it.
    assert.ok(rules.includes("go get you a number"));
    assert.ok(rules.includes("how long that usually takes"));
    // A number already given cannot be asked for again.
    assert.ok(rules.includes("already been given to you"));
    assert.ok(rules.includes("do not ask for it again"));
    // A question asked must be acknowledged.
    assert.ok(rules.includes("never behave as though no question was asked"));
    // An alternative or budget question must be answered on its own terms.
    assert.ok(rules.includes("respond to that specific thing"));
  });

  test("reinterprets persona 'stay firm' instructions as being about the want, not the wording", () => {
    // Nearly every scenario core ends with a failure branch telling the customer
    // to stay fixed on / keep asking about their opening demand. Those phrases
    // must be neutralized here or they keep producing verbatim loops.
    assert.ok(rules.includes("stay firm"));
    assert.ok(rules.includes("stay fixed on"));
    assert.ok(rules.includes("keep asking"));
    assert.ok(rules.includes("keep steering back"));
    assert.ok(rules.includes("it never means reusing the same sentence"));
  });

  test("preserves the tough-customer behaviors that make the drill worth doing", () => {
    assert.ok(rules.includes("being difficult is good"));
    assert.ok(rules.includes("escalating impatience in new words"));
    assert.ok(rules.includes("is that real or is that a stall?"));
    // Threatening to leave and accepting an honest referral are both wins to keep.
    assert.ok(rules.includes("about to leave"));
    assert.ok(rules.includes("refers you elsewhere"));
    // Reward a consultant who is doing everything right.
    assert.ok(rules.includes("do not stonewall someone who is doing everything right"));
  });
});

describe("buildTurnStateBlock", () => {
  test("is empty before the conversation has started", () => {
    assert.equal(buildTurnStateBlock([]), "");
  });

  test("pins the consultant's most recent message as the thing being replied to", () => {
    const block = buildTurnStateBlock([
      msg("customer", "Just tell me your best out-the-door price."),
      msg("consultant", "Let me message my manager right now to get the real number."),
    ]);
    assert.ok(block.includes("most recent message"));
    assert.ok(block.includes("Let me message my manager right now to get the real number."));
  });

  test("uses the LAST consultant message, not an earlier one", () => {
    const block = buildTurnStateBlock([
      msg("consultant", "What are you driving now?"),
      msg("customer", "A truck."),
      msg("consultant", "Here comes my manager now."),
    ]);
    const latestIdx = block.indexOf("Here comes my manager now.");
    assert.ok(latestIdx >= 0);
    assert.ok(!block.includes("What are you driving now?"));
  });

  test("lists every line the customer has already said as off limits", () => {
    const block = buildTurnStateBlock([
      msg("customer", "Just tell me your best out-the-door price."),
      msg("consultant", "Happy to get that for you."),
      msg("customer", "How long's that usually take?"),
      msg("consultant", "About a minute."),
    ]);
    assert.ok(block.includes("ALREADY said"));
    assert.ok(block.includes("do not reword any of them"));
    assert.ok(block.includes('"Just tell me your best out-the-door price."'));
    assert.ok(block.includes(`"How long's that usually take?"`));
  });

  test("ignores the empty customer placeholder a streamed turn is about to fill", () => {
    const block = buildTurnStateBlock([
      msg("customer", "Just tell me your best out-the-door price."),
      msg("consultant", "Let me get that number."),
      msg("customer", ""),
    ]);
    assert.ok(!block.includes('- ""'));
  });

  test("sits in the volatile tail so the cacheable stable prefix is unchanged", () => {
    const transcript = [
      msg("customer", "Just tell me your best out-the-door price."),
      msg("consultant", "Let me get that number."),
    ];
    const stable = buildCustomerReplyStablePrefix(PERSONA, "beginner");
    const prompt = buildCustomerReplyPrompt(PERSONA, transcript, "beginner");
    assert.ok(prompt.startsWith(stable));
    assert.ok(!stable.includes("Where this conversation stands"));
    assert.ok(prompt.indexOf("Conversation so far:") < prompt.indexOf("Where this conversation stands"));
  });
});

// The exact repro from the auto-sales price-shopper bug report: the customer
// re-demanded the out-the-door price after the consultant had promised to fetch
// it, and again after it had already been quoted. The model call itself is not
// exercised here, but every turn of that conversation is walked through to assert
// the prompt now carries the two facts that make the looping reply impossible to
// justify: what the consultant just did, and that the demand line is spent.
describe("buildCustomerReplyPrompt - auto-sales price-shopper repro", () => {
  const LOOP_LINE = "I just want your best out-the-door price.";
  const conversation = [
    msg("customer", LOOP_LINE),
    msg(
      "consultant",
      "I'm happy to get you the out-the-door price. Let me message my manager right now to get the real number.",
    ),
    msg("customer", "Alright, appreciate that. How long's that usually take?"),
    msg("consultant", "Should be a minute. While we wait, you mentioned your last car gave you trouble, what happened?"),
    msg("customer", "It's a long story. I'd really just like that number when your manager gets back."),
    msg("consultant", "That's exactly why I asked. Here comes my manager now."),
    msg("customer", "Okay good, what'd he say?"),
    msg(
      "consultant",
      "He came back at $15,875 out the door. Given what you told me, does that work against what you had budgeted?",
    ),
  ];

  function promptAfter(turns: number): string {
    return buildCustomerReplyPrompt(PERSONA, conversation.slice(0, turns), "beginner");
  }

  test("turn 1: the pending price promise is the last move, and the demand line is spent", () => {
    const prompt = promptAfter(2);
    assert.ok(prompt.includes("Let me message my manager right now to get the real number."));
    assert.ok(prompt.includes(`"${LOOP_LINE}"`));
    assert.ok(prompt.includes("Do not say any of these again"));
  });

  test("turn 2: the discovery question is the last move while the price is still pending", () => {
    const prompt = promptAfter(4);
    assert.ok(prompt.includes("you mentioned your last car gave you trouble, what happened?"));
    // Both of the customer's earlier lines are now off limits.
    assert.ok(prompt.includes(`"${LOOP_LINE}"`));
    assert.ok(prompt.includes(`"Alright, appreciate that. How long's that usually take?"`));
  });

  test("turn 4: after the price is quoted, the last move is the number plus a budget question", () => {
    const prompt = promptAfter(8);
    assert.ok(prompt.includes("$15,875"));
    assert.ok(prompt.includes("does that work against what you had budgeted?"));
    // The failure the bug report called out: re-demanding the price after it was
    // given. Every customer line so far, including the demand, is now barred.
    for (const said of conversation.filter((m) => m.role === "customer")) {
      assert.ok(prompt.includes(`"${said.content}"`), `should bar reuse of: ${said.content}`);
    }
  });

  test("the full history is present on every turn, not just the latest exchange", () => {
    const prompt = promptAfter(8);
    for (const turn of conversation) {
      assert.ok(prompt.includes(turn.content), `history should include: ${turn.content}`);
    }
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

// ===========================================================================
// Part A: the universal state lines reach the customer prompt
// ===========================================================================

import {
  ACCEPTED_SOLUTION_RULES,
  SPEAKER_ATTRIBUTION_RULES,
  TIMING_FEEDBACK_RULES,
  TRANSCRIPT_FIDELITY_RULES,
  TTS_SPEED,
  hasProposedRecommendation,
  renderTranscriptForScoring,
  transcriptHeaderForScoring,
} from "./llm";

describe("CONVERSATION_REALISM_RULES - universal behavior rules (Rules 2, 4-7)", () => {
  const rules = CONVERSATION_REALISM_RULES;

  test("Rule 2: a properly redirected topic must be dropped after the second redirect", () => {
    assert.match(rules, /STOP ASKING IT/i);
    assert.match(rules, /redirect/i);
  });

  test("Rule 4: the decision structure the consultant uncovers is binding", () => {
    assert.match(rules, /DECISION-MAKING STRUCTURE/i);
    assert.match(rules, /absent/i);
  });

  test("Rule 5: other options may be asked for at most once", () => {
    assert.match(rules, /OTHER OPTIONS AT MOST ONCE/i);
  });

  test("Rule 6: the conversation must be allowed to end", () => {
    assert.match(rules, /LET THE CONVERSATION BE ABLE TO END/i);
  });

  test("Rule 7: difficulty has to evolve rather than repeat", () => {
    assert.match(rules, /EVOLVES/i);
  });

  test("Rule 1 (PR #86) is not regressed by the additions", () => {
    assert.match(rules, /never repeat/i);
  });
});

describe("buildTurnStateBlock - carries the derived conversation state (Rules 2-6)", () => {
  test("a closed deflectable topic is asserted in the state block", () => {
    const block = buildTurnStateBlock([
      turn("customer", "What does the warranty cover?"),
      turn("consultant", "Our service department handles that side of it."),
      turn("customer", "But how long is the warranty good for?"),
      turn("consultant", "The warranty specialist covers that. Let's first nail down what you need."),
    ]);
    assert.match(block, /CLOSED/);
  });

  test("an established decision maker is asserted as fixed", () => {
    const block = buildTurnStateBlock([
      turn("consultant", "Is there anyone else involved in the decision?"),
      turn("customer", "No, it's my decision and I'm paying for it."),
    ]);
    assert.match(block, /now FIXED/);
  });

  test("an accepted solution tells the customer to let the conversation end", () => {
    const block = buildTurnStateBlock([
      turn("consultant", "Based on what you've told me, I'd recommend the compact."),
      turn("customer", "That sounds right, that's exactly what we need."),
    ]);
    assert.match(block, /ALREADY said the proposed solution fits/);
  });

  test("a conversation with none of these situations is byte-identical to the PR #86 behavior", () => {
    const plain = [
      turn("consultant", "What brings you in today?"),
      turn("customer", "Just starting to look around."),
    ];
    const block = buildTurnStateBlock(plain);
    assert.doesNotMatch(block, /CLOSED|now FIXED|alternatives round|ALREADY said the proposed/);
  });

  test("the state block stays in the volatile tail, never in the cacheable prefix", () => {
    const transcript = [
      turn("consultant", "I'd recommend the compact."),
      turn("customer", "That works for us."),
    ];
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "intermediate");
    const prompt = buildCustomerReplyPrompt(PERSONA, transcript, "intermediate");
    assert.ok(prompt.startsWith(prefix));
    assert.doesNotMatch(prefix, /ALREADY said the proposed solution fits/);
    assert.match(prompt, /ALREADY said the proposed solution fits/);
  });
});

// ===========================================================================
// Part B: scoring accuracy (Rules 8-10)
// ===========================================================================

describe("renderTranscriptForScoring - speaker attribution (Rule 9)", () => {
  test("every turn is numbered and prefixed with an explicit speaker label", () => {
    const rendered = renderTranscriptForScoring([
      turn("customer", "How can I make sure I'm getting something that'll hold up?"),
      turn("consultant", "That's a fair thing to want."),
    ]);
    assert.equal(
      rendered,
      "[1] CUSTOMER: How can I make sure I'm getting something that'll hold up?\n" +
        "[2] CONSULTANT: That's a fair thing to want.",
    );
  });

  test("a multi-line turn is collapsed so no line is left unlabeled", () => {
    // The exact shape of the reported failure: an unlabeled continuation line
    // could be read as the other speaker.
    const rendered = renderTranscriptForScoring([
      turn("customer", "I've been burned before.\nHow do I know this will hold up?"),
    ]);
    assert.equal(rendered.split("\n").length, 1);
    assert.match(rendered, /^\[1\] CUSTOMER: /);
  });

  test("the empty placeholder a streamed turn is about to fill is dropped", () => {
    const rendered = renderTranscriptForScoring([
      turn("consultant", "What brings you in?"),
      turn("customer", "   "),
    ]);
    assert.equal(rendered, "[1] CONSULTANT: What brings you in?");
  });

  test("labels are overridable for the coach's trainee-facing framing", () => {
    const rendered = renderTranscriptForScoring([turn("consultant", "Tell me more.")], {
      customer: "CUSTOMER",
      consultant: "TRAINEE",
    });
    assert.equal(rendered, "[1] TRAINEE: Tell me more.");
  });

  test("the header states the real turn count so the grader reads the whole transcript", () => {
    const header = transcriptHeaderForScoring([
      turn("customer", "One."),
      turn("consultant", "Two."),
      turn("customer", "   "),
    ]);
    assert.match(header, /2 turns/);
    assert.match(header, /authoritative/);
    assert.match(header, /Read all 2 turns/);
  });
});

describe("the shared scoring-accuracy blocks (Rules 8-10)", () => {
  test("Rule 9: attribution is stated as non-negotiable and credit is turn-gated", () => {
    assert.match(SPEAKER_ATTRIBUTION_RULES, /NON-NEGOTIABLE/);
    assert.match(SPEAKER_ATTRIBUTION_RULES, /CONSULTANT/);
  });

  test("Rule 10: the grader may not claim the consultant skipped something they did", () => {
    assert.match(TRANSCRIPT_FIDELITY_RULES, /Never state that the consultant failed to do something they demonstrably did/);
  });

  test("Rule 8: an accepted solution is a success and no close may be required", () => {
    assert.match(ACCEPTED_SOLUTION_RULES, /client_agreed/);
    assert.match(ACCEPTED_SOLUTION_RULES, /paperwork/i);
    assert.match(ACCEPTED_SOLUTION_RULES, /haven't presented a solution yet/);
  });

  test("Rule 8 explicitly refuses to lower the bar anywhere else (guardrail)", () => {
    assert.match(ACCEPTED_SOLUTION_RULES, /does not lower the bar/i);
  });
});

// A verified ending: the consultant paints how the solution fits what was
// discussed, explicitly asks whether anything is still missing, and the customer
// explicitly confirms nothing is. The taxonomy classifies that as "client_agreed"
// exactly like a bare "yes, let's do it", so both share the 85 anchor and the
// only place the extra rigor could show up is the discovery dimensions. Nothing
// told the grader to look for it there, so it was credited by chance or not at
// all. This is a recognition instruction only: no weight, anchor, cap, or
// threshold moves, and the pattern's absence is explicitly not a deduction.
describe("ACCEPTED_SOLUTION_RULES - crediting a verified 'nothing missing' ending", () => {
  test("an explicit gap-check plus an explicit confirmation is named as the stronger ending", () => {
    assert.match(ACCEPTED_SOLUTION_RULES, /anything we haven't covered/);
    assert.match(ACCEPTED_SOLUTION_RULES, /materially stronger ending than a bare "yes, let's do it"/);
    assert.match(ACCEPTED_SOLUTION_RULES, /verified WITH the customer rather than assumed/);
    // Credited inside the dimensions that already score discovery quality.
    assert.match(ACCEPTED_SOLUTION_RULES, /in needsDiscovery/);
    assert.match(ACCEPTED_SOLUTION_RULES, /in naturalClose/);
  });

  test("the credit is gated on real discovery and its absence is not a deduction", () => {
    assert.match(ACCEPTED_SOLUTION_RULES, /earned, never automatic, and its absence is never a deduction/);
    assert.match(ACCEPTED_SOLUTION_RULES, /asked "anything else\?" has verified nothing/);
    assert.match(ACCEPTED_SOLUTION_RULES, /never mark down a conversation that ended in a clear agreement without it/);
  });

  test("no number moves: the only route to a higher score is a higher sub-score", () => {
    // Guardrail. A bare agreement and a verified one still share one anchor, and
    // there is no separate bonus path, so the extra credit has to be earned in
    // the discovery dimensions the grader must justify from the transcript.
    assert.equal(closeOutcomeAnchor("client_agreed"), 85);
    const bare = rubric({ needsDiscovery: 80, naturalClose: 80 });
    const verified = rubric({ needsDiscovery: 88, naturalClose: 88 });
    assert.ok(
      computeConsultingOverall(verified, "client_agreed") >
        computeConsultingOverall(bare, "client_agreed"),
    );
  });
});

// Rule 11. The live failure: "you needed to talk about financing earlier in the
// conversation" written about a transcript in which the rep asked about budget,
// cash-versus-financing, and a trade-in a few turns in. Two defects in one
// sentence: an unchecked claim, and advice with no real moment attached.
describe("TIMING_FEEDBACK_RULES - transcript-grounded timing claims (Rule 11)", () => {
  test("the claim must be checked against the trainee's own turns before it is made", () => {
    assert.match(TIMING_FEEDBACK_RULES, /BEFORE you say a topic was missing or late/);
    assert.match(TIMING_FEEDBACK_RULES, /timing pre-check/);
  });

  test("a topic raised early is off limits as a timing criticism, hedges included", () => {
    assert.match(TIMING_FEEDBACK_RULES, /If it was raised EARLY, its timing is not a coaching point/);
    assert.match(TIMING_FEEDBACK_RULES, /do not soften the same claim into a hedge/);
  });

  test("legitimate timing feedback must attach to a real customer moment", () => {
    assert.match(TIMING_FEEDBACK_RULES, /attach the suggestion to a specific real moment the CUSTOMER created/);
    assert.match(TIMING_FEEDBACK_RULES, /"earlier in the conversation" is not acceptable/);
    assert.match(TIMING_FEEDBACK_RULES, /Never invent one/);
  });

});

describe("scoreTranscript - the timing pre-check reaches the model (Rule 11)", () => {
  function capture() {
    let seen = "";
    let key = "";
    const responder: ScoreResponder = async (input, promptCacheKey) => {
      seen = input;
      key = promptCacheKey;
      return JSON.stringify({
        needsDiscovery: 80,
        objectionPrevention: 80,
        trustBuilding: 80,
        naturalClose: 80,
        relationshipContinuity: 80,
        closeOutcome: "client_agreed",
        feedback: "ok",
      });
    };
    return { responder, input: () => seen, cacheKey: () => key };
  }

  // The reported scenario: the customer names wanting more comfort and the rep
  // asks about budget, cash-versus-financing, and a trade-in on the next turn.
  const comfortThenBudget = [
    turn("consultant", "What brings you in today?"),
    turn("customer", "I want something with more comfort for my commute."),
    turn("consultant", "What does your budget look like, and are you paying cash or financing? Any trade-in?"),
    turn("customer", "Financing, around twenty five thousand, and yes I have a trade-in."),
    turn("consultant", "Based on what you've told me, I'd recommend the midsize sedan."),
    turn("customer", "That sounds right, that's exactly what we need."),
  ];

  test("the consulting rubric is told financing was already covered, and covered early", async () => {
    const cap = capture();
    await scoreTranscript(comfortThenBudget, "beginner", "consulting", null, {
      responder: cap.responder,
      cache: makeInMemoryCache(),
    });
    assert.ok(cap.input().includes(TIMING_FEEDBACK_RULES));
    assert.match(cap.input(), /TIMING PRE-CHECK/);
    assert.match(cap.input(), /ALREADY COVERED, and covered early/);
    assert.match(cap.input(), /The CONSULTANT raised it themselves at turn 3 of 6/);

    // The old instruction told the grader to explain why raising budget/financing
    // earlier helps whenever the topic appeared, with nothing gating it on the
    // topic having actually been late. That is what produced the false claim.
    assert.match(cap.input(), /do not write anything about the TIMING of a topic/);
    assert.match(
      cap.input(),
      /if it was raised early, credit that and say nothing about when it happened/,
    );
  });

  test("the pre-check follows the transcript and stays out of the cacheable prefix", async () => {
    const cap = capture();
    await scoreTranscript(comfortThenBudget, "beginner", "consulting", null, {
      responder: cap.responder,
      cache: makeInMemoryCache(),
    });
    const input = cap.input();
    assert.ok(input.indexOf("[1] CONSULTANT:") < input.indexOf("TIMING PRE-CHECK"));

    // Per-session facts must not fragment the prompt cache: two different
    // transcripts at the same track/difficulty still route to one cache key.
    const other = capture();
    await scoreTranscript(
      [turn("consultant", "What brings you in?"), turn("customer", "Just looking.")],
      "beginner",
      "consulting",
      null,
      { responder: other.responder, cache: makeInMemoryCache() },
    );
    assert.equal(other.cacheKey(), cap.cacheKey());
    assert.ok(!other.input().includes("ALREADY COVERED"));
  });

  test("leadership scoring is unchanged: no money-topic pre-check", async () => {
    const cap = capture();
    await scoreTranscript(comfortThenBudget, "beginner", "leadership", null, {
      responder: cap.responder,
      cache: makeInMemoryCache(),
    });
    assert.ok(!cap.input().includes("TIMING PRE-CHECK"));
  });
});

describe("scoreTranscript - the accuracy blocks reach the model (both tracks)", () => {
  function capture() {
    let seen = "";
    const responder: ScoreResponder = async (input) => {
      seen = input;
      return JSON.stringify({
        needsDiscovery: 8,
        objectionPrevention: 8,
        trustBuilding: 8,
        naturalClose: 8,
        relationshipContinuity: 8,
        deEscalation: 8,
        empathy: 8,
        boundarySetting: 8,
        resolutionPath: 8,
        professionalism: 8,
        closeOutcome: "client_agreed",
        feedback: "ok",
      });
    };
    return { responder, input: () => seen };
  }

  const transcript = [
    turn("consultant", "What brings you in today?"),
    turn("customer", "How can I make sure I'm getting something that'll hold up?"),
    turn("consultant", "Based on what you've told me, I'd recommend the compact."),
    turn("customer", "That sounds right, that's exactly what we need."),
  ];

  test("the consulting rubric carries attribution, fidelity, and accepted-solution rules", async () => {
    const cap = capture();
    await scoreTranscript(transcript, "intermediate", "consulting", null, {
      responder: cap.responder,
      cache: makeInMemoryCache(),
    });
    assert.ok(cap.input().includes(SPEAKER_ATTRIBUTION_RULES));
    assert.ok(cap.input().includes(TRANSCRIPT_FIDELITY_RULES));
    assert.ok(cap.input().includes(ACCEPTED_SOLUTION_RULES));
  });

  test("the leadership rubric carries attribution and fidelity too", async () => {
    const cap = capture();
    await scoreTranscript(transcript, "intermediate", "leadership", null, {
      responder: cap.responder,
      cache: makeInMemoryCache(),
    });
    assert.ok(cap.input().includes(SPEAKER_ATTRIBUTION_RULES));
    assert.ok(cap.input().includes(TRANSCRIPT_FIDELITY_RULES));
  });

  test("the transcript is sent in the labeled, numbered form with a turn-count header", async () => {
    const cap = capture();
    await scoreTranscript(transcript, "intermediate", "consulting", null, {
      responder: cap.responder,
      cache: makeInMemoryCache(),
    });
    assert.ok(cap.input().includes(transcriptHeaderForScoring(transcript)));
    assert.ok(
      cap.input().includes(
        "[2] CUSTOMER: How can I make sure I'm getting something that'll hold up?",
      ),
      "the customer's question must be labeled as the customer's",
    );
  });

  test("the accuracy blocks sit in the stable prefix, ahead of the volatile transcript", async () => {
    const cap = capture();
    await scoreTranscript(transcript, "intermediate", "consulting", null, {
      responder: cap.responder,
      cache: makeInMemoryCache(),
    });
    const input = cap.input();
    assert.ok(input.indexOf(SPEAKER_ATTRIBUTION_RULES) < input.indexOf("[1] CONSULTANT:"));
  });
});

describe("hasProposedRecommendation - accepted solution short-circuit (Rule 8)", () => {
  test("an accepted proposal returns true with no API call", async () => {
    // No responder seam here, so reaching the network would throw on the dummy
    // key. Passing proves the deterministic short-circuit fired.
    const result = await hasProposedRecommendation([
      turn("consultant", "Based on everything you've told me, I'd recommend the compact."),
      turn("customer", "That sounds right, that's exactly what we need."),
    ]);
    assert.equal(result, true);
  });

  test("an empty consultant side is still false without an API call", async () => {
    assert.equal(await hasProposedRecommendation([turn("customer", "Hello?")]), false);
  });
});

// ===========================================================================
// Part C, Bug 3: TTS delivery
// ===========================================================================

describe("TTS_SPEED (Bug 3: robotic delivery)", () => {
  test("speech is not time-compressed by default", () => {
    // Playing every persona back faster than recorded is what read as clipped and
    // announcer-like; natural pacing comes from an unmodified rate.
    assert.equal(TTS_SPEED, 1.0);
  });
});

// ===========================================================================
// "Customer must be reasonable" (this PR). Rules A-F.
//
// The failure these cover is not that the customer was tough, it is that it was
// impossible: it demanded engineering internals, demanded guarantees nobody can
// give, argued a two-cent gap on a $14,000 budget the rep had already covered,
// and never reached an ending. The customer-side fix is a single prompt block
// composed into the SHARED stable prefix; the scoring-side fix is a single block
// composed into the shared rubric. These tests assert both, plus the anchors and
// caps that must NOT have moved.
// ===========================================================================

import { GRACEFUL_RELEASE_RULES, REASONABLE_CUSTOMER_RULES } from "./llm";
import { deriveConversationState, hasCustomerAcceptedProposal } from "./conversationState";

describe("REASONABLE_CUSTOMER_RULES - reaches every customer prompt", () => {
  test("it is embedded in the customer prompt at every difficulty", () => {
    for (const difficulty of ["beginner", "intermediate", "advanced"]) {
      const prompt = buildCustomerReplyPrompt(PERSONA, [], difficulty);
      assert.ok(
        prompt.includes(REASONABLE_CUSTOMER_RULES),
        `${difficulty} must inherit the reasonable-customer rules`,
      );
    }
  });

  test("it survives escalation, which is exactly when the customer got unwinnable", () => {
    for (const tier of [0, 1, 2]) {
      const prompt = buildCustomerReplyPrompt(PERSONA, [], "advanced", tier);
      assert.ok(prompt.includes(REASONABLE_CUSTOMER_RULES), `tier ${tier} must inherit it`);
    }
  });

  test("an unrecognized difficulty still inherits it (no silent bypass)", () => {
    assert.ok(
      buildCustomerReplyPrompt(PERSONA, [], "nonsense-level").includes(REASONABLE_CUSTOMER_RULES),
    );
  });

  test("it lives in the cacheable stable prefix, not the volatile tail", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.ok(prefix.includes(REASONABLE_CUSTOMER_RULES));
    const prompt = buildCustomerReplyPrompt(PERSONA, [turn("consultant", "Hi there.")], "advanced", 2);
    assert.ok(prompt.indexOf(REASONABLE_CUSTOMER_RULES) < prompt.indexOf("Conversation so far:"));
  });

  test("it comes AFTER the difficulty behavior and the realism rules, so it is the final word", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.ok(
      prefix.indexOf(CONVERSATION_REALISM_RULES) < prefix.indexOf(REASONABLE_CUSTOMER_RULES),
      "the reasonableness bound must be read last to override 'do not make it easy'",
    );
    assert.match(REASONABLE_CUSTOMER_RULES, /take precedence over any instruction above/i);
  });
});

describe("REASONABLE_CUSTOMER_RULES - Rules A-E content", () => {
  const rules = REASONABLE_CUSTOMER_RULES;

  test("Rule A: an honest referral to the right expert is the correct answer and must be accepted", () => {
    assert.match(rules, /STAY INSIDE WHAT THIS PERSON CAN ANSWER/);
    assert.match(rules, /mechanic/i);
    assert.match(rules, /that is the CORRECT answer/);
    assert.match(rules, /never re-ask it in different words/i);
    assert.match(rules, /never treat an honest referral as a dodge/i);
  });

  test("Rule B: impossible guarantees are out, honest reassurance plus the warranty path is in", () => {
    assert.match(rules, /DO NOT ASK FOR PROMISES NOBODY CAN HONESTLY MAKE/);
    assert.match(rules, /Nothing in life is guaranteed never to fail/i);
    assert.match(rules, /warranty, service coverage, loaner\/backup option, or guarantee/i);
    assert.match(rules, /your worry HAS been addressed, in full, regardless of which specific wording/);
  });

  test("Rule B generalizes beyond engine reliability to any zero-risk demand (downtime, breakdowns, delays, recurrence)", () => {
    // This is the fix for the Vince transcript: "my business won't suffer
    // downtime" and "my car won't need repairs" are the same demand in
    // different words, not two different topics, and Rule B's text must say
    // so explicitly rather than only ever mentioning engines.
    assert.match(rules, /ANY zero-risk guarantee, not just engine reliability/);
    assert.match(rules, /no downtime, no breakdowns, no repairs, no delays, no missed deadlines, no recurrence/i);
  });

  test("Rule B closes after at most one more pass, matching Rule A/C's close-out pattern", () => {
    // Rules A and C already have an explicit "answered, so stop asking"
    // mechanic ("never re-ask it in different words", "that specific is
    // FINISHED"). Rule B was missing the equivalent, which is why a customer
    // could keep re-demanding a guarantee in new words forever. This asserts
    // the same shape now exists on Rule B specifically.
    assert.match(rules, /you get exactly ONE more pass/);
    assert.match(rules, /the topic is CLOSED PERMANENTLY: never ask for that guarantee again in any wording/);
    assert.match(rules, /refusing to accept an honest answer, and it is forbidden/);
  });

  test("Rule C: an invited specific must be answerable, and is finished once answered", () => {
    assert.match(rules, /WHEN THEY INVITE SPECIFICS, NAME AN ANSWERABLE ONE/);
    assert.match(rules, /Do not answer with an interrogation they cannot pass/);
    assert.match(rules, /that specific is FINISHED/);
    assert.match(rules, /Do not re-ask it harder/);
  });

  test("Rule D (prompt half): a met number is settled, including a covered trivial gap", () => {
    assert.match(rules, /WHEN THEY MEET WHAT YOU ASKED FOR, SAY SO/);
    assert.match(rules, /two-cent gap on a fourteen-thousand-dollar number/i);
    assert.match(rules, /Haggling over a rounding error/i);
  });

  test("Rule E: exactly two honest endings, and no third looping one", () => {
    assert.match(rules, /THERE ARE EXACTLY TWO HONEST ENDINGS/);
    assert.match(rules, /You got what you needed/);
    assert.match(rules, /You did not get what you needed/);
    assert.match(rules, /no third ending in which you re-demand the same thing forever/i);
    assert.match(rules, /releases you graciously, take that well/i);
  });

  test("guardrail: toughness is preserved in words, not just spirit", () => {
    // The block must not read as "be agreeable". It has to keep the customer
    // guarded and route pressure into the persona's real worry, which is HARDER
    // to answer than a technicality, not easier.
    assert.match(rules, /Being hard to satisfy is realistic and wanted/);
    assert.match(rules, /Stay guarded, stay skeptical, make the consultant earn it/);
    assert.match(rules, /PUSH BACK WITH YOUR REAL WORRY, NOT A RIDDLE/);
    assert.match(rules, /stronger pressure, not weaker/);
  });

  test("guardrail: the difficulty and escalation instructions themselves are untouched", () => {
    // The fix is additive. If it had been implemented by softening these, a hard
    // customer would have stopped being hard.
    const advanced = buildCustomerReplyStablePrefix(PERSONA, "advanced", 0);
    assert.match(advanced, /Push back hard on price and value/);
    assert.match(advanced, /Do not make it easy/);
    assert.match(escalationAddon(2), /tougher objection/i);
  });

  test("tier 2 escalation cannot be satisfied by re-raising a Rule-B-closed guarantee demand", () => {
    // Tier 2 escalation ("surface a tougher objection") had no exception for
    // topics REASONABLE_CUSTOMER_RULES already resolved, so escalation could
    // read as license to re-raise a guarantee demand in a new wording to
    // satisfy "tougher". This asserts the explicit carve-out exists.
    assert.match(escalationAddon(2), /must still be a NEW one/);
    assert.match(escalationAddon(2), /never a Rule-B-governed guarantee demand you have already had answered and closed out/);
  });
});

describe("GRACEFUL_RELEASE_RULES - Rule F, scoring recognition", () => {
  test("a graceful release is classified as graceful_referral, not a missing ending", () => {
    assert.match(GRACEFUL_RELEASE_RULES, /RELEASING A CUSTOMER YOU CANNOT HONESTLY SERVE IS A WIN/);
    assert.match(GRACEFUL_RELEASE_RULES, /graceful_referral/);
    assert.match(GRACEFUL_RELEASE_RULES, /Do NOT classify it as "handoff_no_commitment" or "none"/);
  });

  test("declining an impossible promise is scored as a correct answer, not a gap", () => {
    assert.match(GRACEFUL_RELEASE_RULES, /DECLINING TO PROMISE THE IMPOSSIBLE IS A CORRECT ANSWER/);
    assert.match(GRACEFUL_RELEASE_RULES, /Never deduct for refusing to make a promise no honest person could make/);
  });

  test("referring an out-of-scope technical question is scored as a correct answer", () => {
    assert.match(GRACEFUL_RELEASE_RULES, /REFERRING A GENUINELY OUT-OF-SCOPE TECHNICAL QUESTION/);
    assert.match(GRACEFUL_RELEASE_RULES, /Do not read it as dodging/);
  });

  test("the consultant is never criticized merely for not closing an impossible customer", () => {
    assert.match(GRACEFUL_RELEASE_RULES, /not closing/i);
  });

  test("guardrail: it explicitly refuses to lower any bar", () => {
    assert.match(GRACEFUL_RELEASE_RULES, /None of this lowers any bar/i);
    assert.match(GRACEFUL_RELEASE_RULES, /has NOT earned this reading/);
  });

  test("guardrail: no anchor, gate, or cap moved", () => {
    // Rule F is a RECOGNITION fix. The numbers that decide whether a referral was
    // earned are the ones PR #87 shipped, unchanged.
    assert.equal(closeOutcomeAnchor("graceful_referral"), 85);
    assert.equal(REFERRAL_MIN_EFFORT_THRESHOLD, 70);
    assert.equal(PREMATURE_REFERRAL_CAP, 55);
    assert.equal(SOFT_CLOSE_CAP, 55);
    assert.equal(WEAK_PROCESS_CAP, 64);
    assert.equal(CONSTRAINED_DEFERRAL_CAP, 72);
  });

  test("guardrail: a lazy referral is still capped, so Rule F cannot be gamed", () => {
    const lazy = computeConsultingOverall(
      rubric({ needsDiscovery: 40, objectionPrevention: 40, trustBuilding: 45, naturalClose: 40, relationshipContinuity: 45 }),
      "graceful_referral",
      "intermediate",
    );
    assert.ok(lazy <= PREMATURE_REFERRAL_CAP, `a referral with no discovery effort must stay capped, got ${lazy}`);
  });

  test("an EARNED release still scores high, which is the point of Rule F", () => {
    const earned = computeConsultingOverall(
      rubric({ needsDiscovery: 88, objectionPrevention: 85, trustBuilding: 90, naturalClose: 80, relationshipContinuity: 88 }),
      "graceful_referral",
      "intermediate",
    );
    assert.ok(earned >= 80, `a competent graceful release must score high, got ${earned}`);
  });

  test("it reaches the consulting rubric prompt the scorer actually sees", async () => {
    let seen = "";
    const responder: ScoreResponder = async (input) => {
      seen = input;
      return JSON.stringify({
        needsDiscovery: 8,
        objectionPrevention: 8,
        trustBuilding: 8,
        naturalClose: 8,
        relationshipContinuity: 8,
        closeOutcome: "graceful_referral",
        feedback: "ok",
      });
    };
    await scoreTranscript(
      [
        turn("consultant", "What are you hoping this solves for you?"),
        turn("customer", "Guarantee me the engine will never fail."),
        turn("consultant", "I can't promise that honestly. I don't think I'm the best fit here."),
      ],
      "advanced",
      "consulting",
      null,
      { responder, cache: makeInMemoryCache() },
    );
    assert.ok(seen.includes(GRACEFUL_RELEASE_RULES));
  });
});

describe("STALL_DIAGNOSIS_RULES - scoring stalls and objections as diagnostic moments", () => {
  test("defines the decision-first philosophy and applies it throughout SOLVE", () => {
    assert.match(STALL_DIAGNOSIS_RULES, /better decision than they would have made without them/);
    assert.match(STALL_DIAGNOSIS_RULES, /not only near a close/);
    assert.match(STALL_DIAGNOSIS_RULES, /Situation, Open, Listen, Visualize Success, Engineer, Confirm, and Solve/);
    assert.match(STALL_DIAGNOSIS_RULES, /I don't know, I'll have to talk to my wife about that/);
  });

  test("requires validation and investigation instead of defensive assumptions", () => {
    assert.match(STALL_DIAGNOSIS_RULES, /Never answer an assumption/);
    assert.match(STALL_DIAGNOSIS_RULES, /What are you comparing us against/);
    assert.match(STALL_DIAGNOSIS_RULES, /Validate before investigating/);
    assert.match(STALL_DIAGNOSIS_RULES, /lets the customer name the specific concern/);
    assert.match(STALL_DIAGNOSIS_RULES, /us versus the decision/);
  });

  test("rewards the unconsulted-stakeholder process and concise communication", () => {
    assert.match(STALL_DIAGNOSIS_RULES, /validate the stall completely without resisting it/);
    assert.match(STALL_DIAGNOSIS_RULES, /use a branching hypothetical to narrow the real concern/);
    assert.match(STALL_DIAGNOSIS_RULES, /the skill being tested is the process of drawing the concern out/);
    assert.match(STALL_DIAGNOSIS_RULES, /one good question, then silence/);
    assert.match(STALL_DIAGNOSIS_RULES, /defending price before understanding the comparison/);
  });

  test("reaches the consulting rubric prompt the scorer actually sees", async () => {
    let seen = "";
    const responder: ScoreResponder = async (input) => {
      seen = input;
      return JSON.stringify({
        needsDiscovery: 80,
        objectionPrevention: 80,
        trustBuilding: 80,
        naturalClose: 80,
        relationshipContinuity: 80,
        closeOutcome: "recommendation_made",
        feedback: "ok",
      });
    };
    await scoreTranscript(
      [
        turn("consultant", "What are you comparing us against?"),
        turn("customer", "I need to talk to my partner first."),
      ],
      "intermediate",
      "consulting",
      null,
      { responder, cache: makeInMemoryCache() },
    );
    assert.ok(seen.includes(STALL_DIAGNOSIS_RULES));
    assert.match(seen, /Score the quality of that process, not whether it produced a yes/);
  });
});

describe("detectCloseIntent - a graceful RELEASE ends the session too", () => {
  // These phrasings inverted the word order the old "best fit" patterns expected,
  // so the worked example's release never tripped the end-and-score checkpoint and
  // the session silently stayed open, which is itself a way the conversation could
  // never end.
  test("release phrasings are recognized", () => {
    assert.equal(
      detectCloseIntent("I'd rather you go find what fits you best, and if that changes, come see me."),
      true,
    );
    assert.equal(detectCloseIntent("Go find something that works for you better."), true);
    assert.equal(
      detectCloseIntent("I might not be able to give you the guarantee you're after."),
      true,
    );
    assert.equal(detectCloseIntent("Come back to me if anything changes."), true);
  });

  test("ordinary discovery is still not a close", () => {
    assert.equal(detectCloseIntent("What would you need this to do for you?"), false);
    assert.equal(detectCloseIntent("Tell me what went wrong with the last one."), false);
    assert.equal(detectCloseIntent("Does that work for you so far?"), false);
  });
});

// The spec's worked example, end to end at the deterministic layer: the auto
// scenario with a $14,000 budget met at $14,000.02 with the two cents covered, an
// engine-internals question that should get a mechanic referral, and a "how do I
// know it won't break down" question that should get honest reassurance plus the
// warranty path.
describe("worked example (spec): auto scenario, $14,000 budget", () => {
  const TRANSCRIPT = [
    turn("consultant", "What brings you in today?"),
    turn("customer", "I need something reliable. My budget is $14,000 and I can't go over that."),
    turn("consultant", "Understood. What went wrong with the last one?"),
    turn("customer", "It left me stranded twice. What are the internal engine tolerances on this one?"),
    turn(
      "consultant",
      "Honestly, that's a question for our mechanic, and I'll walk you back and have him go through it with you. What I can tell you is it's newer, lower miles, and it passed our inspection.",
    ),
    turn("customer", "Okay. But how do I know it won't break down on me?"),
    turn(
      "consultant",
      "I can't promise you no car ever breaks, and I won't pretend otherwise. What I can tell you is this one is in far better shape than what you had, and the warranty is how you protect yourself against a surprise repair bill.",
    ),
    turn("customer", "That's fair."),
    turn(
      "consultant",
      "Based on everything you've told me, I'd recommend this one. Out the door with tax, tag, and title it's $14,000.02, and I'll cover the two cents, so you're right at your number.",
    ),
    turn("customer", "Then that works for me. Let's do it."),
  ];

  test("success test 1 (deterministic): the two-cent gap is recognized as the budget being MET", () => {
    const state = deriveConversationState(TRANSCRIPT);
    assert.ok(state.metNeed, "the met budget must be detected");
    assert.equal(state.metNeed!.statedAmount, 14000);
    assert.equal(state.metNeed!.quotedAmount, 14000.02);
    assert.equal(state.metNeed!.gapClosed, true);
  });

  test("success test 1 (deterministic): the customer is told, in its own prompt, that the need is met", () => {
    const block = buildTurnStateBlock(TRANSCRIPT);
    assert.match(block, /THAT NEED IS MET/);
    assert.match(block, /do not haggle over the remainder/);
    assert.match(block, /never say or suggest that they missed your number/);
  });

  test("success tests 2 and 3 (prompt-level): the referral and the guarantee rules are in force this turn", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, TRANSCRIPT, "advanced", 2);
    assert.ok(prompt.includes(REASONABLE_CUSTOMER_RULES));
    assert.match(prompt, /STAY INSIDE WHAT THIS PERSON CAN ANSWER/);
    assert.match(prompt, /DO NOT ASK FOR PROMISES NOBODY CAN HONESTLY MAKE/);
    assert.match(prompt, /THAT NEED IS MET/);
  });

  test("success test 4 (deterministic): the acceptance is recognized, so the conversation can end", () => {
    assert.equal(hasCustomerAcceptedProposal(TRANSCRIPT), true);
    assert.match(buildTurnStateBlock(TRANSCRIPT), /ALREADY said the proposed solution fits/);
  });

  test("success test 5 (prompt-level): the polite non-looping exit exists as a second ending", () => {
    assert.match(REASONABLE_CUSTOMER_RULES, /I appreciate your time, thank you/);
    assert.match(REASONABLE_CUSTOMER_RULES, /no third ending/i);
  });

  test("success test 6 (deterministic): a rep who releases this customer instead is scored as a win", () => {
    const release = "I might not be able to give you the guarantee you're after, so go find what fits you best.";
    assert.equal(detectCloseIntent(release), true, "the release must trip the end-and-score checkpoint");
    assert.equal(closeOutcomeAnchor("graceful_referral"), 85);
    assert.match(GRACEFUL_RELEASE_RULES, /DECLINING TO PROMISE THE IMPOSSIBLE IS A CORRECT ANSWER/);
  });
});

// ===========================================================================
// PART 1 of the "customer answers, coach cites the moment" spec: the AI customer
// dodged the rep's direct questions. Two layers are asserted here: the static
// CUSTOMER_RESPONSIVENESS_RULES in the cacheable prefix, and the deterministic
// per-turn line that quotes the live question into the volatile tail.
// ===========================================================================

import { CUSTOMER_RESPONSIVENESS_RULES } from "./llm";
import { deriveDirectQuestion } from "./conversationState";

describe("CUSTOMER_RESPONSIVENESS_RULES - reaches every customer prompt", () => {
  test("it is embedded in the customer prompt at every difficulty", () => {
    for (const difficulty of ["beginner", "intermediate", "advanced"]) {
      assert.ok(
        buildCustomerReplyPrompt(PERSONA, [], difficulty).includes(CUSTOMER_RESPONSIVENESS_RULES),
        `${difficulty} must inherit the responsiveness rules`,
      );
    }
  });

  test("it survives escalation and an unrecognized difficulty (no silent bypass)", () => {
    for (const tier of [0, 1, 2]) {
      assert.ok(buildCustomerReplyPrompt(PERSONA, [], "advanced", tier).includes(CUSTOMER_RESPONSIVENESS_RULES));
    }
    assert.ok(buildCustomerReplyPrompt(PERSONA, [], "nonsense-level").includes(CUSTOMER_RESPONSIVENESS_RULES));
  });

  test("it lives in the cacheable stable prefix, not the volatile tail", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.ok(prefix.includes(CUSTOMER_RESPONSIVENESS_RULES));
    const prompt = buildCustomerReplyPrompt(PERSONA, [turn("consultant", "Hi there.")], "advanced", 2);
    assert.ok(prompt.indexOf(CUSTOMER_RESPONSIVENESS_RULES) < prompt.indexOf("Conversation so far:"));
  });

  test("it composes AFTER PR #88's reasonableness rules rather than replacing them", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.ok(prefix.includes(REASONABLE_CUSTOMER_RULES), "PR #88's block must still be there in full");
    assert.ok(
      prefix.indexOf(REASONABLE_CUSTOMER_RULES) < prefix.indexOf(CUSTOMER_RESPONSIVENESS_RULES),
      "the responsiveness layer is the third and last layer of the stack",
    );
    assert.ok(prefix.indexOf(CONVERSATION_REALISM_RULES) < prefix.indexOf(REASONABLE_CUSTOMER_RULES));
  });
});

describe("LOW_KEY_CUSTOMER_CONVERSATION_RULES - normal customer baseline", () => {
  test("is embedded in every shared customer prompt and remains in the stable prefix", () => {
    for (const difficulty of ["beginner", "intermediate", "advanced", "nonsense-level"]) {
      const prompt = buildCustomerReplyPrompt(PERSONA, [], difficulty, 2);
      assert.ok(prompt.includes(LOW_KEY_CUSTOMER_CONVERSATION_RULES), `${difficulty} must inherit the low-key rules`);
      assert.ok(
        prompt.indexOf(LOW_KEY_CUSTOMER_CONVERSATION_RULES) < prompt.indexOf("Conversation so far:"),
        `${difficulty} must receive the rule in the cacheable shared prefix`,
      );
    }
  });

  test("explicitly favors a quiet, responsive customer who accepts specific factual answers", () => {
    const rules = LOW_KEY_CUSTOMER_CONVERSATION_RULES;
    assert.match(rules, /STAY RELATIVELY QUIET AND RESPONSIVE/);
    assert.match(rules, /barrage of your own questions/i);
    assert.match(rules, /clear, specific, on-topic factual answer/i);
    assert.match(rules, /Do not rephrase the same question/i);
    assert.match(rules, /single clear follow-up is fair/i);
    assert.match(rules, /The consultant leads discovery/i);
  });

  test("composes after responsiveness and before hidden-motivation guidance", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.ok(prefix.indexOf(CUSTOMER_RESPONSIVENESS_RULES) < prefix.indexOf(LOW_KEY_CUSTOMER_CONVERSATION_RULES));
    assert.ok(prefix.indexOf(LOW_KEY_CUSTOMER_CONVERSATION_RULES) < prefix.indexOf(HIDDEN_MOTIVATION_DISCOVERY_RULES));
  });
});

describe("buildCustomerReplyPrompt - answered factual-question memory", () => {
  test("puts a customer question and its specific consultant answer into the volatile state tail", () => {
    const prompt = buildCustomerReplyPrompt(
      PERSONA,
      [
        msg("customer", "What towing capacity does this truck have?"),
        msg(
          "consultant",
          "This truck is rated to tow 12,000 to 14,000 pounds depending on its configuration.",
        ),
      ],
      "advanced",
    );
    assert.match(prompt, /ANSWERED AND CLOSED/);
    assert.match(prompt, /brief natural reaction/i);
    assert.match(prompt, /same fact again with different wording/i);
    assert.ok(
      prompt.indexOf("Conversation so far:") < prompt.indexOf("ANSWERED AND CLOSED"),
      "the derived factual-answer memory must be after the transcript in the volatile tail",
    );
  });

  test("places a concrete towing closure gate immediately before the output instruction", () => {
    const prompt = buildCustomerReplyPrompt(
      PERSONA,
      [
        msg("customer", "What specific towing package and towing capacity does this truck have?"),
        msg("consultant", "This truck can tow 12,000 to 14,000 pounds depending on configuration."),
      ],
      "advanced",
    );
    const gate = prompt.lastIndexOf("FINAL PRE-REPLY CHECK");
    const output = prompt.lastIndexOf("Respond with your next line as the customer");
    assert.ok(gate > prompt.lastIndexOf("Conversation so far:"));
    assert.ok(gate < output);
    assert.match(prompt.slice(gate, output), /TOWING-CAPABILITY BOUNDARY/);
    assert.match(prompt.slice(gate, output), /What comes with the towing package/i);
  });

  test("preserves one concise clarification when the consultant is genuinely vague", () => {
    const prompt = buildCustomerReplyPrompt(
      PERSONA,
      [
        msg("customer", "What towing capacity does this truck have?"),
        msg("consultant", "It should be able to handle a trailer, but I would need to check the exact rating."),
      ],
      "advanced",
    );
    assert.match(prompt, /may ask ONE concise, more precise follow-up/i);
    assert.doesNotMatch(prompt, /ANSWERED AND CLOSED/);
  });
});

describe("CUSTOMER_RESPONSIVENESS_RULES - Rules 1-4 content", () => {
  const rules = CUSTOMER_RESPONSIVENESS_RULES;

  test("core rule: the rep drives discovery and answering is the default job", () => {
    assert.match(rules, /THE CONSULTANT IS DRIVING DISCOVERY AND YOUR DEFAULT JOB IS TO ANSWER/);
    assert.match(rules, /never a licence to talk past the question/);
  });

  test("Rule 1: a direct question gets a relevant answer, not an unrelated concern", () => {
    assert.match(rules, /ANSWER THE QUESTION THAT WAS ASKED/);
    assert.match(rules, /a subject change that sends the conversation back to the start/);
    // The spec's own bad example is named so the model cannot mistake it for a fine reply.
    assert.match(rules, /I want to make sure I have good warranties/);
    assert.match(rules, /It is a fine thing to care about and a terrible answer to that question/);
  });

  test("Rule 2: general, then narrowed, then COMMITTED", () => {
    assert.match(rules, /WHEN THEY NARROW, YOU COMMIT/);
    assert.match(rules, /Never general, narrowed, then general again/);
    assert.match(rules, /It's the transmission mostly/);
    assert.match(rules, /I just want to make sure none of those things happen/);
  });

  test("Rule 3: a premature question is redirected once and the customer returns to answering", () => {
    assert.match(rules, /TAKE A REDIRECT ON A PREMATURE QUESTION AND GET BACK TO ANSWERING/);
    assert.match(rules, /warranties, service coverage, financing, loan terms, payment mechanics/);
    assert.match(rules, /Do not keep pushing the parked topic/);
  });

  test("Rule 3: the department topics are a worked example, not the whole list", () => {
    // The closed four-topic list is what let the safety-ratings loop through, so
    // the rule has to state the general principle alongside the examples.
    assert.match(rules, /Those are the clearest cases, not the whole list/);
    assert.match(rules, /a consultant sequencing discovery is doing the job correctly, not dodging you/);
  });

  test("Rule 4: a re-steered tangent is answered, not bounced back", () => {
    assert.match(rules, /WHEN THEY STEER A TANGENT BACK, ANSWER THE REAL QUESTION/);
    assert.match(rules, /Probably a hybrid, I do a lot of highway miles/);
    assert.match(rules, /Do not answer a question with a question/);
  });

  test("guardrail: difficulty is preserved and PR #88's own outs are explicitly kept", () => {
    assert.match(rules, /This makes you no easier to sell to/);
    assert.match(rules, /still guarded, still skeptical, still slow to hand over your real motivation/);
    // PR #88's Rule A out-of-scope question and the one alternatives round survive.
    assert.match(rules, /one out-of-scope question and one round of "what else do you have"/);
    assert.match(rules, /None of that changes/);
    assert.match(rules, /answer first, then ask/);
  });

  test("guardrail: the difficulty, escalation, and reasonableness text is untouched", () => {
    const advanced = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.match(advanced, /Push back hard on price and value/);
    assert.match(advanced, /Do not make it easy/);
    assert.match(advanced, /Being hard to satisfy is realistic and wanted/);
    assert.match(advanced, /PUSH BACK WITH YOUR REAL WORRY, NOT A RIDDLE/);
    assert.match(escalationAddon(2), /tougher objection/i);
  });
});

// The trainer is only useful when the persona's real priorities must be
// discovered. These assertions deliberately check the shared prompt, rather than
// a one-off Vince fixture, because the same internal-state discipline must govern
// every vertical and every selected persona variation.
describe("HIDDEN_MOTIVATION_DISCOVERY_RULES - discovery over scripted pivots", () => {
  test("is present in every shared customer prompt before the role boundary", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, [], "beginner");
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.ok(prompt.includes(HIDDEN_MOTIVATION_DISCOVERY_RULES));
    assert.ok(prefix.includes(HIDDEN_MOTIVATION_DISCOVERY_RULES));
    assert.ok(
      prefix.indexOf(HIDDEN_MOTIVATION_DISCOVERY_RULES) < prefix.indexOf(CUSTOMER_ROLE_BOUNDARY_RULES),
      "hidden-motivation guidance must be active before the final customer-role boundary",
    );
  });

  test("makes motivations internal state instead of a repeated spoken script", () => {
    const rules = HIDDEN_MOTIVATION_DISCOVERY_RULES;
    assert.match(rules, /INTERNAL STATE, not a script/i);
    assert.match(rules, /consultant can discover what actually matters/i);
    assert.match(rules, /DO NOT ANNOUNCE OR SIGNAL THE SAME CORE MOTIVATION ON EVERY TURN/i);
    assert.match(rules, /do not end several nearby turns with different versions of the same question or slogan/i);
    assert.match(rules, /REVEAL IN LAYERS, NOT AS A LOOP/i);
  });

  test("requires the named topic to be answered instead of substituting a favored concern", () => {
    const rules = HIDDEN_MOTIVATION_DISCOVERY_RULES;
    assert.match(rules, /TOPIC FIDELITY COMES FIRST/i);
    assert.match(rules, /If they ask about safety, talk about the safety you need/i);
    assert.match(rules, /Do not substitute price, reliability, cargo room, fuel economy/i);

    const prompt = buildCustomerReplyPrompt(
      PERSONA,
      [msg("consultant", "Safety matters to you. What specifically do you need to feel safe?")],
      "beginner",
    );
    assert.match(prompt, /FINAL DIRECT-ANSWER CHECK/i);
    assert.match(prompt, /If they ask about safety, explicitly address safety/i);
    assert.match(prompt, /Do not replace that subject with your recurring opening request, price, reliability/i);
  });
});

describe("buildTurnStateBlock - the live question is pinned into the volatile tail", () => {
  test("the question is quoted and answering it is demanded", () => {
    const block = buildTurnStateBlock([
      turn("customer", "I need something for my commute."),
      turn("consultant", "How long is that commute each way?"),
    ]);
    assert.match(block, /JUST ASKED YOU SOMETHING DIRECTLY/);
    assert.match(block, /"How long is that commute each way\?"/);
  });

  test("a rep turn that asks nothing adds no question line", () => {
    const block = buildTurnStateBlock([
      turn("customer", "I need something for my commute."),
      turn("consultant", "That makes sense, a lot of people are in the same spot."),
    ]);
    assert.doesNotMatch(block, /JUST ASKED YOU SOMETHING DIRECTLY/);
  });

  test("it stays out of the cacheable prefix", () => {
    const transcript = [turn("consultant", "What are you driving now?")];
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "intermediate");
    const prompt = buildCustomerReplyPrompt(PERSONA, transcript, "intermediate");
    assert.ok(prompt.startsWith(prefix));
    assert.doesNotMatch(prefix, /JUST ASKED YOU SOMETHING DIRECTLY/);
    assert.match(prompt, /JUST ASKED YOU SOMETHING DIRECTLY/);
  });
});

// The spec's first worked example, verbatim. This is the teachable rep skill:
// the customer starts general, the rep narrows, and the customer must reward it
// with a real specific instead of restarting the loop.
describe("worked example (spec): the reliability narrowing", () => {
  const VAGUE = "I just want something reliable that won't break down.";
  const NARROWING =
    "Of course, nobody wants a car that breaks down. But when you say reliable, what specifically concerns you? Are you worried about the transmission going out, the engine, the windows not working, belts and hoses? Tell me what's on your mind.";
  const GOOD = "It's the transmission mostly. That's what died on my last one.";
  const BAD = "I just want to make sure none of those things happen.";

  const AT_THE_NARROWING = [turn("customer", VAGUE), turn("consultant", NARROWING)];

  test("the narrowing is recognized as one, and the vague line it answers is captured", () => {
    const q = deriveDirectQuestion(AT_THE_NARROWING);
    assert.ok(q, "the rep's narrowing must be seen as a live question");
    assert.equal(q!.narrowing, true);
    assert.equal(q!.vagueAnswer, VAGUE);
    assert.ok(q!.asks.some((a) => a.includes("what specifically concerns you")));
    assert.ok(q!.asks.some((a) => a.includes("belts and hoses")));
  });

  test("the customer's prompt for this turn demands a committed specific", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, AT_THE_NARROWING, "advanced", 2);
    assert.match(prompt, /JUST ASKED YOU SOMETHING DIRECTLY/);
    assert.match(prompt, /belts and hoses/);
    assert.match(prompt, /NARROWS things to a specific, and you must COMMIT to one/);
    assert.match(prompt, new RegExp(escapeForRegExp(VAGUE)));
    assert.match(prompt, /Staying general a second time/);
    // The whole three-layer stack is in force on this turn.
    assert.ok(prompt.includes(CONVERSATION_REALISM_RULES));
    assert.ok(prompt.includes(REASONABLE_CUSTOMER_RULES));
    assert.ok(prompt.includes(CUSTOMER_RESPONSIVENESS_RULES));
  });

  test("the BAD reply is the exact shape both layers name and forbid", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, AT_THE_NARROWING, "advanced", 2);
    assert.match(prompt, /I just want to make sure none of those things happen/, "the static rules name it");
    assert.match(prompt, /I just don't want any of those to happen/, "the per-turn line names its shape too");
    assert.ok(
      BAD.startsWith("I just want to make sure none of those"),
      "sanity: the forbidden reply in the spec is the one quoted in the rules",
    );
  });

  test("once the customer commits, the question is spent and stops being re-demanded", () => {
    const answered = [...AT_THE_NARROWING, turn("customer", GOOD)];
    assert.equal(deriveDirectQuestion(answered), null);
    assert.doesNotMatch(buildTurnStateBlock(answered), /JUST ASKED YOU SOMETHING DIRECTLY/);
  });
});

// The spec's second worked example, verbatim: a premature warranty question is
// redirected once, and the customer must come back to answering discovery.
describe("worked example (spec): the premature warranty question", () => {
  const PREMATURE = "What warranties does it come with?";
  const REDIRECT =
    "Great question, and warranties differ by vehicle, age, mileage, some have factory warranty left, some don't, and they're handled in financing once we've found your car. Let's find the right vehicle first. So picture yourself two or three months from now, what are you driving?";

  const AT_THE_REDIRECT = [turn("customer", PREMATURE), turn("consultant", REDIRECT)];

  test("the redirect and the discovery question in the same message are both seen", () => {
    const q = deriveDirectQuestion(AT_THE_REDIRECT);
    assert.ok(q);
    assert.equal(q!.redirectedTopic, "warranty or service coverage");
    assert.deepEqual(q!.asks, ["So picture yourself two or three months from now, what are you driving?"]);
  });

  test("the customer's prompt tells it to accept the redirect and answer the vehicle question", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, AT_THE_REDIRECT, "advanced", 2);
    assert.match(prompt, /what are you driving\?/);
    assert.match(prompt, /Accept that redirect/);
    assert.match(prompt, /do not spend this turn pushing warranty or service coverage again/);
    assert.match(prompt, /TAKE A REDIRECT ON A PREMATURE QUESTION AND GET BACK TO ANSWERING/);
  });

  test("PR #87's one-more-ask allowance is preserved, it is just not this turn's move", () => {
    // Composition check: the deflection rule still says the topic may come back
    // once, so the fix narrows the customer's move on THIS turn without closing a
    // topic the rep has only redirected a single time.
    const prompt = buildCustomerReplyPrompt(PERSONA, AT_THE_REDIRECT, "advanced", 2);
    assert.match(prompt, /You may raise it at most ONE more time/);
    assert.doesNotMatch(prompt, /That topic is CLOSED/);
  });

  test("a second redirect still closes the topic for good (PR #87 unchanged)", () => {
    const twice = [
      ...AT_THE_REDIRECT,
      turn("customer", "Sure, but is there any warranty left on it at all?"),
      turn("consultant", "The warranty specialist covers that. Let's first nail down the vehicle. What's the drive like?"),
    ];
    const prompt = buildCustomerReplyPrompt(PERSONA, twice, "advanced", 2);
    assert.match(prompt, /That topic is CLOSED/);
    assert.match(prompt, /JUST ASKED YOU SOMETHING DIRECTLY/);
  });
});

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ===========================================================================
// Vulgar/belligerent bait: detection, strike bookkeeping, and the scripted
// reply/session-ending behavior in getCustomerReply + streamCustomerReply.
// ===========================================================================
// The live incident this covers: a consultant sent hostile/dismissive lines
// ("fuck off", "sorry not worth my time") at the simulated customer and the
// session never reached a recommendation. See server/vulgarBait.ts.

describe("detectVulgarBait", () => {
  test("flags common profanity as a whole word", () => {
    assert.equal(detectVulgarBait("fuck off, I'm done here"), true);
    assert.equal(detectVulgarBait("this is bullshit"), true);
    assert.equal(detectVulgarBait("you're an asshole"), true);
  });

  test("flags multi-word bait phrases even without a listed single word", () => {
    assert.equal(detectVulgarBait("sorry not worth my time, piss off"), true);
    assert.equal(detectVulgarBait("go to hell with this demo"), true);
  });

  test("does not false-positive inside an unrelated longer word", () => {
    // "assassin" contains "ass" but must not trip an "asshole"-style match; more
    // to the point, word-boundary matching must not fire on substrings that
    // merely contain a banned word as part of a longer, unrelated word.
    assert.equal(detectVulgarBait("classic assessment of the market"), false);
  });

  test("ordinary consultant language never flags", () => {
    assert.equal(detectVulgarBait("What's your timeline for moving?"), false);
    assert.equal(detectVulgarBait("Let's talk about your budget."), false);
  });

  test("empty or whitespace-only text never flags", () => {
    assert.equal(detectVulgarBait(""), false);
    assert.equal(detectVulgarBait("   "), false);
  });
});

describe("countPriorVulgarStrikes", () => {
  test("counts only consultant turns, and only the ones that flag", () => {
    const transcript = [
      msg("customer", "What's your best price?"),
      msg("consultant", "fuck off, just give me a number"),
      msg("customer", "Haha, that's funny..."),
      msg("consultant", "Sorry, let's get back to it. What's your budget?"),
      msg("customer", "Around $20,000."),
    ];
    assert.equal(countPriorVulgarStrikes(transcript), 1);
  });

  test("a customer turn containing a flagged word is never counted (role must be consultant)", () => {
    const transcript = [msg("customer", "Are you fucking kidding me with this price")];
    assert.equal(countPriorVulgarStrikes(transcript), 0);
  });

  test("a clean transcript counts zero strikes", () => {
    const transcript = [msg("customer", "Hi"), msg("consultant", "What are you looking for today?")];
    assert.equal(countPriorVulgarStrikes(transcript), 0);
  });
});

describe("checkVulgarBaitStrike", () => {
  test("no strike when the transcript has no consultant turn yet", () => {
    assert.equal(checkVulgarBaitStrike([msg("customer", "Hi there.")]), null);
  });

  test("no strike when the last consultant message is clean, even if an earlier one was vulgar", () => {
    // The vulgar check only ever looks at the LAST consultant turn for whether
    // THIS turn is a strike; an earlier flagged turn still counts toward the
    // running total (see the next test), but a clean latest turn is not itself
    // a new strike.
    const transcript = [
      msg("consultant", "fuck off"),
      msg("customer", VULGAR_STRIKE_ONE_REPLY),
      msg("consultant", "Sorry about that. What's your budget?"),
    ];
    assert.equal(checkVulgarBaitStrike(transcript), null);
  });

  test("first offense returns the scripted strike-one reply and does not end the session", () => {
    const transcript = [msg("customer", "What's your best price?"), msg("consultant", "fuck off, just answer")];
    const result = checkVulgarBaitStrike(transcript);
    assert.deepEqual(result, { text: VULGAR_STRIKE_ONE_REPLY, sessionEnded: false });
  });

  test("second offense returns the scripted strike-two reply and ends the session", () => {
    const transcript = [
      msg("customer", "What's your best price?"),
      msg("consultant", "fuck off, just answer"),
      msg("customer", VULGAR_STRIKE_ONE_REPLY),
      msg("consultant", "sorry not worth my time, piss off"),
    ];
    const result = checkVulgarBaitStrike(transcript);
    assert.deepEqual(result, { text: VULGAR_STRIKE_TWO_REPLY, sessionEnded: true });
  });

  test("the in-flight consultant message itself is excluded from the prior-strike count", () => {
    // Only one PRIOR consultant turn was vulgar; the current (last) one is the
    // second vulgar turn overall, so this call must see priorStrikes = 1 and
    // report the ending strike, not miscount it as strike 1 again or as strike 3.
    const transcript = [
      msg("consultant", "fuck off"),
      msg("customer", VULGAR_STRIKE_ONE_REPLY),
      msg("consultant", "still not worth my time, piss off"),
    ];
    const result = checkVulgarBaitStrike(transcript);
    assert.equal(result?.sessionEnded, true);
  });
});

// These prove the model is genuinely never invoked on a strike, for BOTH the
// non-streaming and streaming reply paths -- not merely that the code LOOKS
// like it returns early. The suite runs with OPENAI_API_KEY=sk-test-dummy and
// no network mocking, so a real (unmocked) OpenAI call synchronously rejects
// with AuthenticationError before any request completes. If either function's
// early-return were removed or bypassed, these tests would fail with that
// same AuthenticationError instead of resolving.
describe("getCustomerReply / streamCustomerReply - vulgar strikes never reach the model", () => {
  test("getCustomerReply: first strike resolves with the scripted line and sessionEnded=false, without calling OpenAI", async () => {
    const transcript = [msg("customer", "What's your best price?"), msg("consultant", "fuck off, just answer")];
    const result = await getCustomerReply(PERSONA, transcript, "beginner", 0, "");
    assert.deepEqual(result, { text: VULGAR_STRIKE_ONE_REPLY, sessionEnded: false });
  });

  test("getCustomerReply: second strike resolves with the scripted ending line and sessionEnded=true, without calling OpenAI", async () => {
    const transcript = [
      msg("consultant", "fuck off"),
      msg("customer", VULGAR_STRIKE_ONE_REPLY),
      msg("consultant", "sorry not worth my time, piss off"),
    ];
    const result = await getCustomerReply(PERSONA, transcript, "beginner", 0, "");
    assert.deepEqual(result, { text: VULGAR_STRIKE_TWO_REPLY, sessionEnded: true });
  });

  test("getCustomerReply: a clean transcript is NOT short-circuited (it genuinely reaches the model and fails on the dummy key)", async () => {
    // Sanity check for the two tests above: proves the dummy-key/no-mock setup
    // really does fail when the strike short-circuit does NOT apply, so their
    // passing is meaningful rather than an artifact of every call succeeding
    // regardless of path.
    const transcript = [msg("customer", "Hi"), msg("consultant", "What are you looking for today?")];
    await assert.rejects(getCustomerReply(PERSONA, transcript, "beginner", 0, ""));
  });

  test("streamCustomerReply: first strike sends the scripted line through onSentence exactly once, sessionEnded=false, without calling OpenAI", async () => {
    const transcript = [msg("customer", "What's your best price?"), msg("consultant", "fuck off, just answer")];
    const sentences: Array<{ text: string; index: number }> = [];
    const result = await streamCustomerReply(PERSONA, transcript, "beginner", 0, "", (text, index) =>
      sentences.push({ text, index }),
    );
    assert.deepEqual(result, { text: VULGAR_STRIKE_ONE_REPLY, sessionEnded: false });
    // Voice mode gets the strike line the same way it gets any normal sentence:
    // via onSentence, so the caller's TTS pipeline (deps.synthesize in
    // server/turnStream.ts) synthesizes it exactly like ordinary customer
    // speech, rather than the strike silently becoming text-only.
    assert.deepEqual(sentences, [{ text: VULGAR_STRIKE_ONE_REPLY, index: 0 }]);
  });

  test("streamCustomerReply: second strike sends the scripted ending line through onSentence, sessionEnded=true, without calling OpenAI", async () => {
    const transcript = [
      msg("consultant", "fuck off"),
      msg("customer", VULGAR_STRIKE_ONE_REPLY),
      msg("consultant", "sorry not worth my time, piss off"),
    ];
    const sentences: Array<{ text: string; index: number }> = [];
    const result = await streamCustomerReply(PERSONA, transcript, "beginner", 0, "", (text, index) =>
      sentences.push({ text, index }),
    );
    assert.deepEqual(result, { text: VULGAR_STRIKE_TWO_REPLY, sessionEnded: true });
    assert.deepEqual(sentences, [{ text: VULGAR_STRIKE_TWO_REPLY, index: 0 }]);
  });

  test("streamCustomerReply: a clean transcript is NOT short-circuited (it genuinely reaches the model and fails on the dummy key)", async () => {
    const transcript = [msg("customer", "Hi"), msg("consultant", "What are you looking for today?")];
    await assert.rejects(streamCustomerReply(PERSONA, transcript, "beginner", 0, "", () => {}));
  });

  test("streamCustomerReply: onSentence works even with no handler passed (default no-op), first strike", async () => {
    // streamCustomerReply's onSentence parameter defaults to a no-op, so a
    // caller that omits it (unlikely in practice, but the signature allows it)
    // must not throw when a strike fires.
    const transcript = [msg("customer", "What's your best price?"), msg("consultant", "fuck off, just answer")];
    const result = await streamCustomerReply(PERSONA, transcript, "beginner", 0, "");
    assert.deepEqual(result, { text: VULGAR_STRIKE_ONE_REPLY, sessionEnded: false });
  });
});


// This exercises getCustomerReply itself (including its real prompt construction)
// through a deterministic responder. It is intentionally mocked: no OpenAI request
// is made, so the expected customer lines remain stable in CI while the test still
// proves the generated prompt carries role, direct-answer, and running-memory state
// across the exact two-turn Auto Sales failure shape.
describe("getCustomerReply - mocked Don Auto Sales answer discipline", () => {
  test("answers as Don, builds on disclosed facts, and never becomes the dealership", async () => {
    const replies = [
      "For us, safe and comfortable means good visibility, helpful driver-assistance features, a smooth quiet highway ride, and seats that will not leave us sore after six hours. We do not need luxury extras.",
      "Used is the better fit for us. We are on a fixed retirement income, so I need a dependable car and a payment that will not make us feel squeezed each month.",
    ];
    const prompts: string[] = [];
    setCustomerReplyTestResponder(({ input }) => {
      prompts.push(input);
      const reply = replies.shift();
      assert.ok(reply, "the fixture must provide one reply for each getCustomerReply call");
      return reply;
    });

    try {
      const transcript: TranscriptMessage[] = [
        turn("customer", "We are replacing our nine-year-old sedan. We are looking for a used car, nothing fancy."),
        turn("consultant", "When you say safe and comfortable for the six-hour drive to your grandkids, what does that mean to you?"),
      ];

      const safetyReply = (await getCustomerReply(personaVariantSeed["demo-v2-auto-2"].core, transcript)).text;
      transcript.push(turn("customer", safetyReply));
      transcript.push(turn("consultant", "Would you rather focus on a new vehicle or a used one?"));
      const usedReply = (await getCustomerReply(personaVariantSeed["demo-v2-auto-2"].core, transcript)).text;

      assert.equal(prompts.length, 2);
      assert.ok(prompts.every((prompt) => prompt.includes(CUSTOMER_ROLE_BOUNDARY_RULES)));
      assert.match(prompts[0], /THE CONSULTANT JUST ASKED YOU SOMETHING DIRECTLY/);
      assert.match(prompts[1], /RUNNING CUSTOMER MEMORY CONTRACT/);
      assert.match(prompts[1], /looking for a used car, nothing fancy/i);
      assert.match(prompts[1], /good visibility, helpful driver-assistance features/i);

      assert.match(safetyReply, /good visibility/i);
      assert.match(safetyReply, /driver-assistance/i);
      assert.match(safetyReply, /smooth quiet highway ride/i);
      assert.doesNotMatch(safetyReply, /\bwe (?:have|carry|offer|stock|recommend)\b/i);
      assert.doesNotMatch(safetyReply, /car dealer|what are you looking for/i);
      assert.doesNotMatch(safetyReply, /\?$/);

      assert.match(usedReply, /^Used is the better fit for us\./);
      assert.match(usedReply, /fixed retirement income/i);
      assert.match(usedReply, /payment that will not make us feel squeezed/i);
      assert.doesNotMatch(usedReply, /good visibility|driver-assistance|smooth quiet highway ride/i);
      assert.doesNotMatch(usedReply, /\?$/);
      assert.doesNotMatch(usedReply, /\bwe (?:have|carry|offer|stock|recommend)\b/i);
    } finally {
      setCustomerReplyTestResponder(null);
    }
  });
});

describe("getCustomerReply - closed factual-question repair", () => {
  test("repairs a rephrased towing-package repeat before it reaches the caller", async () => {
    const prompts: string[] = [];
    const replies = [
      "What features come with the towing package?",
      "Okay, that helps. I would like to see the maintenance history next.",
    ];
    setCustomerReplyTestResponder(({ input }) => {
      prompts.push(input);
      const reply = replies.shift();
      assert.ok(reply);
      return reply;
    });

    try {
      const result = await getCustomerReply(
        personaVariantSeed["auto-sales-skeptical-negotiator"].core,
        [
          turn("customer", "What specific towing package and towing capacity does this truck have?"),
          turn("consultant", "This truck can tow 12,000 to 14,000 pounds depending on configuration."),
        ],
      );
      assert.equal(result.text, "Okay, that helps. I would like to see the maintenance history next.");
      assert.equal(prompts.length, 2);
      assert.match(prompts[1], /VALIDATION FAILED/);
      assert.match(prompts[1], /REJECTED DRAFT/);
    } finally {
      setCustomerReplyTestResponder(null);
    }
  });

  test("uses that same validated path before streaming a closed factual topic", async () => {
    const replies = [
      "What features come with the towing package?",
      "Okay, that helps. I would like to see the maintenance history next.",
    ];
    const spoken: string[] = [];
    setCustomerReplyTestResponder(() => {
      const reply = replies.shift();
      assert.ok(reply);
      return reply;
    });

    try {
      const result = await streamCustomerReply(
        personaVariantSeed["auto-sales-skeptical-negotiator"].core,
        [
          turn("customer", "What specific towing package and towing capacity does this truck have?"),
          turn("consultant", "This truck can tow 12,000 to 14,000 pounds depending on configuration."),
        ],
        "intermediate",
        0,
        "",
        (sentence) => spoken.push(sentence),
      );
      assert.equal(result.text, "Okay, that helps. I would like to see the maintenance history next.");
      assert.deepEqual(spoken, ["Okay, that helps.", "I would like to see the maintenance history next."]);
    } finally {
      setCustomerReplyTestResponder(null);
    }
  });
});
