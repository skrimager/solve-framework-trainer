import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { splitSentences, createSentenceStreamer } from "./sentences";

describe("splitSentences - basic boundaries", () => {
  test("splits on period, question mark, exclamation", () => {
    assert.deepEqual(splitSentences("Hello there. How are you? Great!"), [
      "Hello there.",
      "How are you?",
      "Great!",
    ]);
  });

  test("empty / whitespace-only yields no sentences", () => {
    assert.deepEqual(splitSentences(""), []);
    assert.deepEqual(splitSentences("   \n  "), []);
  });

  test("text with no terminal punctuation is one sentence", () => {
    assert.deepEqual(splitSentences("just a fragment with no end"), [
      "just a fragment with no end",
    ]);
  });

  test("trailing text after the last terminator is kept", () => {
    assert.deepEqual(splitSentences("Done. And more"), ["Done.", "And more"]);
  });
});

describe("splitSentences - does not split inside abbreviations", () => {
  test("titles like Mr. and Dr. do not split", () => {
    assert.deepEqual(splitSentences("Mr. Smith called Dr. Lee today."), [
      "Mr. Smith called Dr. Lee today.",
    ]);
  });

  test("internal-dot abbreviations e.g. and i.e. do not split", () => {
    assert.deepEqual(
      splitSentences("I want options, e.g. a smaller unit. That works."),
      ["I want options, e.g. a smaller unit.", "That works."],
    );
  });

  test("single-letter initials do not split", () => {
    assert.deepEqual(splitSentences("Ask J. R. about it."), [
      "Ask J. R. about it.",
    ]);
  });

  test("U.S. does not split", () => {
    assert.deepEqual(splitSentences("It ships to the U.S. next week."), [
      "It ships to the U.S. next week.",
    ]);
  });
});

describe("splitSentences - numbers and ellipses", () => {
  test("decimal numbers do not split", () => {
    assert.deepEqual(splitSentences("It costs 3.14 dollars per unit."), [
      "It costs 3.14 dollars per unit.",
    ]);
  });

  test("currency with thousands and decimals does not split", () => {
    assert.deepEqual(splitSentences("The price is $1,499.99 total."), [
      "The price is $1,499.99 total.",
    ]);
  });

  test("ellipsis does not split (trailing off)", () => {
    assert.deepEqual(splitSentences("I was thinking... maybe later."), [
      "I was thinking... maybe later.",
    ]);
  });

  test("combined terminators count as one boundary", () => {
    assert.deepEqual(splitSentences("Really?! I had no idea."), [
      "Really?!",
      "I had no idea.",
    ]);
  });

  test("closing quote is pulled into the sentence it ends", () => {
    assert.deepEqual(splitSentences('She said "okay." Then she left.'), [
      'She said "okay."',
      "Then she left.",
    ]);
  });
});

describe("createSentenceStreamer - incremental emission", () => {
  test("emits a sentence as soon as the next one starts, holds the last", () => {
    const s = createSentenceStreamer();
    assert.deepEqual(s.push("Hello there."), []); // one sentence so far, held back
    assert.deepEqual(s.push(" How are"), ["Hello there."]); // next sentence started
    assert.deepEqual(s.push(" you? I'm"), ["How are you?"]);
    assert.deepEqual(s.flush(), ["I'm"]);
  });

  test("token-by-token deltas reconstruct the same sentences", () => {
    const s = createSentenceStreamer();
    const deltas = ["I ", "need ", "a ", "home", ". ", "Soon", "!"];
    const emitted: string[] = [];
    for (const d of deltas) emitted.push(...s.push(d));
    emitted.push(...s.flush());
    assert.deepEqual(emitted, ["I need a home.", "Soon!"]);
  });

  test("does not mis-split an abbreviation sitting at the stream edge", () => {
    const s = createSentenceStreamer();
    const emitted: string[] = [];
    emitted.push(...s.push("Talk to Dr")); // no terminator yet
    emitted.push(...s.push(". Lee about it.")); // "Dr." must not become a sentence
    emitted.push(...s.flush());
    assert.deepEqual(emitted, ["Talk to Dr. Lee about it."]);
  });

  test("flush on empty stream yields nothing", () => {
    const s = createSentenceStreamer();
    assert.deepEqual(s.flush(), []);
  });
});
