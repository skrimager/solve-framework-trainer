import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { TranscriptMessage } from "@shared/schema";
import {
  buildTimingGroundingBlock,
  deriveTimingCoverage,
  numberedTurns,
} from "./feedbackGrounding";
import { renderTranscriptForScoring, transcriptHeaderForScoring } from "./llm";

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

// The reported failure, verbatim in shape: the customer names wanting more
// comfort, and the rep asks about budget, cash-versus-financing, and a trade-in
// on the very next turn. Feedback claiming financing needed to come up earlier is
// contradicted by turn 3.
const COMFORT_THEN_BUDGET = t(
  "r: Hi there, what brings you in today?",
  "c: My car is getting old, and I want something with more comfort for my commute.",
  "r: More comfort, got it. What does your budget look like, and are you paying cash or financing? Any trade-in?",
  "c: Probably financing, somewhere around twenty five thousand, and yes I would trade the old one in.",
  "r: That helps. Tell me more about the commute itself.",
  "c: It is about an hour each way, mostly highway.",
  "r: Based on what you have told me, I would recommend the midsize sedan.",
  "c: That sounds right, that is exactly what we need.",
);

describe("numberedTurns - one source of turn numbering for every graded prompt", () => {
  test("numbering, blank-turn dropping, and newline collapsing match the rendered transcript", () => {
    const transcript = t("c: first", "r: ", "c: second") as TranscriptMessage[];
    transcript.push({ role: "consultant", content: "third\nline", timestamp: "t" });

    assert.deepEqual(
      numberedTurns(transcript).map((x) => [x.turn, x.role, x.text]),
      [
        [1, "customer", "first"],
        [2, "customer", "second"],
        [3, "consultant", "third line"],
      ],
    );
    // The rendered transcript the model sees must carry the same numbers, or a
    // grounding block citing "turn 3" would point at a different line.
    const rendered = renderTranscriptForScoring(transcript);
    assert.ok(rendered.includes("[3] CONSULTANT: third line"));
    assert.ok(transcriptHeaderForScoring(transcript).includes("3 turns"));
  });
});

describe("deriveTimingCoverage - the reported financing repro", () => {
  test("budget asked right after the comfort remark is recorded as covered, and early", () => {
    const [coverage] = deriveTimingCoverage(COMFORT_THEN_BUDGET);
    assert.equal(coverage.raisedTurn, 3);
    assert.equal(coverage.raisedEarly, true);
    assert.match(coverage.raisedQuote!, /budget/);
    // The natural trigger point is the customer's own comfort line, not a
    // generic "earlier in the conversation".
    assert.equal(coverage.triggerTurn, 2);
    assert.match(coverage.triggerQuote!, /more comfort/);
  });

  test("cash-versus-financing and trade-in wording each count on their own", () => {
    for (const line of [
      "r: Are you planning to pay cash or finance it?",
      "r: Do you have a trade-in you are hoping to put toward this?",
      "r: What price range were you looking to stay inside?",
      "r: What can you comfortably afford per month?",
    ]) {
      const [coverage] = deriveTimingCoverage(t("c: I want something roomier.", line));
      assert.equal(coverage.raisedTurn, 2, `expected a match for: ${line}`);
    }
  });

  test("asking right after the customer names what they want is early on its own", () => {
    // Position alone would call turn 3 of 4 late. It is not: the customer named
    // what they were after on turn 2 and the rep asked on the next turn, which is
    // the moment the money conversation belongs.
    const [coverage] = deriveTimingCoverage(
      t(
        "r: What brings you in today?",
        "c: I want something with more comfort for my commute.",
        "r: What does your budget look like, and are you paying cash or financing?",
        "c: Financing, around twenty five thousand.",
      ),
    );
    assert.equal(coverage.raisedTurn, 3);
    assert.equal(coverage.firstProposalTurn, null);
    assert.equal(coverage.raisedEarly, true);
  });

  test("the CUSTOMER raising financing is not the rep covering it (attribution)", () => {
    const [coverage] = deriveTimingCoverage(
      t(
        "r: What brings you in?",
        "c: I want something roomier. What kind of financing rates do you have?",
        "r: The finance office handles rates. Tell me about who rides with you.",
      ),
    );
    // Turn 3 names the topic on a rep turn, so that is the rep's first mention;
    // the customer's turn 2 must never be what earns the credit.
    assert.equal(coverage.raisedTurn, 3);
  });

  test("a topic raised only after the recommendation is on the table is late", () => {
    const [coverage] = deriveTimingCoverage(
      t(
        "r: What brings you in?",
        "c: I want something with more comfort.",
        "r: Take a look at this sedan.",
        "c: It looks nice.",
        "r: Based on what you have told me, I would recommend this one.",
        "c: Okay.",
        "r: One last thing, what is your budget, and are you financing?",
        "c: That works for me.",
      ),
    );
    assert.equal(coverage.raisedTurn, 7);
    assert.equal(coverage.firstProposalTurn, 5);
    assert.equal(coverage.raisedEarly, false);
  });

  test("a topic the rep never raised is reported as absent, not as late", () => {
    const [coverage] = deriveTimingCoverage(
      t("r: What brings you in?", "c: I need more room for the kids.", "r: How old are they?"),
    );
    assert.equal(coverage.raisedTurn, null);
    assert.equal(coverage.raisedEarly, false);
    assert.equal(coverage.triggerTurn, 2);
  });

  test("an empty transcript yields no coverage at all", () => {
    assert.deepEqual(deriveTimingCoverage([]), []);
  });
});

describe("buildTimingGroundingBlock", () => {
  test("the repro block forbids the exact wrong claim the trainee received", () => {
    const block = buildTimingGroundingBlock(COMFORT_THEN_BUDGET, "TRAINEE");
    assert.match(block, /ALREADY COVERED, and covered early/);
    assert.match(block, /The TRAINEE raised it themselves at turn 3 of 8/);
    assert.match(block, /do not write that it should have come up earlier or sooner/);
    assert.match(block, /do not hedge the same claim/);
  });

  test("a genuinely late topic keeps timing coaching, tied to a real earlier moment", () => {
    const block = buildTimingGroundingBlock(
      t(
        "r: What brings you in?",
        "c: I want something with more comfort.",
        "r: Based on what you have told me, I would recommend this sedan.",
        "c: Okay.",
        "r: What is your budget, and are you financing?",
        "c: That works for me.",
      ),
    );
    assert.match(block, /COVERED, but not until turn 5 of 6/);
    assert.match(block, /Never write that it was missing/);
    assert.match(block, /turn 2: "I want something with more comfort\."/);
  });

  test("a moment is only offered when it actually precedes what is being coached", () => {
    // The rep raises budget first; the customer names what they want afterwards.
    // That later line cannot be cited as the earlier moment they missed.
    const block = buildTimingGroundingBlock(
      t(
        "r: Before we look at anything, what budget are you working with?",
        "c: I want something with more comfort.",
      ),
    );
    assert.ok(!block.includes("The earliest moment the customer named"));
  });

  test("the trainee's turns are named with the label the surrounding prompt uses", () => {
    assert.match(buildTimingGroundingBlock(COMFORT_THEN_BUDGET), /The CONSULTANT raised it/);
    assert.match(buildTimingGroundingBlock(COMFORT_THEN_BUDGET, "TRAINEE"), /The TRAINEE raised it/);
  });

  test("an empty transcript produces no block, leaving those prompts unchanged", () => {
    assert.equal(buildTimingGroundingBlock([]), "");
  });
});
