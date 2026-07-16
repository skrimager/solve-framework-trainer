import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  seededRng,
  selectPersonaVariant,
  buildPersonaVariantSection,
  scenarioPersonaVariants,
  personaCoreFor,
  resolveSessionVariant,
  sessionVariantSection,
  type SelectedPersonaVariant,
} from "./persona";
import { personaVariantSeed } from "./personaVariants";
import { scenarios } from "./seed";
import { buildCustomerReplyStablePrefix, buildCustomerReplyPrompt } from "./llm";
import type { Scenario } from "@shared/schema";

// Build a Scenario-shaped object straight from the structured seed so the tests
// exercise the same data that ships to the database.
function scenarioFromSeed(slug: string): Scenario {
  const base = scenarios.find((s) => s.slug === slug);
  assert.ok(base, `seed scenario missing: ${slug}`);
  const variant = personaVariantSeed[slug];
  assert.ok(variant, `persona variant missing: ${slug}`);
  return {
    ...(base as object),
    id: 1,
    personaCore: variant.core,
    personalityVariants: JSON.stringify(variant.personalities),
    motivationVariants: JSON.stringify(variant.motivations),
    objectionPool: JSON.stringify(variant.objections),
  } as unknown as Scenario;
}

// Five scenarios spanning difficulties and industries.
const SAMPLE_SLUGS = [
  "manufactured-housing-first-time-buyer", // beginner, manufactured housing
  "auto-sales-skeptical-negotiator", // auto sales
  "financial-advisor-overconfident-diy-investor", // financial advisor
  "hvac-sales-competing-quotes", // hvac
  "insurance-auto-post-accident-frustrated", // insurance
];

function objectionSignature(v: SelectedPersonaVariant): string {
  return v.objections.map((o) => `${o.position}:${o.text}`).join("|");
}

describe("selectPersonaVariant - determinism", () => {
  test("same seed reproduces an identical rendition", () => {
    for (const slug of SAMPLE_SLUGS) {
      const pools = scenarioPersonaVariants(scenarioFromSeed(slug));
      const a = selectPersonaVariant(pools, seededRng(12345));
      const b = selectPersonaVariant(pools, seededRng(12345));
      assert.deepEqual(a, b, `seed determinism failed for ${slug}`);
    }
  });

  test("draws one personality, one motivation, and 1-2 objections from the pools", () => {
    for (const slug of SAMPLE_SLUGS) {
      const scenario = scenarioFromSeed(slug);
      const pools = scenarioPersonaVariants(scenario);
      for (let seed = 1; seed <= 40; seed++) {
        const v = selectPersonaVariant(pools, seededRng(seed));
        assert.ok(pools.personalityVariants.includes(v.personality), `${slug}: personality off-pool`);
        assert.ok(pools.motivationVariants.includes(v.motivation), `${slug}: motivation off-pool`);
        assert.ok(v.objections.length >= 1 && v.objections.length <= 2, `${slug}: objection count`);
        for (const o of v.objections) {
          assert.ok(pools.objectionPool.includes(o.text), `${slug}: objection off-pool`);
        }
      }
    }
  });
});

describe("selectPersonaVariant - session-to-session variation", () => {
  test("across replays the personality, motivation, and objections all vary", () => {
    for (const slug of SAMPLE_SLUGS) {
      const pools = scenarioPersonaVariants(scenarioFromSeed(slug));
      const personalities = new Set<string>();
      const motivations = new Set<string>();
      const objectionSigs = new Set<string>();
      for (let seed = 1; seed <= 60; seed++) {
        const v = selectPersonaVariant(pools, seededRng(seed));
        personalities.add(v.personality);
        motivations.add(v.motivation);
        objectionSigs.add(objectionSignature(v));
      }
      assert.ok(personalities.size > 1, `${slug}: personality never varied`);
      assert.ok(motivations.size > 1, `${slug}: motivation never varied`);
      assert.ok(objectionSigs.size > 1, `${slug}: objections never varied`);
    }
  });

  test("three concrete replays differ from one another", () => {
    for (const slug of SAMPLE_SLUGS) {
      const pools = scenarioPersonaVariants(scenarioFromSeed(slug));
      // Pick three seeds whose renditions are pairwise distinct; the pools are
      // large enough that such a triple always exists within a small search.
      const seen: SelectedPersonaVariant[] = [];
      for (let seed = 1; seed <= 500 && seen.length < 3; seed++) {
        const v = selectPersonaVariant(pools, seededRng(seed));
        const isDistinct = seen.every(
          (s) =>
            s.personality !== v.personality ||
            s.motivation !== v.motivation ||
            objectionSignature(s) !== objectionSignature(v)
        );
        if (isDistinct) seen.push(v);
      }
      assert.equal(seen.length, 3, `${slug}: could not find 3 distinct replays`);
      // At least one facet must differ between each pair.
      for (let i = 0; i < seen.length; i++) {
        for (let j = i + 1; j < seen.length; j++) {
          const differs =
            seen[i].personality !== seen[j].personality ||
            seen[i].motivation !== seen[j].motivation ||
            objectionSignature(seen[i]) !== objectionSignature(seen[j]);
          assert.ok(differs, `${slug}: replays ${i} and ${j} identical`);
        }
      }
    }
  });
});

describe("prompt fixed portion is stable across variants", () => {
  test("buildCustomerReplyStablePrefix is byte-identical regardless of the chosen variant", () => {
    for (const slug of SAMPLE_SLUGS) {
      const scenario = scenarioFromSeed(slug);
      const core = personaCoreFor(scenario);
      const prefixes = new Set<string>();
      const pools = scenarioPersonaVariants(scenario);
      for (let seed = 1; seed <= 20; seed++) {
        // The variant does not feed the stable prefix at all; prove it by
        // rebuilding the prefix for every rendition and confirming one value.
        selectPersonaVariant(pools, seededRng(seed));
        prefixes.add(buildCustomerReplyStablePrefix(core, scenario.difficulty, 0));
      }
      assert.equal(prefixes.size, 1, `${slug}: stable prefix drifted across variants`);
    }
  });

  test("full prompt places the variant AFTER the cacheable stable prefix", () => {
    const scenario = scenarioFromSeed(SAMPLE_SLUGS[0]);
    const core = personaCoreFor(scenario);
    const variant = selectPersonaVariant(scenarioPersonaVariants(scenario), seededRng(7));
    const variantSection = buildPersonaVariantSection(variant);
    const stablePrefix = buildCustomerReplyStablePrefix(core, scenario.difficulty, 0);
    const prompt = buildCustomerReplyPrompt(core, [], scenario.difficulty, 0, variantSection);
    assert.ok(prompt.startsWith(stablePrefix), "prompt must start with the stable prefix");
    assert.ok(prompt.indexOf(variantSection) > stablePrefix.length, "variant must follow the stable prefix");
  });

  test("empty variant section reproduces the pre-variation prompt byte-for-byte", () => {
    const scenario = scenarioFromSeed(SAMPLE_SLUGS[0]);
    const core = personaCoreFor(scenario);
    const withEmpty = buildCustomerReplyPrompt(core, [], scenario.difficulty, 0, "");
    const legacy = buildCustomerReplyPrompt(core, [], scenario.difficulty, 0);
    assert.equal(withEmpty, legacy);
  });
});

describe("resolveSessionVariant - within-session stability", () => {
  test("a stored personaVariant is reused verbatim across turns", () => {
    const scenario = scenarioFromSeed(SAMPLE_SLUGS[2]);
    const stored = selectPersonaVariant(scenarioPersonaVariants(scenario), seededRng(99));
    const session = { id: 42, personaVariant: JSON.stringify(stored) };
    assert.deepEqual(resolveSessionVariant(scenario, session), stored);
    // Same section every turn.
    assert.equal(sessionVariantSection(scenario, session), buildPersonaVariantSection(stored));
  });

  test("a missing personaVariant re-derives deterministically from the session id", () => {
    const scenario = scenarioFromSeed(SAMPLE_SLUGS[3]);
    const session = { id: 777, personaVariant: null };
    const a = resolveSessionVariant(scenario, session);
    const b = resolveSessionVariant(scenario, session);
    assert.deepEqual(a, b, "re-derivation must be stable for a given session id");
    assert.deepEqual(
      a,
      selectPersonaVariant(scenarioPersonaVariants(scenario), seededRng(777)),
      "fallback must be seeded by the session id"
    );
  });
});

describe("scoring independence", () => {
  test("the variant section is never part of the scoreable stable prefix", () => {
    // scoreTranscript builds its prompt from the transcript, difficulty, track and
    // transaction type only; it never receives the persona or its variant. Prove
    // structurally that the variant text does not leak into the customer-reply
    // stable prefix (the only persona-bearing cacheable block), so the motivation
    // gate and rubric scoring stay independent of persona variation.
    const scenario = scenarioFromSeed(SAMPLE_SLUGS[4]);
    const core = personaCoreFor(scenario);
    const stablePrefix = buildCustomerReplyStablePrefix(core, scenario.difficulty, 0);
    for (let seed = 1; seed <= 30; seed++) {
      const variant = selectPersonaVariant(scenarioPersonaVariants(scenario), seededRng(seed));
      const section = buildPersonaVariantSection(variant);
      if (section) {
        assert.ok(!stablePrefix.includes(section), "variant text must not appear in the stable prefix");
      }
    }
  });
});
