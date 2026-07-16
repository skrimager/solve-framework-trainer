import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyUtterance,
  recommendSilenceMs,
  DEFAULT_SILENCE_MS,
  type TurnCompleteness,
} from "../client/src/lib/turnDetection";

// Table of trailing-transcript samples and the completeness the heuristic should
// infer from the trailing tokens. "incomplete" => wait longer (do not cut off),
// "complete" => wait shorter (respond snappily), "neutral" => use the base wait.
const CLASSIFY_TABLE: Array<{ text: string; expected: TurnCompleteness; note: string }> = [
  { text: "", expected: "neutral", note: "empty" },
  { text: "    ", expected: "neutral", note: "whitespace only" },

  // Trailing conjunctions: clearly more to come.
  { text: "I think we should go with the plan and", expected: "incomplete", note: "conjunction 'and'" },
  { text: "I like it but", expected: "incomplete", note: "conjunction 'but'" },
  { text: "the reason is because", expected: "incomplete", note: "conjunction 'because'" },
  { text: "we could do it or", expected: "incomplete", note: "conjunction 'or'" },
  { text: "okay so", expected: "incomplete", note: "conjunction/filler 'so'" },

  // Trailing prepositions and articles: dangling, expects a complement.
  { text: "I need to think about", expected: "incomplete", note: "preposition 'about'" },
  { text: "this is really important to", expected: "incomplete", note: "preposition 'to'" },
  { text: "can you tell me the", expected: "incomplete", note: "article 'the'" },
  { text: "it depends on my", expected: "incomplete", note: "possessive 'my'" },

  // Trailing auxiliaries/copulas: expects a completion.
  { text: "I think the main thing is", expected: "incomplete", note: "copula 'is'" },
  { text: "what I really want to do is", expected: "incomplete", note: "copula 'is' after infinitive" },
  { text: "the thing I would", expected: "incomplete", note: "auxiliary 'would'" },

  // Filler words and phrases.
  { text: "um", expected: "incomplete", note: "filler 'um'" },
  { text: "well I was thinking like", expected: "incomplete", note: "filler 'like'" },
  { text: "the price you know", expected: "incomplete", note: "filler phrase 'you know'" },
  { text: "it's kind of", expected: "incomplete", note: "filler phrase 'kind of'" },
  { text: "let me think", expected: "incomplete", note: "filler phrase 'let me think'" },
  { text: "we could do that or something", expected: "incomplete", note: "filler phrase 'or something'" },

  // Explicit trailing-off.
  { text: "I think the main thing is...", expected: "incomplete", note: "ellipsis" },
  { text: "hmm the main thing…", expected: "incomplete", note: "unicode ellipsis" },

  // Terminal punctuation: finished.
  { text: "Yes, that works for me.", expected: "complete", note: "period" },
  { text: "Does that make sense?", expected: "complete", note: "question mark" },
  { text: "That sounds great!", expected: "complete", note: "exclamation" },
  { text: "I'm all set.\"", expected: "complete", note: "period before closing quote" },

  // Natural sentence-final words without punctuation (recognizer often omits it).
  { text: "that works for me", expected: "complete", note: "object pronoun 'me'" },
  { text: "yeah", expected: "complete", note: "affirmation 'yeah'" },
  { text: "no thanks", expected: "complete", note: "closer 'thanks'" },
  { text: "sounds good", expected: "complete", note: "closer 'good'" },

  // Genuinely ambiguous: no strong trailing signal either way.
  { text: "I would like the blue one", expected: "neutral", note: "ends on a content word" },
  { text: "so I think the price is fair", expected: "neutral", note: "leading 'so' does not count" },
  { text: "we visited the property yesterday", expected: "neutral", note: "plain declarative, no punctuation" },
];

describe("classifyUtterance", () => {
  for (const { text, expected, note } of CLASSIFY_TABLE) {
    test(`${note}: ${JSON.stringify(text)} -> ${expected}`, () => {
      assert.equal(classifyUtterance(text), expected);
    });
  }
});

describe("recommendSilenceMs", () => {
  test("neutral utterance uses the base wait", () => {
    assert.equal(recommendSilenceMs("we visited the property yesterday"), DEFAULT_SILENCE_MS);
  });

  test("complete utterance waits less than the base", () => {
    const ms = recommendSilenceMs("Yes, that works for me.");
    assert.ok(ms < DEFAULT_SILENCE_MS, `expected < ${DEFAULT_SILENCE_MS}, got ${ms}`);
    assert.equal(ms, 900);
  });

  test("incomplete utterance waits more than the base", () => {
    const ms = recommendSilenceMs("I think the main thing is");
    assert.ok(ms > DEFAULT_SILENCE_MS, `expected > ${DEFAULT_SILENCE_MS}, got ${ms}`);
    assert.equal(ms, 2550);
  });

  test("scales around a custom base", () => {
    assert.equal(recommendSilenceMs("we visited the property yesterday", 1000), 1000);
    assert.equal(recommendSilenceMs("that works for me", 1000), 600);
    assert.equal(recommendSilenceMs("the reason is because", 1000), 1700);
  });

  test("clamps to the minimum wait", () => {
    // 800 * 0.6 = 480, clamped up to the 600ms floor.
    assert.equal(recommendSilenceMs("okay.", 800), 600);
  });

  test("clamps to the maximum wait", () => {
    // 2200 * 1.7 = 3740, clamped down to the 3500ms ceiling.
    assert.equal(recommendSilenceMs("and", 2200), 3500);
  });
});

// The two product-owner scenarios, asserted at the heuristic level.
describe("required product-owner scenarios", () => {
  test("thinking-pause: a mid-sentence pause is not cut off", () => {
    // "I think the main thing is... [pause] ...the price" -- during the pause the
    // interim transcript ends on "is", so the recommended wait must exceed a
    // 1-2 second thinking pause rather than auto-sending a half sentence.
    const ms = recommendSilenceMs("I think the main thing is");
    assert.ok(ms >= 2000, `expected the wait to ride over a ~1.5s pause, got ${ms}`);
  });

  test("fast-response: a short complete sentence sends quickly", () => {
    // "Yes, that works for me." is clearly finished, so the wait shrinks well
    // below the neutral base to keep the reply snappy.
    const ms = recommendSilenceMs("Yes, that works for me.");
    assert.ok(ms <= 1000, `expected a short wait for a finished sentence, got ${ms}`);
  });
});
