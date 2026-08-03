import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildCustomerReplyPrompt,
  buildCustomerReplyStablePrefix,
  buildTurnStateBlock,
  CONVERSATION_REALISM_RULES,
  INFORMATION_LAYERS_FLAG,
  informationLayersEnabled,
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

// The disclosure gate reaching the prompt. The derivation itself is covered in
// conversationState.test.ts; what matters here is that a persona's gated
// subjects actually arrive in the text the model is handed, and that a persona
// that declares none is left byte-identical to how it was before the gate
// existed.
describe("buildTurnStateBlock - disclosure gate", () => {
  const CAR_SEAT = [
    { label: "the practical business of getting a car seat in and out", keywords: ["car seat", "stroller"] },
  ];
  const transcript = [
    msg("customer", "We're expecting in March, so we want the biggest SUV you've got."),
    msg("consultant", "Congratulations! What brings you in today?"),
  ];

  test("a subject nobody has asked about is named as off limits this turn", () => {
    const block = buildTurnStateBlock(transcript, false, CAR_SEAT);
    assert.ok(block.includes("the practical business of getting a car seat in and out"));
    assert.ok(block.includes("Do not raise any of that yourself this turn"));
  });

  test("a relevant question removes it, leaving the rest of the block untouched", () => {
    const asked = [...transcript, msg("consultant", "How are you picturing the car seat going in day to day?")];
    const block = buildTurnStateBlock(asked, false, CAR_SEAT);
    assert.ok(!block.includes("Do not raise any of that yourself this turn"));
    assert.ok(block.includes("most recent message"));
  });

  test("a persona with no gated subjects gets the identical block it always got", () => {
    assert.equal(buildTurnStateBlock(transcript, false, []), buildTurnStateBlock(transcript, false));
  });

  test("it is not behind the information-layers flag", () => {
    // The defect the gate fixes is live in production, so an off-by-default fix
    // would not fix it. It is inert for untagged personas on its own terms.
    const off = buildTurnStateBlock(transcript, false, CAR_SEAT);
    const on = buildTurnStateBlock(transcript, true, CAR_SEAT);
    assert.ok(off.includes("Do not raise any of that yourself this turn"));
    assert.ok(on.includes("Do not raise any of that yourself this turn"));
  });

  test("it reaches the assembled reply prompt, in the volatile tail", () => {
    const prompt = buildCustomerReplyPrompt(PERSONA, transcript, "beginner", 0, "", false, CAR_SEAT);
    const stable = buildCustomerReplyStablePrefix(PERSONA, "beginner");
    assert.ok(prompt.includes("Do not raise any of that yourself this turn"));
    assert.ok(!stable.includes("Do not raise any of that yourself this turn"));
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

  test("fires on a release that names the replacement instead of leaving it vague", () => {
    // The reported gap. "find what/something/someone" was covered; naming the
    // thing the customer should go to instead was not, so the clearest exit in
    // the session went undetected and the conversation stayed open.
    assert.equal(detectCloseIntent("I think you should find another car dealer."), true);
    assert.equal(detectCloseIntent("Honestly, go find another dealership."), true);
    assert.equal(detectCloseIntent("You need to find another consultant who can help you."), true);
    assert.equal(detectCloseIntent("You'd be better off to find a different provider."), true);
    assert.equal(detectCloseIntent("I'd find some other shop for this one."), true);
  });

  test("does NOT fire when 'find another' keeps the consultant in the conversation", () => {
    // These are the opposite of a release: the rep is still working the problem.
    assert.equal(detectCloseIntent("Let's find another way to make this work for you."), false);
    assert.equal(detectCloseIntent("We can find another time that suits you better."), false);
    assert.equal(detectCloseIntent("I'll find a different option in your range."), false);
    assert.equal(detectCloseIntent("Let me find another approach to the financing."), false);
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

  test("Rule 3: a redirect toward discovery is followed and the customer returns to answering", () => {
    assert.match(rules, /FOLLOW A REDIRECT BACK TO DISCOVERY, WHATEVER THE TOPIC WAS/);
    assert.match(rules, /Do not keep pushing the parked topic/);
    assert.match(rules, /consultant sequencing discovery is doing the job correctly, not dodging you/);
  });

  test("Rule 3: the trigger is the redirect itself, not a list of named topics", () => {
    // Enumerating topics is what caused this bug twice (safety ratings, then car
    // seat installation): the model treated the list as the scope and ignored
    // redirects on anything absent from it. The rule must key off the
    // consultant's move and say so for ANY subject.
    assert.match(rules, /regardless of what topic you were redirected away from/);
    assert.match(rules, /This applies to ANY topic/);
    assert.match(rules, /There is no fixed list of topics this covers/);
    assert.match(rules, /not named as an example anywhere in these rules/);
  });

  test("Rule 3: the per-turn self-check is stated explicitly", () => {
    assert.match(rules, /APPLY THIS TEST ON EVERY SINGLE TURN/);
    assert.match(rules, /does my response answer THAT question, or does it pivot/);
    assert.match(rules, /it does not matter what the pivot topic is/);
  });

  test("Rule 3: two attempts allowed, then the topic is dropped on any subject", () => {
    assert.match(rules, /HOW MANY TIMES YOU MAY PRESS BEFORE YOU MUST STOP/);
    assert.match(rules, /you may reasonably ask ONE more time, and that is attempt two/);
    assert.match(rules, /After the SECOND redirect from the consultant, you drop it entirely/);
    assert.match(rules, /There is no third attempt/);
    assert.match(rules, /This holds on ANY subject/);
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

// The customer ended nearly every turn with a question back at the rep. The
// rules only ever said questions were permitted, and three separate
// instructions pushed toward motion without saying a statement counts as
// motion, so a trailing question satisfied all of them at once.
describe("CUSTOMER_RESPONSIVENESS_RULES - question discipline", () => {
  const rules = CUSTOMER_RESPONSIVENESS_RULES;

  test("a turn is allowed to end without a question", () => {
    assert.match(rules, /A QUESTION IS NOT HOW YOU END A TURN/);
    assert.match(rules, /Asking is the exception in this conversation, not its rhythm/);
    assert.match(rules, /A reply that ends on a period is a complete reply/);
    assert.match(rules, /makes you an interrogator rather than someone weighing a decision/);
  });

  test("the worked example ends on a statement and names the staple-on as the error", () => {
    assert.match(rules, /My old one was closer to 18, so that by itself would save me something/);
    assert.match(rules, /That is the whole reply/);
    assert.match(rules, /Do not staple "so what else do you have in that range\?" onto the end of it/);
    assert.match(rules, /is padding, not curiosity/);
  });

  test("a question is warranted by genuine curiosity, never manufactured", () => {
    assert.match(rules, /Ask when you would really ask/);
    assert.match(rules, /genuinely surprised you, worried you, or does not add up/);
    assert.match(rules, /Do not manufacture them/);
  });

  test("the fix asks for variation, not a replacement cadence", () => {
    // A fixed "ask every Nth turn" is the same robotic artifact with different
    // arithmetic, so the rule has to rule that out as explicitly as it rules
    // out asking every turn.
    assert.match(rules, /do not ration them on a schedule/);
    assert.match(rules, /there is no quota to fill and no every-other-turn rhythm to hit/);
    assert.match(rules, /run several turns at a stretch with no customer question in them at all/);
    assert.match(rules, /Let it vary the way it really would/);
  });

  test("advancing the conversation is decoupled from asking", () => {
    assert.match(rules, /MOVING THE CONVERSATION FORWARD DOES NOT REQUIRE A QUESTION/);
    assert.match(rules, /none of that means "ask something"/);
    assert.match(rules, /conceding a point, revealing a detail you had been holding back/);
    assert.match(rules, /only when the honest version of your next turn happens to be one/);
  });

  test("guardrail: no existing question allowance is withdrawn", () => {
    assert.match(rules, /one out-of-scope question and one round of "what else do you have"/);
    assert.match(rules, /None of that changes/);
    assert.match(rules, /answer first, then ask/);
    assert.match(rules, /Never ask instead of answering/);
  });

  test("it reaches every scenario, difficulty, escalation tier, and the demo path", () => {
    // Same composition point the redirect rule relies on: routes.ts and
    // demoV2Routes.ts both build their prompt from the stable prefix.
    for (const difficulty of ["beginner", "intermediate", "advanced", "nonsense-level"]) {
      for (const tier of [0, 1, 2]) {
        assert.match(
          buildCustomerReplyPrompt(PERSONA, [], difficulty, tier),
          /A QUESTION IS NOT HOW YOU END A TURN/,
          `${difficulty}/tier ${tier} must inherit question discipline`,
        );
      }
    }
  });

  test("it lives in the cacheable stable prefix", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2);
    assert.match(prefix, /A QUESTION IS NOT HOW YOU END A TURN/);
    assert.match(prefix, /MOVING THE CONVERSATION FORWARD DOES NOT REQUIRE A QUESTION/);
  });

  test("guardrail: the redirect generalization is untouched", () => {
    assert.match(rules, /FOLLOW A REDIRECT BACK TO DISCOVERY, WHATEVER THE TOPIC WAS/);
    assert.match(rules, /There is no fixed list of topics this covers/);
    assert.match(rules, /APPLY THIS TEST ON EVERY SINGLE TURN/);
  });
});

describe("information layers - the flag", () => {
  test("it is off unless the environment explicitly turns it on", () => {
    assert.equal(informationLayersEnabled({}), false);
    assert.equal(informationLayersEnabled({ [INFORMATION_LAYERS_FLAG]: "" }), false);
    assert.equal(informationLayersEnabled({ [INFORMATION_LAYERS_FLAG]: "0" }), false);
    assert.equal(informationLayersEnabled({ [INFORMATION_LAYERS_FLAG]: "false" }), false);
    assert.equal(informationLayersEnabled({ [INFORMATION_LAYERS_FLAG]: "off" }), false);
  });

  test("the usual truthy spellings turn it on", () => {
    for (const value of ["1", "true", "TRUE", "on", "yes", " true "]) {
      assert.equal(
        informationLayersEnabled({ [INFORMATION_LAYERS_FLAG]: value }),
        true,
        `${JSON.stringify(value)} should enable the feature`,
      );
    }
  });

  test("with the flag off the prompt carries none of the new behavior", () => {
    // The whole point of the flag: someone comparing pre- and post-change
    // behavior has to be comparing the same prompt, not a nearly-identical one.
    const transcript = [
      turn("consultant", "What's the towing capacity you need?"),
      turn("customer", "I honestly haven't thought about it."),
      turn("consultant", "Which trim were you looking at?"),
    ];
    const off = buildCustomerReplyPrompt(PERSONA, transcript, "advanced", 1, "", false);
    for (const marker of [
      "HOW MUCH OF YOURSELF YOU HAND OVER",
      "LAYER ONE",
      "LAYER TWO",
      "LAYER THREE",
      "Nobody has established any of this yet",
      "memorized the catalogue",
    ]) {
      assert.ok(!off.includes(marker), `flag-off prompt must not contain "${marker}"`);
    }
  });

  test("the flag-off prompt survives intact inside the flag-on one", () => {
    // Additive means additive: every line the old prompt had is still there in
    // the same order, with the new material appended rather than interleaved.
    const transcript = [
      turn("customer", "I'm just having a look at the sports cars."),
      turn("consultant", "Which trim did you have in mind?"),
    ];
    const offPrefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 1, false);
    const onPrefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 1, true);
    assert.ok(onPrefix.startsWith(offPrefix));

    const offBlock = buildTurnStateBlock(transcript, false);
    const onBlock = buildTurnStateBlock(transcript, true);
    assert.ok(onBlock.startsWith(offBlock), "gate lines must be appended after the existing state lines");
    assert.ok(onBlock.length > offBlock.length);
  });

  test("turning it on is purely additive: nothing that was there is removed", () => {
    const off = buildCustomerReplyStablePrefix(PERSONA, "intermediate", 0, false);
    const on = buildCustomerReplyStablePrefix(PERSONA, "intermediate", 0, true);
    assert.ok(on.startsWith(off), "the flag-on prefix must extend the flag-off prefix, not rewrite it");
    assert.ok(on.length > off.length);
  });

  test("it reaches every difficulty, escalation tier, and the demo path", () => {
    for (const difficulty of ["beginner", "intermediate", "advanced", "nonsense-level"]) {
      for (const tier of [0, 1, 2]) {
        assert.match(
          buildCustomerReplyPrompt(PERSONA, [], difficulty, tier, "", true),
          /HOW MUCH OF YOURSELF YOU HAND OVER, AND WHEN/,
          `${difficulty}/tier ${tier} must inherit the layer rules`,
        );
      }
    }
  });

  test("it lives in the cacheable stable prefix, after the rules it has to defer to", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "advanced", 2, true);
    assert.match(prefix, /HOW MUCH OF YOURSELF YOU HAND OVER/);
    assert.ok(
      prefix.indexOf("FOLLOW A REDIRECT BACK TO DISCOVERY") < prefix.indexOf("HOW MUCH OF YOURSELF YOU HAND OVER"),
      "the layer rules must come after the responsiveness rules they must not override",
    );
  });
});

describe("information layers - the three layers", () => {
  const rules = buildCustomerReplyStablePrefix(PERSONA, "intermediate", 0, true);

  test("layer one is volunteered readily", () => {
    assert.match(rules, /LAYER ONE, THE THINGS YOU LEAD WITH/);
    assert.match(rules, /This costs you nothing/);
    assert.match(rules, /Volunteer it early and readily/);
    assert.match(rules, /Being cagey about Layer One is not being guarded, it is being annoying/);
  });

  test("layer two opens to a specific question, not a generic prompt", () => {
    assert.match(rules, /LAYER TWO, THE THINGS SOMEONE HAS TO ASK FOR/);
    assert.match(rules, /"Tell me more", "anything else\?"/);
    assert.match(rules, /are not keys to this layer/);
    assert.match(rules, /it picks up something specific you actually said and asks about that thing/);
    // Once earned, it must actually open. A layer that never opens is just a
    // stonewall with extra steps.
    assert.match(rules, /do not make them ask three times for something they have already earned once/);
  });

  test("layer three is gated on earned trust and closed by a premature pitch", () => {
    assert.match(rules, /LAYER THREE, THE THINGS YOU DO NOT TELL STRANGERS/);
    assert.match(rules, /money trouble, a decision you regret, a time you got taken advantage of/);
    assert.match(rules, /roughly two or three questions/);
    assert.match(rules, /they have NOT jumped to selling you something/);
    assert.match(rules, /If they pitch, recommend, or start steering you toward a product before they have done that, the door closes/);
  });

  test("a revealed layer three is said once, not turned into a refrain", () => {
    assert.match(rules, /say it once, plainly/);
    assert.match(rules, /Do not re-announce it every turn afterward/);
  });

  test("guardrail: a closed layer is never an excuse for a non-answer", () => {
    assert.match(rules, /WHILE A LAYER IS STILL CLOSED, YOU ARE STILL HONEST/);
    assert.match(rules, /This is not permission to stonewall, deflect, or answer with nothing/);
    assert.match(rules, /you give them the true but shallower version of it/);
    assert.match(rules, /these layers govern HOW MUCH you say and WHEN, never WHETHER you engage/);
    assert.match(rules, /never a reason to give a non-answer, to change the subject, or to bounce their question back/);
  });

  test("the gate is never narrated out loud", () => {
    assert.match(rules, /NEVER NARRATE ANY OF THIS/);
    assert.match(rules, /do not say they have not earned it/);
    assert.match(rules, /You do not know you have layers/);
    assert.match(rules, /Do this silently/);
  });

  test("guardrail: it does not soften the customer or name a scenario", () => {
    // It has to work for every vertical, so it must sort whatever persona it was
    // handed rather than reference one.
    for (const word of ["vehicle", "SUV", "dealership", "mortgage", "insurance"]) {
      assert.ok(
        !new RegExp(`\\b${word}\\b`, "i").test(rules.slice(rules.indexOf("HOW MUCH OF YOURSELF"))),
        `the layer rules must not name a vertical, found "${word}"`,
      );
    }
  });
});

describe("product alignment gate - reaches the volatile tail only when flagged on", () => {
  const early = [
    turn("customer", "I'm looking at that convertible in the window."),
    turn("consultant", "Great choice. Which trim were you thinking, the base or the fully loaded one?"),
  ];

  test("with the flag off, the gate contributes nothing", () => {
    const block = buildTurnStateBlock(early, false);
    assert.ok(!block.includes("Nobody has established"));
    assert.ok(!block.includes("you are the buyer, not the person who memorized the catalogue"));
  });

  test("with the flag on, the unestablished basics are named", () => {
    const block = buildTurnStateBlock(early, true);
    assert.match(block, /Nobody has established any of this yet: what you actually need it for/);
    assert.match(block, /who else this has to work for besides you/);
    assert.match(block, /why you are doing this at all right now/);
    assert.match(block, /what you are worried about or what went wrong last time/);
  });

  test("a feature dive before the basics produces an in-character redirect, not an announcement", () => {
    const block = buildTurnStateBlock(early, true);
    assert.match(block, /Which trim were you thinking, the base or the fully loaded one\?/);
    assert.match(block, /You are the buyer, not the person who memorized the catalogue/);
    assert.match(block, /the honest answer is usually that you do not know/);
    assert.match(block, /puts the conversation back on ground you can speak to/);
    assert.match(block, /do not lecture them about asking the wrong question/);
    // The customer must never say the quiet part out loud.
    assert.match(block, /Never say out loud that something has to happen first/);
    assert.match(block, /never announce an order to this conversation/);
  });

  test("the gate never overrides the standing duty to answer the live question", () => {
    // buildDirectQuestionLines still demands a real answer in the same block, so
    // the gate has to be compatible with it rather than contradict it.
    const block = buildTurnStateBlock(early, true);
    assert.match(block, /Answering THAT is your job this turn/);
    assert.match(block, /That is a real answer to their question, not a dodge/);
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

describe("CUSTOMER_RESPONSIVENESS_RULES - taking in what the rep volunteers", () => {
  const rules = CUSTOMER_RESPONSIVENESS_RULES;

  test("the rule exists and is stated as a principle about any subject", () => {
    assert.match(rules, /TAKE IN WHAT THEY TELL YOU, WHATEVER IT IS ABOUT/);
    assert.match(rules, /There is no list of which facts count/);
    assert.match(rules, /The subject is irrelevant/);
  });

  test("it names the reaction, not the topic", () => {
    assert.match(rules, /Be taken aback, be concerned, hesitate/);
    assert.match(rules, /Good news is allowed to land too/);
    assert.match(rules, /You are still allowed to want it anyway/);
  });

  test("the failing behaviour is named as the one wrong answer", () => {
    assert.match(rules, /always wrong is carrying on with whatever you were saying before/i);
    assert.match(rules, /you stopped listening/);
  });

  test("the per-turn self-check is in the prompt", () => {
    assert.match(rules, /ASK YOURSELF THIS BEFORE EVERY REPLY/);
    assert.match(rules, /Did the consultant just tell me something new and specific/);
  });

  test("it does not enumerate the facts from the bug report", () => {
    // The whole point. If a future report gets fixed by appending its fact kind
    // here, the rule becomes the topic list that failed before.
    const enumerated = rules.match(/TAKE IN WHAT THEY TELL YOU[\s\S]*?ASK YOURSELF THIS/)?.[0] ?? "";
    for (const word of ["mileage", "odometer", "warranty", "engine", "brakes", "square feet"]) {
      assert.ok(!enumerated.toLowerCase().includes(word), `the rule must not name "${word}"`);
    }
  });

  test("it does not reintroduce the every-turn question habit the cadence fix removed", () => {
    assert.match(rules, /Reacting is not the same as asking/);
    assert.match(rules, /rules further down about not ending every turn on a question still apply/);
    assert.match(rules, /A QUESTION IS NOT HOW YOU END A TURN/);
  });

  test("it reaches every difficulty, every tier and the flag-off prompt", () => {
    for (const difficulty of ["beginner", "intermediate", "advanced", "nonsense-level"]) {
      for (const tier of [0, 1, 2]) {
        const prompt = buildCustomerReplyPrompt(PERSONA, [], difficulty, tier, "", false);
        assert.match(prompt, /TAKE IN WHAT THEY TELL YOU, WHATEVER IT IS ABOUT/);
      }
    }
  });

  test("it is in the cacheable prefix, so it costs nothing per turn", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "intermediate");
    assert.match(prefix, /TAKE IN WHAT THEY TELL YOU, WHATEVER IT IS ABOUT/);
  });
});

describe("buildTurnStateBlock - what the rep volunteered is pinned into the tail", () => {
  const explorer = [
    turn("customer", "I love this Explorer. How does a car seat install in the back?"),
    turn(
      "consultant",
      "I'm not sure this Explorer is right for your family. It's got 100,000 miles on it, it's overpriced, and the suspension is blown out from being driven through the desert.",
    ),
  ];

  test("the disclosure is quoted back and a reaction is demanded", () => {
    const block = buildTurnStateBlock(explorer);
    assert.match(block, /THE CONSULTANT JUST TOLD YOU SOMETHING ABOUT WHAT YOU ARE CONSIDERING/);
    assert.match(block, /100,000 miles/);
    assert.match(block, /suspension is blown out/);
  });

  test("it is NOT flag-gated, because ignoring bad news is broken everywhere", () => {
    for (const layers of [false, true]) {
      assert.match(
        buildTurnStateBlock(explorer, layers),
        /THE CONSULTANT JUST TOLD YOU SOMETHING ABOUT WHAT YOU ARE CONSIDERING/,
      );
    }
  });

  test("a rep turn that only asks adds no disclosure line", () => {
    const block = buildTurnStateBlock([
      turn("customer", "I need something for my commute."),
      turn("consultant", "How long is that commute each way?"),
    ]);
    assert.doesNotMatch(block, /THE CONSULTANT JUST TOLD YOU SOMETHING ABOUT/);
  });

  test("it stays out of the cacheable prefix", () => {
    const prefix = buildCustomerReplyStablePrefix(PERSONA, "intermediate");
    const prompt = buildCustomerReplyPrompt(PERSONA, explorer, "intermediate");
    assert.ok(prompt.startsWith(prefix));
    assert.doesNotMatch(prefix, /THE CONSULTANT JUST TOLD YOU SOMETHING ABOUT/);
    assert.match(prompt, /THE CONSULTANT JUST TOLD YOU SOMETHING ABOUT/);
  });

  test("it sits with the live question, before the older state facts", () => {
    const block = buildTurnStateBlock([
      turn("customer", "I need it to tow."),
      turn("consultant", "The tow rating on this one is well under what you described. What are you pulling?"),
    ]);
    assert.ok(
      block.indexOf("THE CONSULTANT JUST TOLD YOU SOMETHING ABOUT") <
        block.indexOf("Lines you have ALREADY said"),
    );
  });

  test("a rep telling the customer something in another vertical is caught the same way", () => {
    const block = buildTurnStateBlock([
      turn("customer", "We'd want the whole crew in there by autumn."),
      turn("consultant", "The kilns aren't back from the foundry until late next spring."),
    ]);
    assert.match(block, /THE CONSULTANT JUST TOLD YOU SOMETHING ABOUT WHAT YOU ARE CONSIDERING/);
    assert.match(block, /kilns aren't back from the foundry/);
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
    assert.match(prompt, /FOLLOW A REDIRECT BACK TO DISCOVERY, WHATEVER THE TOPIC WAS/);
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
