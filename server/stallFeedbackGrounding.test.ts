import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TranscriptMessage } from "@shared/schema";
import {
  buildStallActionGroundingBlock,
  deriveStallActionCoverage,
  type StallActionCategory,
} from "./feedbackGrounding";
import {
  STALL_FEEDBACK_ADJUDICATION_INSTRUCTION,
  scoreTranscript,
  type ScoreResponder,
} from "./llm";

type ProductionSession = {
  sessionId: number;
  transcript: string;
};

const PRODUCTION_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/wade-stall-sessions-528-530.json", import.meta.url),
);
const PRODUCTION_FIXTURE_TEXT = readFileSync(PRODUCTION_FIXTURE_PATH, "utf8");
const PRODUCTION_SESSIONS = JSON.parse(PRODUCTION_FIXTURE_TEXT) as ProductionSession[];

function productionTranscript(sessionId: number): TranscriptMessage[] {
  const session = PRODUCTION_SESSIONS.find((candidate) => candidate.sessionId === sessionId);
  assert.ok(session, `missing production session ${sessionId}`);
  return JSON.parse(session.transcript) as TranscriptMessage[];
}

function covered(
  transcript: TranscriptMessage[],
  category: StallActionCategory,
  turn: number,
): { quote: string } {
  const action = deriveStallActionCoverage(transcript).find(
    (candidate) => candidate.category === category && candidate.turn === turn,
  );
  assert.ok(action, `expected ${category} at turn ${turn}`);
  return action;
}

const AUTO_STALL_TRANSCRIPT: TranscriptMessage[] = [
  { role: "customer", content: "I like the SUV, but please email me a quote so I can think it over.", timestamp: "t1" },
  {
    role: "consultant",
    content:
      "I understand wanting time to review it. Before I email you a quote, what would you like to compare or confirm so I can make it useful?",
    timestamp: "t2",
  },
  { role: "customer", content: "I need to compare my trade-in and current lease payment.", timestamp: "t3" },
  {
    role: "consultant",
    content:
      "Let's pull up your trade-in and current payment together. If you wait until your lease ends, what changes for you?",
    timestamp: "t4",
  },
];

const STALL_RESPONSE = JSON.stringify({
  needsDiscovery: 75,
  objectionPrevention: 75,
  trustBuilding: 75,
  naturalClose: 75,
  relationshipContinuity: 75,
  closeOutcome: "recommendation_made",
  feedback: "Deterministic responder output.",
  stallEvidence: {
    questionTypesUsed: [],
    redFlagsTriggered: [],
    rewardedBehaviorsObserved: [],
  },
});

function scoringResponse(feedback: string): string {
  return JSON.stringify({ ...JSON.parse(STALL_RESPONSE), feedback });
}

function captureScoringPrompt(): { responder: ScoreResponder; input: () => string } {
  let seen = "";
  return {
    responder: async (input) => {
      seen = input;
      return STALL_RESPONSE;
    },
    input: () => seen,
  };
}

function praiseDecision(turn: number, observation: string) {
  return {
    disposition: "praise_only",
    strengths: [{ traineeTurn: turn, observation }],
    improvement: null,
  };
}

const acceptDeterministicFeedback: ScoreResponder = async () =>
  JSON.stringify(praiseDecision(2, "This gave the customer a clear invitation to explain what they needed."));

describe("stall feedback grounding - exact production transcripts", () => {
  test("uses the supplied 528/529/530 export byte-for-byte as a fixture", () => {
    assert.equal(
      createHash("sha256").update(PRODUCTION_FIXTURE_TEXT).digest("hex"),
      "776355aca0e7e4c57f37638993fb5e4256c40a2900887d9b6f90b4b016f102a5",
    );
  });

  test("session 528 records the financial-concern diagnostic and future-impact question already taken", () => {
    const transcript = productionTranscript(528);

    assert.equal(
      covered(transcript, "diagnosticQuestion", 24).quote,
      "So it sounds like to me you're concerned about your finances, not so much fixing the roof. Tell me a little bit about your finances and what your concern is and let me see what I can do to help.",
    );
    assert.equal(
      covered(transcript, "futureImpactQuestion", 22).quote,
      "I totally understand, Mr. Smith, Let me ask you this question. Are you planning on letting your roof go without getting it fixed?",
    );
    assert.match(
      buildStallActionGroundingBlock(transcript),
      /Turn 24: diagnostic question about the concern, reason, or decision process — ALREADY COVERED by the CONSULTANT/,
    );
  });

  test("session 529 records turn 10 as the diagnostic question it is, not a cost summary", () => {
    const transcript = productionTranscript(529);
    assert.equal(
      covered(transcript, "diagnosticQuestion", 10).quote,
      "When you say savings, Mr. Smith, and you say you want to see how it all breaks down, what savings are we talking about?",
    );

    const block = buildStallActionGroundingBlock(transcript);
    assert.match(block, /Turn 10: clarification of the stall; diagnostic question.*ALREADY COVERED by the CONSULTANT/);
    assert.match(block, /do not call a diagnostic question a cost summary/);
  });

  test("session 530 records the post-review diagnostic and collaborative data-gathering already taken", () => {
    const transcript = productionTranscript(530);
    assert.equal(
      covered(transcript, "diagnosticQuestion", 30).quote,
      "Well, tell me exactly how we do that. How do we make sure that you're comfortable with the numbers being solid?",
    );
    assert.equal(
      covered(transcript, "collaborativeReviewDataGathering", 22).quote,
      "Yeah, I totally understand that would be important to you. And I understand that you're looking For more information that you're not going to be able to have if you don't have your electric bills. So let's log on to the electric company's website here and let's pull your history. And we can look and see how much electricity has gone up over the past five years. And then we can see how much your solar bill would prevent you from getting electrical charges, plus your $50 credit. And then we can determine a future projection. On how much money this is going to save you, and it all starts with $450 per month.",
    );
  });
});

describe("stall feedback grounding - a different vertical", () => {
  test("an automotive quote stall covers acknowledgement, a quote boundary, diagnostics, data gathering, and future impact", () => {
    const coverage = deriveStallActionCoverage(AUTO_STALL_TRANSCRIPT);
    const at = (category: StallActionCategory, turn: number) =>
      coverage.find((action) => action.category === category && action.turn === turn);

    assert.ok(at("validationAcknowledgement", 2));
    assert.ok(at("prematureQuoteBoundary", 2));
    assert.ok(at("diagnosticQuestion", 2));
    assert.ok(at("collaborativeReviewDataGathering", 4));
    assert.ok(at("futureImpactQuestion", 4));
  });
});

describe("scoreTranscript - stall action grounding is binding and stall-only", () => {
  test("the real scoring path gives the model all three production protections before it can write feedback", async () => {
    const cap = captureScoringPrompt();
    await scoreTranscript(productionTranscript(528), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: cap.responder,
      stallFeedbackAdjudicator: acceptDeterministicFeedback,
    });

    assert.match(cap.input(), /STALL ACTION PRE-CHECK/);
    assert.match(
      cap.input(),
      /Turn 24: diagnostic question about the concern, reason, or decision process — ALREADY COVERED by the CONSULTANT/,
    );
    assert.match(
      cap.input(),
      /Never say an action listed above was missing, never recommend a materially equivalent action as though the consultant did not take it/,
    );
    assert.match(
      cap.input(),
      /only if you first acknowledge the covered action, cite its turn, and explain the specific additional work that remains/,
    );
  });

  test("the same scoreTranscript path never appends the stall block outside dedicated stall sessions", async () => {
    const cap = captureScoringPrompt();
    await scoreTranscript(AUTO_STALL_TRANSCRIPT, "intermediate", "consulting", null, {
      responder: cap.responder,
      cache: {
        getScoreCacheEntry: async () => undefined,
        createScoreCacheEntry: async (entry) => entry as never,
      },
    });

    assert.ok(!cap.input().includes("STALL ACTION PRE-CHECK"));
    assert.ok(!cap.input().includes("boundary-setting around premature quoting"));
  });
});

describe("stall feedback grounding - structured AI decision boundary", () => {
  const LIVE_528 = "Probe specific calculations and assumptions behind the financial concern.";
  const LIVE_529 = "Ask what would build confidence in the savings.";
  const LIVE_530 = "Explore the customer's concerns further.";
  const LIVE_AUTOMOTIVE = "What changes for you if you wait until your lease ends?";

  test("the four live paraphrases cannot leak because the renderer ignores arbitrary model prose", async () => {
    for (const [transcript, leakedProse, strengthTurn] of [
      [productionTranscript(528), LIVE_528, 24],
      [productionTranscript(529), LIVE_529, 10],
      [productionTranscript(530), LIVE_530, 30],
      [AUTO_STALL_TRANSCRIPT, LIVE_AUTOMOTIVE, 4],
    ] as const) {
      let calls = 0;
      const result = await scoreTranscript(transcript, "intermediate", "consulting", null, {
        stallType: "think_it_over",
        responder: async () => scoringResponse(leakedProse),
        stallFeedbackAdjudicator: async (input) => {
          calls += 1;
          if (calls === 1) {
            assert.ok(input.includes(STALL_FEEDBACK_ADJUDICATION_INSTRUCTION));
            // Invalid: the improvement is a covered category with no
            // acknowledgement/evidence. Its advice is never rendered.
            return JSON.stringify({
              disposition: "accepted",
              strengths: [{ traineeTurn: strengthTurn, observation: "This invited the customer to explain the concern in their own words." }],
              improvement: {
                category: "diagnosticQuestion",
                acknowledgementCoveredTurns: [],
                narrowerGap: "more detail",
                laterCustomerEvidenceTurn: 1,
                evidenceTerms: ["customer"],
                advice: leakedProse,
              },
            });
          }
          assert.match(input, /VALIDATION FAILURES/);
          return JSON.stringify(praiseDecision(strengthTurn, "This gave the customer a clear opportunity to explain the concern before the conversation moved on."));
        },
      });
      assert.equal(calls, 2);
      assert.ok(!result.feedback.includes(leakedProse));
      assert.match(result.feedback, new RegExp(`At turn ${strengthTurn}`));
      assert.equal(result.stallFeedbackAudit?.disposition, "praise_only");
    }
  });

  test("a validated praise-only AI decision produces useful exact-turn feedback", async () => {
    const result = await scoreTranscript(productionTranscript(528), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () => scoringResponse(LIVE_528),
      stallFeedbackAdjudicator: async () =>
        JSON.stringify(praiseDecision(24, "You invited the customer to name the financial concern in their own words.")),
    });
    assert.match(result.feedback, /At turn 24/);
    assert.match(result.feedback, /finances and what your concern is/);
    assert.ok(!result.feedback.includes("Probe specific calculations"));
  });

  test("rejects tautological strength labels and requires a conversational accomplishment", async () => {
    let calls = 0;
    const result = await scoreTranscript(productionTranscript(528), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () => scoringResponse(LIVE_528),
      stallFeedbackAdjudicator: async () => {
        calls += 1;
        return JSON.stringify(
          calls === 1
            ? praiseDecision(24, "This was a grounded diagnostic action.")
            : praiseDecision(24, "This invited the customer to name the financial constraint in their own words."),
        );
      },
    });
    assert.equal(calls, 2);
    assert.match(result.feedback, /invited the customer to name the financial constraint/i);
    assert.ok(!result.feedback.includes("grounded diagnostic action"));
  });

  test("accepts exactly one valid top-level decision from fenced, wrapped, concatenated model output", async () => {
    const decision = praiseDecision(
      24,
      "This invited the customer to name the financial concern before a solution was proposed.",
    );
    const result = await scoreTranscript(productionTranscript(528), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () => scoringResponse(LIVE_528),
      stallFeedbackAdjudicator: async () =>
        `Here is the decision:\n\`\`\`json\n${JSON.stringify(decision)}\n\`\`\`\nHelpful note follows.\n${JSON.stringify({ duplicate: true })}`,
    });
    assert.match(result.feedback, /At turn 24/);
    assert.match(result.feedback, /invited the customer to name the financial concern/i);
  });

  test("extracts the first usable base scoring object when a stall scorer appends another JSON object", async () => {
    const decision = praiseDecision(
      24,
      "This invited the customer to name the financial concern before a solution was proposed.",
    );
    const result = await scoreTranscript(productionTranscript(528), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () =>
        `${scoringResponse(LIVE_528)}\nModel note after JSON.\n${JSON.stringify({ duplicate: "ignored" })}`,
      stallFeedbackAdjudicator: async () => JSON.stringify(decision),
    });
    assert.match(result.feedback, /At turn 24/);
    assert.match(result.feedback, /financial concern/i);
  });

  test("a malformed initial adjudicator response recovers through the bounded correction path", async () => {
    let calls = 0;
    const result = await scoreTranscript(productionTranscript(528), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () => scoringResponse(LIVE_528),
      stallFeedbackAdjudicator: async () => {
        calls += 1;
        return calls === 1
          ? '{"disposition":"praise_only"} trailing non-json'
          : JSON.stringify(
              praiseDecision(
                24,
                "This invited the customer to name the financial concern before a solution was proposed.",
              ),
            );
      },
    });
    assert.equal(calls, 2);
    assert.match(result.feedback, /At turn 24/);
    assert.ok(result.feedback.length > 0);
  });

  test("permits a genuinely narrower session-529 improvement when later typical-usage evidence supports it", async () => {
    const result = await scoreTranscript(productionTranscript(529), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () => scoringResponse("Ask what would build confidence in the savings."),
      stallFeedbackAdjudicator: async () =>
        JSON.stringify({
          disposition: "corrected",
          strengths: [
            {
              traineeTurn: 10,
              observation: "This clarified what the customer meant by savings instead of assuming the concern.",
            },
          ],
          improvement: {
            category: "diagnosticQuestion",
            acknowledgementCoveredTurns: [10],
            narrowerGap: "whether the estimate reflects the customer's typical usage",
            laterCustomerEvidenceTurn: 11,
            evidenceTerms: ["typical", "usage"],
            advice: "Ask which usage pattern makes the estimate feel least realistic so you can address that distinct concern.",
          },
        }),
    });

    assert.match(result.feedback, /You already diagnostic question about the concern, reason, or decision process at turn 10/);
    assert.match(result.feedback, /supported by the customer at turn 11/);
    assert.match(result.feedback, /typical usage/);
    assert.match(result.feedback, /which usage pattern/);
    assert.equal(result.stallFeedbackAudit?.improvement?.laterCustomerEvidenceTurn, 11);
  });

  test("final recovery is attempted exactly once and can return praise when no defensible gap exists", async () => {
    let calls = 0;
    const result = await scoreTranscript(productionTranscript(530), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () => scoringResponse(LIVE_530),
      stallFeedbackAdjudicator: async (input) => {
        calls += 1;
        if (calls === 3) {
          assert.match(input, /FINAL SAFE RECOVERY/);
          return JSON.stringify(praiseDecision(30, "This invited the customer to identify the data that would build confidence."));
        }
        return JSON.stringify({
          disposition: calls === 1 ? "accepted" : "corrected",
          strengths: [{ traineeTurn: 30, observation: "This invited the customer to explain what would make the numbers feel solid." }],
          improvement: {
            category: "diagnosticQuestion",
            acknowledgementCoveredTurns: [],
            narrowerGap: "more detail",
            laterCustomerEvidenceTurn: 31,
            evidenceTerms: ["bills"],
            advice: LIVE_530,
          },
        });
      },
    });
    assert.equal(calls, 3);
    assert.match(result.feedback, /At turn 30/);
    assert.ok(!result.feedback.includes(LIVE_530));
  });

  test("an invalid recovery falls back to useful deterministic praise instead of no feedback", async () => {
    let calls = 0;
    const result = await scoreTranscript(productionTranscript(530), "intermediate", "consulting", null, {
      stallType: "think_it_over",
      responder: async () => scoringResponse(LIVE_530),
      stallFeedbackAdjudicator: async () => {
        calls += 1;
        return JSON.stringify({
          disposition: "corrected",
          strengths: [],
          improvement: {
            category: "diagnosticQuestion",
            acknowledgementCoveredTurns: [],
            narrowerGap: "more detail",
            laterCustomerEvidenceTurn: 31,
            evidenceTerms: ["bills"],
            advice: LIVE_530,
          },
        });
      },
    });
    assert.equal(calls, 3);
    assert.ok(result.feedback.length > 0);
    assert.match(result.feedback, /At turn/);
    assert.ok(!result.feedback.includes(LIVE_530));
  });

  test("does not invoke structured stall adjudication outside a dedicated stall session", async () => {
    const feedback = `You did explore the financial concern. ${LIVE_528}`;
    const result = await scoreTranscript(productionTranscript(528), "intermediate", "consulting", null, {
      responder: async () => scoringResponse(feedback),
      stallFeedbackAdjudicator: async () => {
        throw new Error("non-stall scoring must not invoke the stall adjudicator");
      },
      cache: {
        getScoreCacheEntry: async () => undefined,
        createScoreCacheEntry: async (entry) => entry as never,
      },
    });
    assert.equal(result.feedback, feedback);
    assert.equal(result.stallFeedbackAudit, null);
  });
});
