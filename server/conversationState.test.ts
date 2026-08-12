import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { TranscriptMessage } from "@shared/schema";
import {
  DEFLECTION_STOP_THRESHOLD,
  SEQUENCING_STOP_THRESHOLD,
  TRIVIAL_GAP_FRACTION,
  buildConversationStateLines,
  buildFinalAnsweredQuestionGate,
  buildDirectQuestionLines,
  deriveConversationState,
  deriveDirectQuestion,
  extractAskedSubject,
  hasCustomerAcceptedProposal,
  parseMoneyAmounts,
  repeatsClosedAnsweredQuestion,
} from "./conversationState";

// Terse transcript builder: "c: ..." is the customer, "r: ..." is the rep.
function t(...lines: string[]): TranscriptMessage[] {
  return lines.map((line) => {
    const role = line.startsWith("c:") ? "customer" : "consultant";
    return {
      role,
      content: line.slice(2).trim(),
      timestamp: new Date().toISOString(),
    } as TranscriptMessage;
  });
}

function stateLines(...lines: string[]): string {
  return buildConversationStateLines(deriveConversationState(t(...lines))).join("\n");
}

describe("Rule 2: deflected topics stop being asked", () => {
  test("one redirect remains tracked only as a safety-net while reactive-only rules forbid a callback", () => {
    const state = deriveConversationState(
      t(
        "c: What does the warranty cover on this one?",
        "r: The warranty is handled by our service department, they walk you through all of that.",
      ),
    );
    const warranty = state.deflectedTopics.find((d) => d.topic === "warranty");
    assert.ok(warranty, "expected the warranty redirect to be detected");
    assert.equal(warranty!.redirectCount, 1);
    assert.equal(warranty!.closed, false);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /reactive-only rule means you should not raise .* again on your own/i);
    assert.match(rendered, /safety-net/i);
  });

  test("tracks a softly phrased department question before the redirect", () => {
    // This intentionally omits a question mark and inserts "please" between
    // "can you" and "tell", so the former ASK_MARKERS-only gate misses it.
    const state = deriveConversationState(
      t(
        "c: Can you please tell me a little more about the warranty coverage",
        "r: Our service department handles the warranty details.",
      ),
    );
    const warranty = state.deflectedTopics.find((d) => d.topic === "warranty");
    assert.ok(warranty, "the soft warranty ask must be tracked before a department redirect");
    assert.equal(warranty!.redirectCount, 1);
  });

  test("a second redirect closes the topic permanently", () => {
    const state = deriveConversationState(
      t(
        "c: What does the warranty cover?",
        "r: Our service department handles that side of it.",
        "c: Right, but how long is the warranty good for?",
        "r: Honestly the warranty specialist covers that, let's first nail down what you need the vehicle to do.",
      ),
    );
    const warranty = state.deflectedTopics.find((d) => d.topic === "warranty");
    assert.ok(warranty);
    assert.ok(warranty!.redirectCount >= DEFLECTION_STOP_THRESHOLD);
    assert.equal(warranty!.closed, true);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /CLOSED/);
    assert.match(rendered, /Do not raise it again/);
  });

  test("financing is tracked separately from warranty", () => {
    const state = deriveConversationState(
      t(
        "c: What kind of financing do you offer?",
        "r: The finance department handles all of that once we know what you're buying.",
        "c: And what does the warranty look like?",
        "r: Service department covers the warranty side.",
      ),
    );
    const topics = state.deflectedTopics.map((d) => d.topic).sort();
    assert.deepEqual(topics, ["financing", "warranty"]);
    // Each got one redirect, so neither is closed yet.
    assert.deepEqual(
      state.deflectedTopics.map((d) => d.closed),
      [false, false],
    );
  });

  test("a rep mentioning a topic unprompted is not counted as shutting down a question", () => {
    const state = deriveConversationState(
      t("r: We'll get to financing later, but first let's talk about what you need.", "c: Sure."),
    );
    assert.deepEqual(state.deflectedTopics, []);
    assert.deepEqual(buildConversationStateLines(state), []);
  });
});

describe("Rule S: a topic the rep sequences for later stops being re-asked", () => {
  // The reported transcript, near-verbatim. Before this rule existed the customer
  // re-asked the safety question on every following turn, because safety is not
  // one of the four DeflectableTopic values and so no state was ever produced.
  const SAFETY = [
    "r: What brings you in today?",
    "c: I'm looking at this SUV. What's the safety rating on it?",
    "r: I appreciate you wanting to know about the safety features, but let's make sure we find the right vehicle for you first. The safety features on this one don't matter if it's not the right vehicle. What's most important to you in your next vehicle?",
  ];

  test("a sequencing redirect plus discovery is tracked as a safety-net without authorizing a callback", () => {
    const state = deriveConversationState(t(...SAFETY));
    assert.equal(state.sequencedTopics.length, 1);
    const safety = state.sequencedTopics[0];
    assert.match(safety.label, /safety rating/i);
    assert.equal(safety.redirectCount, 1);
    assert.equal(safety.closed, false);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /reactive-only rule means you should not raise .* again on your own/i);
    assert.match(rendered, /safety-net/i);
  });

  test("a second sequencing redirect closes the topic permanently", () => {
    const state = deriveConversationState(
      t(
        ...SAFETY,
        "c: Four-wheel drive matters most, we get a lot of snow. Can you tell me more about the safety rating?",
        "r: We'll come back to that. Before we get into specs, how many people are you hauling around day to day?",
      ),
    );
    assert.equal(state.sequencedTopics.length, 1);
    const safety = state.sequencedTopics[0];
    assert.ok(safety.redirectCount >= SEQUENCING_STOP_THRESHOLD);
    assert.equal(safety.closed, true);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /CLOSED/);
    assert.match(rendered, /Do not raise it again/);
  });

  test("a subject nothing in this codebase has ever heard of gets the same treatment", () => {
    // Tow capacity is not in TOPIC_PATTERNS, not in any marker list, and not
    // named anywhere in the source. It works because the subject is read out of
    // the customer's own question rather than looked up.
    const state = deriveConversationState(
      t(
        "c: What's the tow capacity on this thing?",
        "r: Let's figure out what you're hauling first, then we'll cover tow numbers. What are you towing, and how often?",
      ),
    );
    assert.equal(state.sequencedTopics.length, 1);
    assert.match(state.sequencedTopics[0].label, /tow capacity/i);
    assert.equal(state.sequencedTopics[0].redirectCount, 1);
  });

  test("and so does a second unrelated subject nobody hardcoded", () => {
    const state = deriveConversationState(
      t(
        "c: What are the paint color options?",
        "r: Before we get into colors, let's make sure the vehicle itself is right. How many kids are you fitting in the back?",
      ),
    );
    assert.equal(state.sequencedTopics.length, 1);
    assert.match(state.sequencedTopics[0].label, /paint color/i);
  });

  // Wade's literal words from the voice session, split into the two turns he
  // reported them as. Deliberately NOT cleaned up: no question mark on the
  // customer's ask, no sentence breaks in the rep's reply, no ordering adverb
  // anywhere. The first version of this rule was validated against a tidied-up
  // paraphrase of this and detected nothing at all on the real thing.
  const LITERAL_CUSTOMER =
    "Oh, I appreciate you wanting to show me the right vehicle. Can you please tell me more about the safety features can you make sure that you can give me information on the safety ratings";
  const LITERAL_REP =
    "hey let's make sure we found the right vehicle for you if it's not the right vehicle the safety features on this one doesn't matter let's figure out exactly what you're looking for";

  test("the literal reported voice transcript is detected, punctuation and all", () => {
    const state = deriveConversationState(
      t("r: What brings you in today?", `c: ${LITERAL_CUSTOMER}`, `r: ${LITERAL_REP}`),
    );
    assert.equal(state.sequencedTopics.length, 1);
    assert.match(state.sequencedTopics[0].label, /safety features/i);
    assert.equal(state.sequencedTopics[0].redirectCount, 1);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /reactive-only rule means you should not raise .* again on your own/i);
    assert.match(rendered, /safety-net/i);
  });

  test("the literal transcript is caught by relevance conditioning, with no ordering word present", () => {
    // Guards the actual regression: the reply contains no "first", "before we",
    // or "once we", so an ordering-adverb-only rule cannot see it.
    assert.doesNotMatch(LITERAL_REP, /\bfirst\b|\bbefore we\b|\bonce we\b|\bafter we\b/i);
    assert.equal(
      deriveConversationState(t(`c: ${LITERAL_CUSTOMER}`, `r: ${LITERAL_REP}`)).sequencedTopics.length,
      1,
    );
  });

  test("conditional sequencing works on an unrelated subject too, so it is not one tuned sentence", () => {
    const state = deriveConversationState(
      t(
        "c: I'm curious about the tow capacity",
        "r: honestly until we know what you're hauling the tow numbers don't mean much let's figure out what you actually put in the bed",
      ),
    );
    assert.equal(state.sequencedTopics.length, 1);
    assert.match(state.sequencedTopics[0].label, /tow capacity/i);
  });

  test("relevance conditioning with no discovery pivot is still just a brush-off", () => {
    assert.deepEqual(
      deriveConversationState(
        t("c: What's the safety rating on this one?", "r: If it's not the right vehicle the safety features don't matter."),
      ).sequencedTopics,
      [],
    );
  });

  test("a bare brush-off with no discovery question is not sequencing and is not accepted", () => {
    const state = deriveConversationState(
      t("c: What's the tow capacity on this one?", "r: Let's come back to that later."),
    );
    assert.deepEqual(state.sequencedTopics, []);
    assert.deepEqual(buildConversationStateLines(state), []);
  });

  test("a rep who simply answers has redirected nothing", () => {
    const state = deriveConversationState(
      t("c: What's the tow capacity on this thing?", "r: It's rated to 5,000 pounds."),
    );
    assert.deepEqual(state.sequencedTopics, []);
  });

  test("a question that names no subject produces no state", () => {
    assert.deepEqual(
      deriveConversationState(
        t("c: Can you tell me more about it?", "r: Let's find the right vehicle first. What are you driving today?"),
      ).sequencedTopics,
      [],
    );
  });

  test("the same subject worded differently is one topic, not two", () => {
    const state = deriveConversationState(
      t(
        "c: What's the safety rating on this one?",
        "r: Let's find the right vehicle first. What's your commute like?",
        "c: Thirty minutes of highway. What are the safety ratings like though?",
        "r: We'll circle back to that. Before we get into specs, who else rides with you?",
      ),
    );
    assert.equal(state.sequencedTopics.length, 1, "'safety rating' and 'safety ratings' are the same subject");
    assert.equal(state.sequencedTopics[0].closed, true);
  });
});

describe("Rule S: the four department-handoff topics keep their own mechanism", () => {
  const DEPARTMENT_CASES: [string, string, string][] = [
    [
      "warranty",
      "c: What does the warranty cover on this one?",
      "r: Our service department handles the warranty. Let's find the right vehicle first. What are you driving today?",
    ],
    [
      "financing",
      "c: What kind of financing do you offer?",
      "r: The finance department handles all of that. Let's figure out the vehicle first. What's your commute like?",
    ],
    [
      "loanTerms",
      "c: What loan lengths can you do?",
      "r: The lender sets that, they'll walk you through it. Let's nail down the vehicle first. Who else drives it?",
    ],
    [
      "paymentSpecifics",
      "c: How big a down payment would you need?",
      "r: The finance office handles that side. Let's find the right vehicle first. What are you hauling around?",
    ],
  ];

  for (const [topic, ask, reply] of DEPARTMENT_CASES) {
    test(`${topic} stays with Rule 2 and is never double-counted as sequencing`, () => {
      const state = deriveConversationState(t(ask, reply));
      const deflected = state.deflectedTopics.find((d) => d.topic === topic);
      assert.ok(deflected, `${topic} must still be detected by the existing mechanism`);
      assert.equal(deflected!.redirectCount, 1);
      assert.equal(deflected!.closed, false);
      assert.deepEqual(state.sequencedTopics, [], `${topic} must not also be tracked as sequenced`);
      // Exactly one prompt line about the topic, from Rule 2, worded as before.
      const rendered = buildConversationStateLines(state);
      assert.equal(rendered.length, 1);
      assert.match(rendered[0], /handled elsewhere/);
    });
  }

  test("the two thresholds are independent constants", () => {
    assert.equal(DEFLECTION_STOP_THRESHOLD, 2);
    assert.equal(SEQUENCING_STOP_THRESHOLD, 2);
  });
});

describe("Rule 3: concrete answers already given are never re-asked", () => {
  test("figures the rep quoted are surfaced back as known facts", () => {
    const rendered = stateLines(
      "c: How much is it?",
      "r: That one is $24,500 and it has 38,000 miles on it.",
    );
    assert.match(rendered, /ALREADY given you/);
    assert.match(rendered, /\$24,500/);
  });

  test("no figures means no quoted-facts block at all", () => {
    assert.deepEqual(
      buildConversationStateLines(
        deriveConversationState(t("c: Tell me about it.", "r: It's a great fit for a commuter.")),
      ),
      [],
    );
  });
});

describe("Rule 4: the decision-making structure the rep uncovers is binding", () => {
  test("the rep's question and the customer's answer are both captured", () => {
    const state = deriveConversationState(
      t(
        "r: Is there anyone else involved in the decision, or is this yours to make?",
        "c: It's all me. I'm buying it and I'm paying for it.",
      ),
    );
    assert.ok(state.decisionMaker);
    assert.match(state.decisionMaker!.answer, /I'm paying for it/);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /now FIXED/);
    assert.match(rendered, /do not suddenly produce some other absent person/);
  });

  test("when the rep never asked, nothing is fixed and the customer stays free to raise it", () => {
    const state = deriveConversationState(
      t("c: I'm looking for something for my son.", "r: What does he need it for?"),
    );
    assert.equal(state.decisionMaker, null);
    assert.deepEqual(buildConversationStateLines(state), []);
  });
});

describe("Rule 5: one alternatives round", () => {
  test("an answered 'what else do you have' spends the round", () => {
    const state = deriveConversationState(
      t(
        "c: What else do you have in that range?",
        "r: Honestly, the compact we looked at is the closest fit I have on the lot.",
      ),
    );
    assert.equal(state.alternativesRequests, 1);
    assert.equal(state.alternativesRoundSpent, true);
    assert.match(buildConversationStateLines(state).join("\n"), /one alternatives round and it is spent/);
  });

  test("an unanswered ask does not spend the round", () => {
    const state = deriveConversationState(t("c: Any other options?"));
    assert.equal(state.alternativesRequests, 1);
    assert.equal(state.alternativesRoundSpent, false);
    assert.deepEqual(buildConversationStateLines(state), []);
  });
});

describe("Rules 6 and 8: an accepted solution makes the conversation endable", () => {
  test("acceptance after a proposal is detected and the customer is told to let it end", () => {
    const transcript = t(
      "r: Based on what you've told me, I'd recommend the compact with the higher safety rating.",
      "c: That sounds right, that's exactly what we need.",
    );
    const state = deriveConversationState(transcript);
    assert.ok(state.acceptedSolutionLine);
    assert.equal(hasCustomerAcceptedProposal(transcript), true);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /ALREADY said the proposed solution fits/);
    assert.match(rendered, /Do not invent a new requirement/);
    assert.match(rendered, /at most the ONE thing/);
  });

  test("an agreeable answer to a discovery question is not acceptance of a solution", () => {
    const transcript = t(
      "r: Would it help if I pulled up a couple of compacts?",
      "c: That works for me.",
    );
    assert.equal(hasCustomerAcceptedProposal(transcript), false);
    assert.equal(deriveConversationState(transcript).acceptedSolutionLine, null);
  });

  test("a hedge is not acceptance", () => {
    const transcript = t(
      "r: I'd recommend the compact for what you've described.",
      "c: Maybe. I'll think about it.",
    );
    assert.equal(hasCustomerAcceptedProposal(transcript), false);
  });
});

describe("Rule D: a number the rep has met is recognized as met", () => {
  test("a quote at or under the stated budget is recognized", () => {
    const state = deriveConversationState(
      t(
        "c: My budget is $14,000 and I can't go over that.",
        "r: Out the door that one lands at $13,750.",
      ),
    );
    assert.ok(state.metNeed, "expected the met budget to be detected");
    assert.equal(state.metNeed!.statedAmount, 14000);
    assert.equal(state.metNeed!.quotedAmount, 13750);
    assert.equal(state.metNeed!.gapClosed, false);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /THAT NEED IS MET/);
    assert.match(rendered, /inside the number you gave them/);
    assert.match(rendered, /never say or suggest that they missed your number/);
  });

  test("a trivial overage the rep explicitly absorbs is recognized as met", () => {
    const state = deriveConversationState(
      t(
        "c: My budget is $14,000 and I can't go over that.",
        "r: With tax, tag, and title it's $14,000.02, and I'll cover the two cents, so you're at your number.",
      ),
    );
    assert.ok(state.metNeed, "the two-cent gap must not read as an unmet budget");
    assert.equal(state.metNeed!.statedAmount, 14000);
    assert.equal(state.metNeed!.quotedAmount, 14000.02);
    assert.equal(state.metNeed!.gapClosed, true);
    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /THAT NEED IS MET/);
    assert.match(rendered, /\$0\.02/);
    assert.match(rendered, /absorb that themselves/);
    assert.match(rendered, /do not haggle over the remainder/);
  });

  test("a spoken budget and a spoken quote work the same way (voice path)", () => {
    const state = deriveConversationState(
      t(
        "c: I need to stay under fourteen thousand.",
        "r: It comes to thirteen thousand nine hundred, so that's under where you needed to be.",
      ),
    );
    assert.ok(state.metNeed);
    assert.equal(state.metNeed!.statedAmount, 14000);
  });

  test("a real overage the rep did NOT close leaves the customer free to press", () => {
    const state = deriveConversationState(
      t("c: My budget is $14,000, that's my limit.", "r: The best I can do on that one is $16,500."),
    );
    assert.equal(state.metNeed, null);
    assert.doesNotMatch(buildConversationStateLines(state).join("\n"), /THAT NEED IS MET/);
  });

  test("a gap far bigger than trivial is not met even when the rep offers to absorb it", () => {
    const state = deriveConversationState(
      t(
        "c: My budget is $14,000 and I can't go over that.",
        "r: It's $15,200 but I'll cover some of the difference.",
      ),
    );
    assert.equal(state.metNeed, null, "a $1,200 gap is a real objection, not a rounding error");
    assert.ok(
      15200 - 14000 > 14000 * TRIVIAL_GAP_FRACTION,
      "sanity: the gap must exceed the trivial threshold",
    );
  });

  test("a small unrelated figure does not satisfy a large stated budget", () => {
    const state = deriveConversationState(
      t("c: My budget is $14,000 max.", "r: We could start with a $500 deposit today."),
    );
    assert.equal(state.metNeed, null);
  });

  test("a later, higher budget statement supersedes an earlier met one", () => {
    const state = deriveConversationState(
      t(
        "c: My budget is $14,000.",
        "r: That one is $13,900.",
        "c: Actually my real ceiling is $20,000, and I can't go over that.",
      ),
    );
    assert.equal(state.metNeed, null, "the new number has not been quoted against yet");
  });

  test("a number with no budget framing is not treated as a stated need", () => {
    const state = deriveConversationState(
      t("c: The last one I owned cost $14,000.", "r: This one is $13,000."),
    );
    assert.equal(state.metNeed, null);
  });

  describe("parseMoneyAmounts", () => {
    test("reads digits, decimals, word numbers, and shorthand", () => {
      assert.deepEqual(parseMoneyAmounts("$14,000"), [14000]);
      assert.deepEqual(parseMoneyAmounts("$14,000.02"), [14000.02]);
      assert.deepEqual(parseMoneyAmounts("fourteen thousand"), [14000]);
      assert.deepEqual(parseMoneyAmounts("14k"), [14000]);
      assert.deepEqual(parseMoneyAmounts("twenty five grand"), [25000]);
      assert.deepEqual(parseMoneyAmounts("2000 dollars"), [2000]);
    });

    test("ignores quantities that are not a total price", () => {
      assert.deepEqual(parseMoneyAmounts("22,000 miles"), []);
      assert.deepEqual(parseMoneyAmounts("22 thousand miles"), []);
      assert.deepEqual(parseMoneyAmounts("$450 a month"), []);
      assert.deepEqual(parseMoneyAmounts("$450 monthly"), []);
      assert.deepEqual(parseMoneyAmounts("2,000 square feet"), []);
      assert.deepEqual(parseMoneyAmounts("no numbers here at all"), []);
    });
  });
});

describe("prompt stability", () => {
  test("a conversation with none of these situations produces no extra prompt lines", () => {
    assert.deepEqual(
      buildConversationStateLines(
        deriveConversationState(
          t("c: I need something reliable.", "r: What does your commute look like?"),
        ),
      ),
      [],
    );
  });

  test("derivation is pure: the same transcript yields the same lines", () => {
    const transcript = t(
      "c: What does the warranty cover?",
      "r: Service department handles the warranty.",
      "r: I'd recommend the compact.",
      "c: That works for us.",
    );
    assert.deepEqual(
      buildConversationStateLines(deriveConversationState(transcript)),
      buildConversationStateLines(deriveConversationState(transcript)),
    );
  });
});

// The scenario named in the spec's end-to-end checklist, asserted at the state
// layer: the woman buying for her son, in one transcript.
describe("six-point checklist scenario (deterministic)", () => {
  const TRANSCRIPT = t(
    "c: I'm looking for something for my son, he just started commuting.",
    "r: Tell me what the commute looks like for him.",
    "c: About forty minutes each way. What does the warranty cover on these?",
    "r: Our service department owns the warranty side, they'll walk you through all of that.",
    "c: Okay, but I do want to know how long the warranty lasts.",
    "r: The warranty specialist handles that. Let's first nail down what he actually needs day to day.",
    "c: Fair enough. And what about financing?",
    "r: Finance department handles all of that once we know the vehicle.",
    "c: What kind of financing terms though?",
    "r: Again, the finance team covers that. Before we get into numbers, who else is involved in deciding this?",
    "c: Nobody, it's my decision and I'm paying for it outright.",
    "r: Good to know. Safety is usually top of the list for a new commuter, how do you feel about that?",
    "c: That's my biggest worry, honestly.",
    "r: The compact I'm thinking of is $19,800 with 22,000 miles and a top safety rating. What else do you have, you asked earlier, so let me be straight: this is the closest fit on the lot.",
    "c: What other options are there in that range?",
    "r: Honestly, nothing that beats it on safety for the money.",
    "r: Based on everything you've told me, I'd recommend that compact.",
    "c: That sounds right. That's exactly what we need.",
  );

  test("check 3: both deflectable topics are closed after two redirects each", () => {
    const state = deriveConversationState(TRANSCRIPT);
    const byTopic = Object.fromEntries(state.deflectedTopics.map((d) => [d.topic, d]));
    assert.equal(byTopic.warranty?.closed, true, "warranty must be closed");
    assert.equal(byTopic.financing?.closed, true, "financing must be closed");
  });

  test("check 4: the paying decision maker she stated is fixed", () => {
    const state = deriveConversationState(TRANSCRIPT);
    assert.ok(state.decisionMaker);
    assert.match(state.decisionMaker!.answer, /my decision/i);
    assert.match(
      buildConversationStateLines(state).join("\n"),
      /do not suddenly produce some other absent person/,
    );
  });

  test("check 5: the alternatives round is spent and the conversation is endable", () => {
    const state = deriveConversationState(TRANSCRIPT);
    assert.equal(state.alternativesRoundSpent, true);
    assert.ok(state.acceptedSolutionLine, "the accepted solution must be recognized");
    assert.equal(hasCustomerAcceptedProposal(TRANSCRIPT), true);
  });

  test("check 6: the price she was quoted is carried forward as already answered", () => {
    const rendered = buildConversationStateLines(deriveConversationState(TRANSCRIPT)).join("\n");
    assert.match(rendered, /\$19,800/);
  });
});

// ---------------------------------------------------------------------------
// Rule G: the rep's live question. Turn-scoped, so it is derived and rendered
// separately from the cross-turn conversation state above.
// ---------------------------------------------------------------------------

function questionLines(...lines: string[]): string {
  return buildDirectQuestionLines(deriveDirectQuestion(t(...lines))).join("\n");
}

describe("Rule G: identifying the question the customer owes an answer to", () => {
  test("every ask in a multi-sentence rep message is pulled out and quoted", () => {
    const q = deriveDirectQuestion(
      t(
        "c: I just want something reliable.",
        "r: Of course. But when you say reliable, what specifically concerns you? Tell me what's on your mind.",
      ),
    );
    assert.ok(q);
    assert.deepEqual(q!.asks, [
      "But when you say reliable, what specifically concerns you?",
      "Tell me what's on your mind.",
    ]);
    // The lead-in sentence is not an ask and is left out of the quote.
    assert.ok(!q!.asks.some((a) => a.includes("Of course")));
  });

  test("an imperative ask counts even with no question mark (the voice path drops them)", () => {
    const q = deriveDirectQuestion(t("r: Walk me through what a normal week looks like for you."));
    assert.ok(q);
    assert.equal(q!.narrowing, false);
  });

  test("a rep message that asks nothing produces no lines", () => {
    assert.equal(deriveDirectQuestion(t("c: Hi.", "r: Nice to meet you, I'm Sam.")), null);
    assert.deepEqual(buildDirectQuestionLines(null), []);
  });

  test("a question the customer has already replied to is no longer live", () => {
    assert.equal(deriveDirectQuestion(t("r: What brings you in today?", "c: Just looking around.")), null);
  });

  test("an empty streamed placeholder does not retire the live question", () => {
    const q = deriveDirectQuestion(t("r: What brings you in today?", "c: "));
    assert.ok(q, "the placeholder the streamed turn is about to fill is not an answer");
  });

  test("the rendered line names the ask and forbids dodging or bouncing it back", () => {
    const rendered = questionLines("r: What are you driving now?");
    assert.match(rendered, /JUST ASKED YOU SOMETHING DIRECTLY/);
    assert.match(rendered, /"What are you driving now\?"/);
    assert.match(rendered, /unrelated concern, a non-answer, or a change of subject/);
    assert.match(rendered, /do not bounce the question back/);
    // Guardrail: answering is required, guardedness is not surrendered.
    assert.match(rendered, /still be guarded about how much you give them/);
    assert.match(rendered, /stop after the relevant answer/i);
    assert.match(rendered, /separate customer agenda/i);
  });
});

describe("Rule G: narrowing questions demand a committed specific", () => {
  test("an explicit 'what specifically' narrows", () => {
    assert.equal(deriveDirectQuestion(t("r: When you say reliable, what specifically worries you?"))!.narrowing, true);
  });

  test("an option list narrows", () => {
    assert.equal(deriveDirectQuestion(t("r: Are you thinking sedan, SUV, or truck?"))!.narrowing, true);
    assert.equal(deriveDirectQuestion(t("r: Is it the transmission or the engine?"))!.narrowing, true);
  });

  test("a plain open question is not a narrowing", () => {
    assert.equal(deriveDirectQuestion(t("r: What brings you in today?"))!.narrowing, false);
  });

  test("a stray 'or' is not an option list", () => {
    const q = deriveDirectQuestion(
      t("r: So picture yourself two or three months from now, what are you driving?"),
    );
    assert.equal(q!.narrowing, false, "'two or three months' is not a menu of choices");
  });

  test("the vague line the narrowing responds to is quoted back", () => {
    const q = deriveDirectQuestion(
      t("c: Something really good on gas.", "r: Are you after something economical, a hybrid, or fully electric?"),
    );
    assert.equal(q!.vagueAnswer, "Something really good on gas.");
    assert.match(questionLines(
      "c: Something really good on gas.",
      "r: Are you after something economical, a hybrid, or fully electric?",
    ), /You had been general with them/);
  });

  test("a customer who was already specific is not accused of being vague", () => {
    const q = deriveDirectQuestion(
      t("c: My last transmission blew at 80,000 miles.", "r: Which matters most, the mileage or the service history?"),
    );
    assert.ok(q!.narrowing);
    assert.equal(q!.vagueAnswer, null);
  });

  test("the narrowing line demands a concrete commit and names the answer it forbids", () => {
    const rendered = questionLines(
      "c: I just want something reliable.",
      "r: When you say reliable, what specifically concerns you?",
    );
    assert.match(rendered, /NARROWS things to a specific, and you must COMMIT to one/);
    assert.match(rendered, /the actual part, the actual situation/);
    assert.match(rendered, /Staying general a second time/);
  });
});

describe("Rule G: a redirected premature question is accepted, not re-pushed", () => {
  test("a redirect plus a discovery question in one message is recognized", () => {
    const q = deriveDirectQuestion(
      t(
        "c: What warranties does it come with?",
        "r: Warranties are handled in financing once we've found your car. Let's find the right vehicle first. What are you driving today?",
      ),
    );
    assert.ok(q);
    assert.equal(q!.redirectedTopic, "warranty or service coverage");
  });

  test("the rendered line tells the customer to accept it and answer instead", () => {
    const rendered = questionLines(
      "c: How does financing work here?",
      "r: The finance team handles all of that once we know the vehicle. So what do you need this thing to do for you?",
    );
    assert.match(rendered, /Accept that redirect/);
    assert.match(rendered, /do not spend this turn pushing financing, credit, or lender questions again/);
  });

  test("a redirect with no premature question behind it is not attributed to the customer", () => {
    const q = deriveDirectQuestion(
      t("c: I need it by the end of the month.", "r: Let's first nail down what you actually need. What's the drive like?"),
    );
    assert.equal(q!.redirectedTopic, null);
  });

  test("an ordinary question carries no redirect line at all", () => {
    assert.doesNotMatch(questionLines("r: What brings you in today?"), /Accept that redirect/);
  });
});

describe("Rule Q: answered customer factual questions do not get re-asked", () => {
  test("records Frank's tow-capacity question and a specific pound range as closed", () => {
    const transcript = t(
      "c: What towing capacity does this truck have?",
      "r: This truck is rated to tow 12,000 to 14,000 pounds depending on configuration.",
    );
    const state = deriveConversationState(transcript);
    assert.equal(state.answeredCustomerQuestions.length, 1);
    const towing = state.answeredCustomerQuestions[0];
    assert.equal(towing.status, "answered");
    assert.match(towing.label, /towing capacity/i);
    assert.match(towing.answer, /12,000 to 14,000 pounds/i);

    const rendered = buildConversationStateLines(state).join("\n");
    assert.match(rendered, /ANSWERED AND CLOSED/);
    assert.match(rendered, /Do NOT ask another version/i);
    assert.match(rendered, /brief natural reaction/i);
  });

  test("ties a rephrased tow question to the already answered factual topic", () => {
    const state = deriveConversationState(
      t(
        "c: How much can this truck tow?",
        "r: It can tow 12,000 to 14,000 pounds depending on configuration.",
        "c: Okay. What is the tow capacity again?",
        "r: Like I said, 12,000 to 14,000 pounds depending on configuration.",
      ),
    );
    assert.equal(state.answeredCustomerQuestions.length, 1);
    assert.equal(state.answeredCustomerQuestions[0].status, "answered");
    assert.match(buildConversationStateLines(state).join("\n"), /same fact again with different wording/i);
  });

  test("keeps every towing-package/capacity surface form inside one final closed boundary", () => {
    const initial = "What specific towing package and towing capacity does this truck have?";
    const rephrase = "Can you tell me about the features that come with the towing package?";
    const subject = extractAskedSubject(initial);
    const rephrasedSubject = extractAskedSubject(rephrase);
    assert.deepEqual(subject?.keywords, ["specific", "tow", "package", "capacity"]);
    assert.deepEqual(rephrasedSubject?.keywords, ["feature"]);

    const state = deriveConversationState(
      t(initial.startsWith("c:") ? initial : `c: ${initial}`, "r: This truck can tow 12,000 to 14,000 pounds depending on configuration."),
    );
    const gate = buildFinalAnsweredQuestionGate(state).join("\n");
    assert.match(gate, /FINAL ANSWERED-QUESTION GATE/);
    assert.match(gate, /TOWING-CAPABILITY BOUNDARY/);
    assert.match(gate, /towing features\/options\/configurations\/specifications/i);
    assert.match(gate, /What comes with the towing package/i);
    assert.match(gate, /How does it perform with a load/i);
  });

  test("keeps the stronger towing boundary out of non-auto factual questions", () => {
    const state = deriveConversationState(
      t(
        "c: What is the fixed interest rate on this mortgage?",
        "r: The fixed rate is 6.25% for this loan program.",
      ),
    );
    const gate = buildFinalAnsweredQuestionGate(state).join("\n");
    assert.match(gate, /FINAL ANSWERED-QUESTION GATE/);
    assert.doesNotMatch(gate, /TOWING-CAPABILITY BOUNDARY/);
  });

  test("recognizes rephrased towing capability questions without mistaking a separate fuel question for one", () => {
    const state = deriveConversationState(
      t(
        "c: What specific towing package and towing capacity does this truck have?",
        "r: This truck can tow 12,000 to 14,000 pounds depending on configuration.",
      ),
    );
    assert.equal(
      repeatsClosedAnsweredQuestion(state, "What features come with the towing package?"),
      true,
    );
    assert.equal(
      repeatsClosedAnsweredQuestion(state, "How does it handle long distances when towing heavy loads?"),
      true,
    );
    assert.equal(
      repeatsClosedAnsweredQuestion(
        state,
        "What I really need to know next is how its payload capacity holds up under heavy use. What’s the maximum weight it can handle in the bed?",
      ),
      true,
    );
    assert.equal(
      repeatsClosedAnsweredQuestion(state, "What fuel economy can I expect when not towing?"),
      false,
    );
  });

  test("works for a different vertical's named fact instead of vehicle vocabulary", () => {
    const state = deriveConversationState(
      t(
        "c: What is the fixed interest rate on this mortgage?",
        "r: The fixed rate is 6.25% for this loan program.",
      ),
    );
    assert.equal(state.answeredCustomerQuestions.length, 1);
    assert.equal(state.answeredCustomerQuestions[0].status, "answered");
    assert.match(state.answeredCustomerQuestions[0].label, /fixed interest rate/i);
    assert.match(buildConversationStateLines(state).join("\n"), /ANSWERED AND CLOSED/);
  });

  test("allows exactly one concise clarification after a genuinely vague answer", () => {
    const first = deriveConversationState(
      t(
        "c: What towing capacity does this truck have?",
        "r: It should be able to handle a trailer, but I would need to check the exact rating.",
      ),
    );
    assert.equal(first.answeredCustomerQuestions.length, 1);
    assert.equal(first.answeredCustomerQuestions[0].status, "vague");
    assert.equal(first.answeredCustomerQuestions[0].clarificationUsed, false);
    assert.match(buildConversationStateLines(first).join("\n"), /may make ONE concise clarification directly about it/i);

    const afterClarification = deriveConversationState(
      t(
        "c: What towing capacity does this truck have?",
        "r: It should be able to handle a trailer, but I would need to check the exact rating.",
        "c: I need the exact number. How much can it tow?",
        "r: I still cannot confirm that number right now.",
      ),
    );
    assert.equal(afterClarification.answeredCustomerQuestions.length, 1);
    assert.equal(afterClarification.answeredCustomerQuestions[0].status, "vague");
    assert.equal(afterClarification.answeredCustomerQuestions[0].clarificationUsed, true);
    assert.match(buildConversationStateLines(afterClarification).join("\n"), /already used your ONE fair clarification/i);
    assert.match(buildConversationStateLines(afterClarification).join("\n"), /Do not ask it again/i);
  });

  test("does not mistake a discovery pivot for a vague factual answer", () => {
    const state = deriveConversationState(
      t(
        "c: What towing capacity does this truck have?",
        "r: Let's first figure out what you are hauling. What are you towing, and how often?",
      ),
    );
    assert.deepEqual(state.answeredCustomerQuestions, []);
  });
});

describe("Rule G: a topic the rep sequences for later is answered, not re-asked", () => {
  // The exact turn the bug produced: the customer replied "That sounds good, but
  // can you tell me more about the safety rating?" instead of answering.
  const REPORTED = [
    "c: I'm looking at this SUV. What's the safety rating on it?",
    "r: I appreciate you wanting to know about the safety features, but let's make sure we find the right vehicle for you first. The safety features on this one don't matter if it's not the right vehicle. What's most important to you in your next vehicle?",
  ] as const;

  test("the sequenced subject is picked up out of the customer's own words", () => {
    const q = deriveDirectQuestion(t(...REPORTED));
    assert.ok(q);
    assert.match(q!.sequencedTopic ?? "", /safety rating/i);
    assert.equal(q!.redirectedTopic, null, "safety is not a department handoff");
  });

  test("the rendered line tells the customer to answer the discovery question instead", () => {
    const rendered = questionLines(...REPORTED);
    assert.match(rendered, /"What's most important to you in your next vehicle\?"/);
    assert.match(rendered, /proposed getting to it later/);
    assert.match(rendered, /do not spend this turn asking about safety rating again/);
  });

  test("an arbitrary subject works the same way", () => {
    const q = deriveDirectQuestion(
      t(
        "c: What's the tow capacity on this thing?",
        "r: Let's figure out what you're hauling first, then we'll get to numbers. What are you towing?",
      ),
    );
    assert.match(q!.sequencedTopic ?? "", /tow capacity/i);
  });

  test("a sequencing phrase with no question behind it is not attributed to the customer", () => {
    const q = deriveDirectQuestion(
      t("c: I need it by the end of the month.", "r: Let's find the right vehicle first. What's the drive like?"),
    );
    assert.equal(q!.sequencedTopic, null);
  });

  test("a department handoff is reported once, by the existing mechanism only", () => {
    const q = deriveDirectQuestion(
      t(
        "c: What kind of financing do you offer?",
        "r: Finance handles that once we've found your car. Let's find the right vehicle first. What are you driving today?",
      ),
    );
    assert.equal(q!.redirectedTopic, "financing, credit, or lender questions");
    assert.equal(q!.sequencedTopic, null);
  });

  test("an ordinary question carries no sequencing line at all", () => {
    assert.doesNotMatch(questionLines("r: What brings you in today?"), /proposed getting to it later/);
  });

  test("the literal reported voice transcript produces the turn-scoped acceptance line", () => {
    const rendered = questionLines(
      "c: Oh, I appreciate you wanting to show me the right vehicle. Can you please tell me more about the safety features can you make sure that you can give me information on the safety ratings",
      "r: hey let's make sure we found the right vehicle for you if it's not the right vehicle the safety features on this one doesn't matter let's figure out exactly what you're looking for",
    );
    assert.match(rendered, /proposed getting to it later/);
    assert.match(rendered, /do not spend this turn asking about safety features again/);
  });
});

describe("Rule G: derivation is pure and additive", () => {
  test("the same transcript yields the same lines", () => {
    const transcript = t("c: I just want something reliable.", "r: What specifically worries you, the engine, the transmission, the brakes?");
    assert.deepEqual(
      buildDirectQuestionLines(deriveDirectQuestion(transcript)),
      buildDirectQuestionLines(deriveDirectQuestion(transcript)),
    );
  });

  test("it does not disturb the cross-turn conversation state", () => {
    // The PR #87 state derivation is untouched: a plain discovery question still
    // produces no conversation-state lines.
    assert.deepEqual(
      buildConversationStateLines(
        deriveConversationState(t("c: I need something reliable.", "r: What does your commute look like?")),
      ),
      [],
    );
  });
});
