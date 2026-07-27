import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SOLVE_STEPS, WELCOME_FIRST, WELCOME_REPEAT } from "./demoWelcome";

const demoPageSource = readFileSync(
  fileURLToPath(new URL("../pages/demo-v2.tsx", import.meta.url)),
  "utf8",
);
// Comments stripped so prose in a comment cannot satisfy an assertion about the
// code itself.
const demoPageCode = demoPageSource.replace(/\/\/.*$/gm, "");

describe("welcome screen sits between the industry choice and the roleplay", () => {
  test("the industry choice now lands on the welcome step", () => {
    assert.match(demoPageCode, /setIndustry\(key\);\s*setStep\("welcome"\);/);
    assert.doesNotMatch(demoPageCode, /setIndustry\(key\);\s*setStep\("roleplay"\);/);
  });

  test("welcome is a real step and its button starts the roleplay", () => {
    assert.match(demoPageCode, /\|\s*"welcome"/);
    assert.match(demoPageCode, /step === "welcome" && \(\s*<WelcomeStep/);
    assert.match(demoPageCode, /onContinue=\{\(\) => setStep\("roleplay"\)\}/);
  });

  test("the variant is keyed off the paid return trip, not a new source of truth", () => {
    assert.match(demoPageCode, /variant=\{paidReturn \? "repeat" : "first"\}/);
  });

  test("it renders the documented test ids", () => {
    for (const marker of [
      "text-demo-v2-welcome-headline",
      "button-demo-v2-welcome-continue",
      "list-demo-v2-welcome-solve-steps",
      "text-demo-v2-welcome-footnote",
    ]) {
      assert.ok(demoPageSource.includes(marker), `missing ${marker}`);
    }
  });
});

describe("welcome copy", () => {
  test("the first-session variant frames discovery, not closing", () => {
    assert.equal(WELCOME_FIRST.headline, "Before you start: here's how this works.");
    assert.match(WELCOME_FIRST.intro, /Your job isn't to close them/);
    assert.match(WELCOME_FIRST.intro, /understand them/);
    assert.match(WELCOME_FIRST.goal, /no objections left to overcome/);
    assert.match(WELCOME_FIRST.why, /more referrals/);
  });

  test("it says how they are scored and who scores them", () => {
    assert.match(WELCOME_FIRST.coach, /SOLVE Coach™/);
    assert.match(WELCOME_FIRST.footnote, /score and coaching/);
  });

  test("it explains both typing and voice mode, including how to turn voice on", () => {
    assert.match(WELCOME_FIRST.inputBody, /Voice Mode in the top right/);
    assert.match(WELCOME_FIRST.inputBody, /allow microphone access/);
    assert.match(WELCOME_FIRST.inputBody, /turn your sound up/);
    assert.match(WELCOME_FIRST.inputBody, /text mode is on by default/);
    assert.match(WELCOME_REPEAT.body, /Voice Mode in the top right/);
  });

  test("all five SOLVE steps are listed in order", () => {
    assert.deepEqual(
      SOLVE_STEPS.map((s) => s.letter),
      ["S", "O", "L", "V", "E"],
    );
    assert.deepEqual(
      SOLVE_STEPS.map((s) => s.label),
      [
        "Situation",
        "Open with questions",
        "Listen for the motivation",
        "Visualize success",
        "Engineer the solution",
      ],
    );
    for (const solveStep of SOLVE_STEPS) {
      assert.ok(solveStep.body.length > 0, solveStep.letter);
    }
  });

  test("the repeat variant is short and promises a different customer", () => {
    assert.equal(WELCOME_REPEAT.headline, "Round two. New customer, new motivation.");
    assert.match(WELCOME_REPEAT.body, /something different than the last one/);
    assert.ok(WELCOME_REPEAT.body.length < WELCOME_FIRST.why.length + WELCOME_FIRST.goal.length);
  });

  test("both variants use the same start label", () => {
    assert.equal(WELCOME_FIRST.buttonLabel, "Start the Conversation →");
    assert.equal(WELCOME_REPEAT.buttonLabel, WELCOME_FIRST.buttonLabel);
  });

  test("copy says 'practice', never 'train', and carries no em dashes", () => {
    const copy = [
      ...Object.values(WELCOME_FIRST),
      ...Object.values(WELCOME_REPEAT),
      ...SOLVE_STEPS.flatMap((s) => [s.letter, s.label, s.body]),
    ].join(" ");
    assert.ok(!copy.includes("—"), "no em dashes in customer-facing copy");
    assert.doesNotMatch(copy, /\btrain(ing|s|ed)?\b/i);
    assert.match(copy, /practice/i);
  });
});

describe("welcome screen styling stays on the existing scale", () => {
  test("the SOLVE bullets are orange dots from the shared constant", () => {
    assert.match(demoPageCode, /list-demo-v2-welcome-solve-steps/);
    assert.match(
      demoPageCode,
      /rounded-full"\s*\n\s*style=\{\{ backgroundColor: ORANGE \}\}/,
    );
  });

  test("the continue button is orange with dark text and adds no new color", () => {
    assert.match(demoPageCode, /className="text-sidebar-primary-foreground"/);
    const hexes = new Set(demoPageSource.match(/#[0-9A-Fa-f]{3,8}/g) ?? []);
    assert.deepEqual([...hexes], ["#E06D00"]);
  });

  test("it reuses the sibling steps' typographic scale", () => {
    assert.match(
      demoPageCode,
      /className="text-2xl font-semibold" data-testid="text-demo-v2-welcome-headline"/,
    );
  });
});
