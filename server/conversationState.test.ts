import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { TranscriptMessage } from "@shared/schema";
import {
  DEFLECTION_STOP_THRESHOLD,
  buildConversationStateLines,
  deriveConversationState,
  hasCustomerAcceptedProposal,
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
