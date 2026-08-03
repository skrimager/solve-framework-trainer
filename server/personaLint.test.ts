// A standing audit of every customer persona in the codebase, guarding the one
// rule that decides whether a roleplay teaches discovery or rewards skipping it.
//
// THE RULE
//
// A persona's hidden needs are written as feelings and situations. Any concrete
// fact the customer could hand over — an exact rating, a figure, a named
// feature, a measurement — is allowed to appear only as something the consultant
// EARNS, which in prose means the sentence carrying it also says it comes out
// when asked. A persona may say "you are frightened about the baby"; it may say
// "if the consultant asks what would reassure you, you say the crash ratings are
// what you actually want to see". What it may not say is "you want to hear the
// exact crash ratings", because that is an instruction to the model to raise
// them, and the model does.
//
// THE INCIDENT
//
// "auto-sales-growing-family-suv" (Priya, seven months pregnant, shopping for an
// SUV) had exactly that. Her hidden needs read "Safety ratings matter enormously
// to you right now — you want to hear specifics, not just marketing language"
// and "Ease of installing and accessing a car seat/stroller matters more than
// raw size", stated as her own standing agenda rather than as what good
// discovery uncovers. Two of her objections were the same thing in dialogue
// form: "how safe is this one, and can you show me the actual ratings" and
// "will a car seat even fit and install easily back there". The model did as it
// was told and volunteered both within a turn or two of the greeting, so a
// trainee who asked nothing at all was handed the customer's real needs for
// free. An audit of all ~90 personas found the defect isolated to that one; the
// other 89 already paired their specifics with an explicit "if asked" clause.
//
// WHAT THIS TEST DOES
//
// It fails when a single clause both demands a specific (a "you want the exact
// / you need to hear the actual / not just marketing language" frame) AND names
// something concrete, without that same clause making the disclosure
// conditional. It is deliberately narrow. Naming a spec is fine.
// Wanting something badly is fine. It is the conjunction, unconditioned, that
// produced the incident, and only that conjunction is an error here.
//
// It is a prose check, so it cannot see whether a persona is otherwise well
// written. The enforcement that does not depend on wording is the disclosure
// gate in conversationState.ts, which reads the transcript and withholds a
// tagged subject until the consultant has actually asked about it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { personaVariantSeed } from "./personaVariants";
import { scenarios } from "./seed";

// The customer being told to want a specific thing stated specifically. Each of
// these is a phrasing that instructs rather than describes: it tells the model
// what the customer is after, in a form it can act on immediately.
const DEMAND_FRAMES: RegExp[] = [
  // "you want to hear specifics", "you need to see the exact numbers",
  // "you want the actual figures". The gap allows an intervening object
  // ("you want to hear the safety numbers") but not a sentence boundary.
  /\byou (?:want|need|expect)\b[^.;:!?]{0,70}\b(?:exact|specific|specifics|actual|precise|concrete|hard numbers|real numbers)\b/i,
  // The tell that gives the incident its name: ruling out the vague answer,
  // which only makes sense as an instruction to press for the precise one.
  /\bnot just marketing\b/i,
  /\bnot (?:vague|generic|general) (?:reassurance|answers?|language|claims?)\b/i,
  /\brather than (?:vague|generic) (?:reassurance|answers?|language)\b/i,
  // "what matters most is specific safety data", "what you care about is the
  // exact figures" — the same demand written in the third person.
  /\bwhat (?:matters|counts)\b[^.;:!?]{0,40}\bis\b[^.;:!?]{0,40}\b(?:exact|specific)\b/i,
];

// Something the consultant could be made to produce: a rating, a figure, a
// measurement, a named spec. Kept to nouns that denote a retrievable fact, so
// that a feeling described with a number in it ("thirty-five years in that
// house") does not on its own qualify.
const CONCRETE_NOUNS =
  /\b(?:ratings?|scores?|numbers?|figures?|specs?|specifications?|data|measurements?|dimensions?|percentages?|warranties|model numbers?|SEER|MPG|BTU|APR|square footage)\b/i;

// The paired conditional that makes a specific something the consultant earns.
// Scoped to the sentence carrying the demand, not the surrounding paragraph.
// Priya's core is the reason: it opened with "reveal ONLY if the consultant asks
// good discovery questions" and then, two sentences later, "what matters most is
// specific safety data (not vague reassurance)". A paragraph-wide search reads
// that as conditioned and passes it. It is not conditioned — it is a blanket
// caveat followed by a standing instruction, and the model followed the
// instruction. Requiring the conditional in the same breath as the specific is
// what separates the two.
const CONDITIONALS: RegExp[] = [
  /\bif asked\b/i,
  /\bonly if\b/i,
  /\bwhen asked\b/i,
  /\bonce (?:asked|the consultant|someone)\b/i,
  /\bif (?:the |a )?(?:consultant|rep|advisor|agent|salesperson|technician|plumber|they|he|she|someone)\b[^.;:!?]{0,60}\basks?\b/i,
  /\byou (?:do not|don'?t) (?:volunteer|lead with|raise|bring|offer|mention|say)\b/i,
  /\breveal(?:ed)? only\b/i,
  /\bunprompted\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): RegExp | null {
  return patterns.find((p) => p.test(text)) ?? null;
}

// Bullet lines and blank-line-separated blocks, then sentences within them. A
// bullet with no terminating period is one sentence, which is how most of the
// variation-pool entries are written.
function clauses(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*[-*•])/)
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface LintViolation {
  source: string;
  clause: string;
  frame: string;
}

// Every unconditioned demand-for-a-specific in one persona text.
export function lintPersonaText(source: string, text: string): LintViolation[] {
  const out: LintViolation[] = [];
  for (const clause of clauses(text)) {
    const frame = matchesAny(clause, DEMAND_FRAMES);
    if (!frame) continue;
    if (!CONCRETE_NOUNS.test(clause)) continue;
    if (matchesAny(clause, CONDITIONALS)) continue;
    out.push({ source, clause, frame: String(frame) });
  }
  return out;
}

function report(violations: LintViolation[]): string {
  return violations
    .map((v) => `\n  ${v.source}\n    matched ${v.frame}\n    in: ${JSON.stringify(v.clause)}`)
    .join("");
}

// Every piece of persona prose in the codebase, flattened to (label, text).
function allPersonaTexts(): { source: string; text: string }[] {
  const out: { source: string; text: string }[] = [];
  for (const [slug, seed] of Object.entries(personaVariantSeed)) {
    out.push({ source: `personaVariantSeed[${slug}].core`, text: seed.core });
    // The variation pools are rendered into the same prompt as the core, so a
    // demand hidden in an objection reaches the model exactly as forcefully.
    // Priya's did.
    seed.personalities.forEach((p, i) => out.push({ source: `personaVariantSeed[${slug}].personalities[${i}]`, text: p }));
    seed.motivations.forEach((m, i) => out.push({ source: `personaVariantSeed[${slug}].motivations[${i}]`, text: m }));
    seed.objections.forEach((o, i) => out.push({ source: `personaVariantSeed[${slug}].objections[${i}]`, text: o }));
  }
  for (const scenario of scenarios) {
    if (!scenario.customerPersona) continue;
    out.push({ source: `seed.ts scenarios[${scenario.slug}].customerPersona`, text: scenario.customerPersona });
  }
  return out;
}

describe("persona lint: hidden needs are earned, never demanded", () => {
  test("the corpus is actually being read", () => {
    const texts = allPersonaTexts();
    // A guard against the lint quietly passing because it scanned nothing, which
    // is the failure mode every corpus-wide check eventually has.
    assert.ok(texts.length > 200, `expected the full persona corpus, got ${texts.length} texts`);
    assert.ok(Object.keys(personaVariantSeed).length > 50);
    assert.ok(scenarios.length > 50);
  });

  test("no persona demands a specific without making it conditional", () => {
    const violations = allPersonaTexts().flatMap(({ source, text }) => lintPersonaText(source, text));
    assert.deepEqual(
      violations,
      [],
      `persona prose states a concrete specific as something the customer wants up front, ` +
        `with no "if asked" pairing. Rewrite the feeling as primary and the fact as what ` +
        `discovery uncovers:${report(violations)}`,
    );
  });

  test("the scenario the incident was reported against is clean", () => {
    // Named explicitly so a future edit that reintroduces the exact defect fails
    // on a test that says so, rather than on the corpus-wide one.
    const priya = personaVariantSeed["auto-sales-growing-family-suv"];
    assert.ok(priya);
    assert.deepEqual(lintPersonaText("priya.core", priya.core), []);
    assert.doesNotMatch(priya.core, /you want to hear specifics/i);
    assert.doesNotMatch(priya.core, /not just marketing/i);
    // The objections were half the defect: two of them scripted the specifics as
    // lines to deliver. They must no longer name either subject.
    for (const objection of priya.objections) {
      assert.doesNotMatch(objection, /\bratings?\b/i, `objection scripts the ratings: ${objection}`);
      assert.doesNotMatch(objection, /\bcar seat\b/i, `objection scripts the car seat: ${objection}`);
    }
  });
});

describe("persona lint: the check itself", () => {
  // The lint is only worth having if it would have caught the thing it was
  // written for, so the original text is kept here verbatim and asserted on.
  // Both texts are the pre-fix source, character for character, so this asserts
  // against what actually shipped rather than a tidied-up retelling of it.
  const ORIGINAL_SEED_BULLET =
    "- Safety ratings matter enormously to you right now (new parent anxiety) — " +
    'you want to hear specifics, not just marketing language like "very safe."';
  const ORIGINAL_CORE_PARAGRAPH =
    "Your real underlying situation (reveal ONLY if the consultant asks good discovery " +
    "questions, do not volunteer it upfront): you are quietly anxious about affordability " +
    "because one of you will be on reduced income during parental leave, and it feels too " +
    "vulnerable to raise unprompted. What matters most is specific safety data (not vague " +
    "reassurance) and how easy it is to install and access a car seat and stroller, which " +
    "counts far more than raw size. The oversized request is partly excitement and " +
    "nervousness talking.";

  test("it catches the original seed.ts bullet", () => {
    assert.equal(lintPersonaText("original", ORIGINAL_SEED_BULLET).length, 1);
  });

  test("it catches the original core, whose blanket caveat did not condition anything", () => {
    // The harder half of the incident. The paragraph opens by saying to reveal
    // only if asked and then states the specifics as a standing want anyway.
    const violations = lintPersonaText("original", ORIGINAL_CORE_PARAGRAPH);
    assert.equal(violations.length, 1);
    assert.match(violations[0].clause, /What matters most is specific safety data/);
  });

  test("the same fact paired with a conditional in the same breath passes", () => {
    const fixed =
      "- If asked what would actually reassure you, that's when it comes out that you want " +
      "to hear the specific crash ratings rather than being told the car is very safe.";
    assert.deepEqual(lintPersonaText("fixed", fixed), []);
  });

  test("a feeling that happens to name a spec is not a violation", () => {
    // The false positives the guardrails call out by name. A persona is allowed
    // to have a SEER rating or a square footage in it; what it may not do is
    // frame chasing one as the customer's own opening agenda.
    const fine = [
      "- The SEER rating on the quote means nothing to you and you would not know what to ask about it.",
      "- You have 1,800 square feet now and the thought of losing any of it unsettles you.",
      "- You want a house that feels like the one you raised your kids in.",
    ];
    for (const text of fine) assert.deepEqual(lintPersonaText("fine", text), []);
  });

  test("a demand naming nothing concrete is not a violation", () => {
    // Wanting a specific answer to a vague question is ordinary customer
    // behavior and teaches nothing bad; the defect needs a retrievable fact.
    assert.deepEqual(lintPersonaText("fine", "- You want a specific answer about how this will feel."), []);
  });

  test("a conditional about something else does not excuse the demand", () => {
    const text =
      "- If asked about your budget, you admit it is tight.\n\n" +
      "- You want to hear the exact crash ratings, not just marketing language.";
    assert.equal(lintPersonaText("split", text).length, 1);
  });
});
