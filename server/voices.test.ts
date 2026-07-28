import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getVoiceForScenario,
  getVoiceInstructionsForScenario,
  NATURAL_DELIVERY_INSTRUCTIONS,
  PERSONA_VOICES,
  PERSONA_VOICE_INSTRUCTIONS,
} from "./voices";

describe("getVoiceForScenario", () => {
  test("returns the curated voice when it agrees with gender", () => {
    assert.equal(getVoiceForScenario("auto-sales-first-car-college-student", "female"), "coral");
  });

  test("never returns a wrong-gender voice, even if curated data disagreed", () => {
    // auto-sales-tech-worker-upgrade is curated male (echo); asking for female
    // must ignore the curated entry and fall back to a female-pool voice.
    const voice = getVoiceForScenario("auto-sales-tech-worker-upgrade", "female");
    assert.notEqual(voice, "echo");
  });

  test("falls back deterministically (same slug -> same voice) when uncurated", () => {
    const a = getVoiceForScenario("some-uncurated-slug", "male");
    const b = getVoiceForScenario("some-uncurated-slug", "male");
    assert.equal(a, b);
  });

  test("handles missing slug with a default per gender", () => {
    assert.equal(typeof getVoiceForScenario(undefined, "male"), "string");
    assert.equal(typeof getVoiceForScenario(null, "female"), "string");
  });
});

describe("the six public demo personas", () => {
  // Slug -> the gender on the seeded scenario row, which is authoritative over
  // the heard voice. Curated entries only survive if they agree with it.
  const DEMO_PERSONAS: Array<[string, "male" | "female"]> = [
    ["demo-v2-auto-1", "male"], // Vince, 44
    ["demo-v2-auto-2", "male"], // Don, 68
    ["demo-v2-auto-3", "female"], // Denise, 43
    ["demo-v2-re-1", "female"], // Margaret, 71
    ["demo-v2-re-2", "male"], // Marcus, 38
    ["demo-v2-re-3", "female"], // Nia, 26
  ];

  test("each resolves through an explicit curated entry, not the hash fallback", () => {
    for (const [slug, gender] of DEMO_PERSONAS) {
      const curated = PERSONA_VOICES[slug];
      assert.ok(curated, `${slug} has no curated voice and would hit the hash fallback`);
      assert.equal(getVoiceForScenario(slug, gender), curated, slug);
    }
  });

  test("all six voices are pairwise distinct so no two demo personas sound alike", () => {
    const voices = DEMO_PERSONAS.map(([slug, gender]) => getVoiceForScenario(slug, gender));
    assert.equal(new Set(voices).size, voices.length, `collision in ${voices.join(", ")}`);
  });
});

describe("getVoiceInstructionsForScenario", () => {
  test("returns a youthful delivery steer for the young first-car persona", () => {
    const instructions = getVoiceInstructionsForScenario("auto-sales-first-car-college-student");
    assert.ok(instructions);
    assert.match(instructions!, /20-year-old/i);
  });

  test("the curated steer is layered ON TOP of the universal natural-delivery steer", () => {
    const instructions = getVoiceInstructionsForScenario("auto-sales-first-car-college-student");
    assert.ok(instructions.startsWith(NATURAL_DELIVERY_INSTRUCTIONS));
    assert.match(instructions, /20-year-old/i);
  });

  test("scenarios with no curated steer still get the universal natural delivery", () => {
    // Bug 3: every persona, not just the four curated ones, must be steered away
    // from the model's default announcer-like read.
    assert.equal(
      getVoiceInstructionsForScenario("auto-sales-skeptical-negotiator"),
      NATURAL_DELIVERY_INSTRUCTIONS,
    );
    assert.equal(getVoiceInstructionsForScenario(undefined), NATURAL_DELIVERY_INSTRUCTIONS);
    assert.equal(getVoiceInstructionsForScenario(null), NATURAL_DELIVERY_INSTRUCTIONS);
  });

  test("the universal steer says nothing about age, gender, or personality", () => {
    // It is composed with per-persona steers, so it must not contradict them or
    // the gender the avatar shows.
    assert.doesNotMatch(NATURAL_DELIVERY_INSTRUCTIONS, /\b(male|female|man|woman|he|she|year-old)\b/i);
  });

  test("every scenario with curated instructions also has a curated voice entry", () => {
    // Sanity guard: instructions map keys should be a subset of the voice map,
    // otherwise a typo'd slug would silently do nothing.
    for (const slug of Object.keys(PERSONA_VOICE_INSTRUCTIONS)) {
      assert.ok(PERSONA_VOICES[slug], `expected ${slug} to have a curated voice entry`);
    }
  });
});
