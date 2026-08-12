import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Scenario } from "@shared/schema";
import { buildCustomerReplyStablePrefix, REACTIVE_ONLY_CUSTOMER_RULES } from "./llm";
import { personaCoreFor } from "./persona";
import { personaVariantSeed } from "./personaVariants";
import { reconcileAuditPersonaContext, scenarios } from "./seed";
import { isInternalTestScenario } from "./internalTestScenario";

const MID_CONVERSATION_OPENING = /\b(?:like I said|as we discussed|as I mentioned|you told me|you said|circling back|following up on|we were talking about)\b/i;
const SCHEDULED_DISCLOSURE = /\b(?:somewhere in your first couple of turns|bring this up later|roughly the point noted)\b/i;
const LOOPING_DIRECTIVE = /\b(?:keep steering back|try to force it back|as deliberate tests|push back (?:hard )?at least)\b/i;

function scenarioFromSeed(seed: (typeof scenarios)[number]): Scenario {
  return { ...seed, id: 1 } as Scenario;
}

function openingStance(core: string): string {
  return core.match(/Your opening stance(?:, delivered as the very first thing you say in this conversation)?: "([^"]+)"/)?.[1] ?? "";
}

function assertColdAndReactivePersona(slug: string, core: string): void {
  const opening = openingStance(core);
  assert.ok(opening, `${slug} has an opening stance`);
  // Stall practice intentionally starts after an earlier conversation, so its
  // fixed opening may directly reference what the consultant already said.
  if (!slug.startsWith("stall-")) {
    assert.doesNotMatch(opening, MID_CONVERSATION_OPENING, `${slug} must not assume an earlier rep conversation`);
  }
  assert.doesNotMatch(core, SCHEDULED_DISCLOSURE, `${slug} must not schedule a later disclosure`);
  assert.doesNotMatch(core, LOOPING_DIRECTIVE, `${slug} must not direct a looping callback`);
}

describe("all-vertical scenario consistency audit guards", () => {
  test("covers the full public portfolio across all 19 verticals with structured personas", () => {
    const publicScenarios = scenarios.filter((scenario) => !isInternalTestScenario(scenario.slug));
    assert.equal(publicScenarios.length, 114);
    assert.equal(new Set(publicScenarios.map((scenario) => scenario.vertical)).size, 19);

    for (const scenario of publicScenarios) {
      assert.ok(personaVariantSeed[scenario.slug], `${scenario.slug} has a structured persona`);
      assert.ok(personaCoreFor(scenarioFromSeed(scenario)).trim().length > 0, `${scenario.slug} has a prompt core`);
      assert.ok(openingStance(personaVariantSeed[scenario.slug].core), `${scenario.slug} has an opening stance`);
    }
  });

  test("keeps every opening stance cold and prevents scheduled or looping persona instructions", () => {
    for (const [slug, persona] of Object.entries(personaVariantSeed)) {
      assertColdAndReactivePersona(slug, persona.core);
    }

    // The structured persona drives production prompts, but this also protects
    // the retained legacy text used by the rollback fallback.
    for (const scenario of scenarios) {
      assertColdAndReactivePersona(scenario.slug, scenario.customerPersona);
    }
  });

  test("repairs the one audited persisted opener that could sound mid-conversation", async () => {
    const slug = "manufactured-housing-community-existing-resident-renewal";
    const source = scenarioFromSeed(scenarios.find((scenario) => scenario.slug === slug)!);
    const stale = {
      ...source,
      id: 42,
      customerPersona: "stale legacy persona",
      personaCore: "stale structured persona",
      personalityVariants: "[]",
      motivationVariants: "[]",
      objectionPool: "[]",
    };
    const writes: { id: number; patch: Record<string, unknown> }[] = [];
    const store = {
      async updateScenario(id: number, patch: Record<string, unknown>) {
        writes.push({ id, patch });
        return undefined;
      },
    };

    const reconciled = await reconcileAuditPersonaContext([stale], store as never);
    const opening = openingStance(personaVariantSeed[slug].core);

    assert.deepEqual(reconciled, [slug]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].patch.personaCore, source.personaCore);
    assert.match(opening, /^Hi, I'm Marisol\./);
    assert.doesNotMatch(opening, /^This drainage problem/i);
  });

  test("applies the same reactive-only rule and difficulty calibration to every scenario", () => {
    for (const scenario of scenarios) {
      const prefix = buildCustomerReplyStablePrefix(personaCoreFor(scenarioFromSeed(scenario)), scenario.difficulty);
      assert.ok(prefix.endsWith(REACTIVE_ONLY_CUSTOMER_RULES), `${scenario.slug} ends on reactive-only rules`);
      assert.match(
        prefix,
        new RegExp(`Difficulty calibration \\(${scenario.difficulty.toUpperCase()}\\)`),
        `${scenario.slug} uses its declared difficulty calibration`,
      );
    }
  });

  test("the common completion and results paths persist and render score, evidence-bearing feedback, and rubric", () => {
    const routes = readFileSync(fileURLToPath(new URL("./routes.ts", import.meta.url)), "utf8");
    const results = readFileSync(fileURLToPath(new URL("../client/src/pages/results.tsx", import.meta.url)), "utf8");

    assert.match(routes, /scoreTranscript\(transcript, scenario\?\.difficulty, track, scenario\?\.transactionType, \{/);
    assert.match(routes, /stallType: scenario\?\.stallType \?\? null/);
    assert.match(routes, /rubricScores: JSON\.stringify\(rubric\)/);
    assert.match(routes, /feedback,/);
    assert.match(results, /session\.score/);
    assert.match(results, /session\.feedback/);
    assert.match(results, /Object\.keys\(rubricLabels\)\.map/);
  });
});
