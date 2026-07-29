import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { TranscriptMessage } from "@shared/schema";
import {
  DEFLECTION_STOP_THRESHOLD,
  TRIVIAL_GAP_FRACTION,
  buildConversationStateLines,
  buildDirectQuestionLines,
  buildDiscoveryPhaseLines,
  deriveConversationState,
  deriveDirectQuestion,
  deriveDiscoveryPhase,
  hasCustomerAcceptedProposal,
  parseMoneyAmounts,
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
  test("one redirect leaves the topic open for exactly one more ask", () => {
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
    assert.match(buildConversationStateLines(state).join("\n"), /at most ONE more time/);
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
    assert.match(rendered, /AFTER you have answered/);
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

// ===========================================================================
// Rule H (PR: the show-me loop). The customer answered every question and then
// appended the same "what do you have you can show me?" demand to every answer.
// These cover the two facts the prompt cannot know on its own: whether that
// request has already been made, and whether the rep is still in discovery.
// ===========================================================================

function phaseLines(...lines: string[]): string {
  return buildDiscoveryPhaseLines(deriveDiscoveryPhase(t(...lines))).join("\n");
}

describe("Rule H: the request to be shown options is counted, not guessed", () => {
  test("a first request is recorded and discovery is still in force", () => {
    const state = deriveDiscoveryPhase(
      t("r: What brings you in today?", "c: I need something safe. What do you have that you can show me?"),
    );
    assert.equal(state.showRequests.length, 1);
    assert.equal(state.presentationLine, null);
  });

  test("every re-demand is counted", () => {
    const state = deriveDiscoveryPhase(
      t(
        "r: What safety features matter to you?",
        "c: A backup camera and blind spot. What do you have in your inventory you can show me that has those features?",
        "r: Most of our cars have those. Are you thinking sedan, SUV, or compact?",
        "c: A sedan or maybe a compact SUV. What do you have you can show me with those features?",
      ),
    );
    assert.equal(state.showRequests.length, 2);
  });

  test("a plain answer with no request is not counted as one", () => {
    const state = deriveDiscoveryPhase(
      t("r: Sedan, SUV, or compact?", "c: Probably a sedan, maybe a compact SUV."),
    );
    assert.deepEqual(state.showRequests, []);
    assert.equal(phaseLines("r: Sedan, SUV, or compact?", "c: Probably a sedan, maybe a compact SUV."), "");
  });

  test("the rep's own questions are never read as the customer asking to be shown", () => {
    const state = deriveDiscoveryPhase(t("r: What do you have for a trade-in right now?"));
    assert.deepEqual(state.showRequests, []);
  });
});

describe("Rule H: discovery framing versus presentation", () => {
  test("asking questions before showing is framing, not presenting", () => {
    const state = deriveDiscoveryPhase(
      t("r: Before I show you a bunch of cars, let me ask a few quick questions so I show you the right ones."),
    );
    assert.ok(state.discoveryFraming);
    assert.equal(state.presentationLine, null);
  });

  test("'I've got a few questions' is not mistaken for 'I've got a few options'", () => {
    const state = deriveDiscoveryPhase(t("r: I've got a couple more questions before we go any further."));
    assert.equal(state.presentationLine, null);
  });

  test("pulling options up is presenting", () => {
    const state = deriveDiscoveryPhase(
      t("r: That gives me exactly what I need. I've got a few that fit all of that, let me pull them up for you."),
    );
    assert.ok(state.presentationLine);
  });

  test("a recommendation counts as presenting too", () => {
    const state = deriveDiscoveryPhase(t("r: Based on what you've told me, I'd recommend the hybrid sedan."));
    assert.ok(state.presentationLine);
  });
});

describe("Rule H: the rendered lines", () => {
  test("a repeated request is named and forbidden for this turn", () => {
    const rendered = phaseLines(
      "r: What safety features matter to you?",
      "c: A backup camera and blind spot. What do you have in your inventory you can show me that has those features?",
      "r: Are you thinking sedan, SUV, or compact?",
    );
    assert.match(rendered, /You have ALREADY told them you want to see what they have/);
    assert.match(rendered, /no version of that request tacked onto the end of your answer/);
  });

  test("the framing line tells the customer showing comes later", () => {
    const rendered = phaseLines("r: Before I show you anything, let me ask a few quick questions.");
    assert.match(rendered, /BEFORE they show you anything/);
    assert.match(rendered, /Do not push to be shown options yet/);
  });

  test("presenting replaces suppression with full engagement", () => {
    const rendered = phaseLines(
      "c: What do you have that you can show me?",
      "r: Let me ask you a couple of things first. What's the drive like?",
      "c: About forty miles a day.",
      "r: I've got a few that fit all of that, let me pull them up for you.",
    );
    assert.match(rendered, /is now putting options in front of you/);
    assert.doesNotMatch(rendered, /You have ALREADY told them/);
  });

  test("nothing detected renders nothing at all", () => {
    assert.deepEqual(
      buildDiscoveryPhaseLines(deriveDiscoveryPhase(t("r: How's your day going?", "c: Can't complain."))),
      [],
    );
  });
});

describe("Rule H: derivation is pure and additive", () => {
  test("the same transcript yields the same lines", () => {
    const transcript = t("c: What do you have you can show me?", "r: What matters most to you?");
    assert.deepEqual(
      buildDiscoveryPhaseLines(deriveDiscoveryPhase(transcript)),
      buildDiscoveryPhaseLines(deriveDiscoveryPhase(transcript)),
    );
  });

  test("it leaves the PR #87 and PR #90 derivations alone", () => {
    const transcript = t(
      "c: A backup camera and blind spot. What do you have you can show me with those features?",
      "r: Are you thinking sedan, SUV, or compact?",
    );
    // Rule G still sees the live question, and no conversation-state rule fires.
    assert.ok(deriveDirectQuestion(transcript));
    assert.deepEqual(buildConversationStateLines(deriveConversationState(transcript)), []);
  });
});
