import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SAAS_PRODUCT_TAGS, type Scenario } from "@shared/schema";
import { personaOpeningCoreFor } from "./persona";
import { personaVariantSeed } from "./personaVariants";
import { reconcileSaasScenarioContext, scenarios } from "./seed";

const EXPECTED_PRODUCT_BY_SLUG = {
  "saas-switching-from-spreadsheets": "crm",
  "saas-champion-building-internal-buyin": "ai_roleplay_platform",
  "saas-website-refresh-first-project": "website_builder",
  "saas-ai-sales-automation-follow-up-gap": "ai_sales_automation",
  "saas-email-drip-follow-up-consistency": "email_drip_automation",
} as const;

const OPENING_CONTEXT_BY_PRODUCT: Record<(typeof SAAS_PRODUCT_TAGS)[number], RegExp> = {
  crm: /\bCRM\b|customers? and leads?/i,
  website_builder: /\bwebsite\b/i,
  ai_sales_automation: /\bAI sales automation\b/i,
  ai_roleplay_platform: /\bAI roleplay\b|\btraining sales reps\b/i,
  email_drip_automation: /\bemail drip\b|automated email follow-up/i,
};

function scenarioFor(slug: string): Scenario {
  const scenario = scenarios.find((candidate) => candidate.slug === slug);
  assert.ok(scenario, `missing seed scenario ${slug}`);
  return { ...scenario, id: 1 } as Scenario;
}

describe("SaaS product context", () => {
  test("uses exactly the five approved product tags and covers every tag", () => {
    const saas = scenarios.filter((scenario) => scenario.vertical === "saas");
    assert.equal(saas.length, 5, "five SaaS category scenarios should be available");
    assert.deepEqual(
      [...new Set(saas.map((scenario) => scenario.product))].sort(),
      [...SAAS_PRODUCT_TAGS].sort(),
    );
    assert.deepEqual(
      Object.fromEntries(saas.map((scenario) => [scenario.slug, scenario.product])),
      EXPECTED_PRODUCT_BY_SLUG,
    );
    assert.ok(scenarios.every((scenario) => scenario.vertical === "saas" || scenario.product == null));
  });

  test("includes real beginner coverage while retaining intermediate and advanced practice", () => {
    const difficulties = new Set(
      scenarios
        .filter((scenario) => scenario.vertical === "saas")
        .map((scenario) => scenario.difficulty),
    );
    assert.deepEqual([...difficulties].sort(), ["advanced", "beginner", "intermediate"]);
    assert.equal(
      scenarios.filter((scenario) => scenario.vertical === "saas" && scenario.difficulty === "beginner").length,
      3,
    );
  });

  test("every SaaS persona's initial stance naturally establishes its category", () => {
    for (const [slug, product] of Object.entries(EXPECTED_PRODUCT_BY_SLUG)) {
      const core = personaVariantSeed[slug]?.core;
      assert.ok(core, `missing structured persona for ${slug}`);
      const opening = core.match(/Your opening stance: "([^"]+)"/)?.[1] ?? "";
      assert.match(opening, /^Hi, I'm /, `${slug} must start cold with an introduction`);
      assert.match(opening, OPENING_CONTEXT_BY_PRODUCT[product], `${slug} must name its product category naturally`);
      assert.doesNotMatch(
        opening,
        /real underlying|migration.*reputation|black-box|agency.*charged|sales.*too late|stakeholder/i,
        `${slug} must not reveal its hidden discovery need in the opening`,
      );
    }
  });

  test("feeds the internal tag into the opening prompt without making it a visible UI label", () => {
    for (const [slug, product] of Object.entries(EXPECTED_PRODUCT_BY_SLUG)) {
      const promptCore = personaOpeningCoreFor(scenarioFor(slug));
      assert.match(promptCore, OPENING_CONTEXT_BY_PRODUCT[product], `${slug} opening prompt context`);
      assert.match(promptCore, /Internal opening context:/, `${slug} must receive product context only for opening`);
    }

    const scenariosPage = readFileSync(
      fileURLToPath(new URL("../client/src/pages/scenarios.tsx", import.meta.url)),
      "utf8",
    );
    assert.doesNotMatch(scenariosPage, /\.product\b|product\s*:/, "product tag must not be rendered in the picker");
  });

  test("reconciles the existing SaaS rows to the current product and persona context", async () => {
    const stale = Object.keys(EXPECTED_PRODUCT_BY_SLUG).slice(0, 2).map((slug, index) => ({
      ...scenarioFor(slug),
      id: index + 10,
      product: null,
      customerPersona: "stale legacy persona",
      personaCore: "stale persona core",
      personalityVariants: "[]",
      motivationVariants: "[]",
      objectionPool: "[]",
    }));
    const writes: { id: number; patch: Record<string, unknown> }[] = [];
    const store = {
      async updateScenario(id: number, patch: Record<string, unknown>) {
        writes.push({ id, patch });
        return undefined;
      },
    };

    const reconciled = await reconcileSaasScenarioContext(stale, store as never);

    assert.deepEqual(reconciled.sort(), stale.map((scenario) => scenario.slug).sort());
    assert.equal(writes.length, 2);
    for (const write of writes) {
      const slug = stale.find((scenario) => scenario.id === write.id)?.slug;
      assert.ok(slug);
      const source = scenarioFor(slug);
      assert.equal(write.patch.product, source.product);
      assert.equal(write.patch.personaCore, source.personaCore);
      assert.equal(write.patch.customerPersona, source.customerPersona);
    }
  });
});
