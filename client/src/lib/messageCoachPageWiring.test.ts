import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-inspection tests for the Message Coach page, same pattern as
// messageCoachCopy.test.ts and scenariosPageWiring.test.ts: read the raw
// .tsx and assert on the literal wiring. Covers a real bug found in
// production: members were shown the anonymous "try the free demo / see
// pricing" upsell after every score, and had no way back to SOLVE Academy
// except the browser back button.
const pageSource = readFileSync(
  fileURLToPath(new URL("../pages/message-coach.tsx", import.meta.url)),
  "utf8",
);

describe("Message Coach member experience", () => {
  test("members get a way back to SOLVE Academy from the header", () => {
    assert.match(pageSource, /\{isMember && \(/);
    assert.ok(pageSource.includes('data-testid="button-message-coach-back-to-practice"'));
    assert.ok(pageSource.includes('onClick={() => navigate("/scenarios")}'));
    assert.ok(pageSource.includes("Back to SOLVE Academy"));
  });

  // Real bug, reported by a member testing production: the header button
  // exists, but after scrolling through a scored result (score, where it
  // stalled, coaching, the rewrite, and its copy button) the header is long
  // out of view. A member reaching the end of the results had nothing to
  // tap except the phone's own back button.
  test("members also get a way back to SOLVE Academy after a scored result, not just in the header", () => {
    const resultSectionIndex = pageSource.indexOf('data-testid="section-message-coach-result"');
    assert.ok(resultSectionIndex > -1, "result section not found");
    const bottomButtonIndex = pageSource.indexOf(
      'data-testid="button-message-coach-back-to-practice-bottom"',
    );
    assert.ok(
      bottomButtonIndex > resultSectionIndex,
      "a second exit button must exist inside the scored-result section",
    );
    const gateBeforeBottomButton = pageSource.lastIndexOf("{isMember && (", bottomButtonIndex);
    assert.ok(
      gateBeforeBottomButton > resultSectionIndex,
      "the bottom exit button must be gated on isMember",
    );
    // Look at the whole <Button>...</Button> block around the testid, not
    // just what follows it, since attribute order in JSX is not guaranteed.
    const windowStart = Math.max(gateBeforeBottomButton, bottomButtonIndex - 300);
    const windowEnd = bottomButtonIndex + 300;
    const buttonBlock = pageSource.slice(windowStart, windowEnd);
    assert.ok(
      buttonBlock.includes('onClick={() => navigate("/scenarios")}'),
      "the bottom exit button must navigate to /scenarios",
    );
    assert.ok(
      buttonBlock.includes("Back to SOLVE Academy"),
      "the bottom exit button must use the exact brand label",
    );
  });

  test("the demo/pricing upsell after a score is hidden from members", () => {
    // Isolate the funnel card's own block (from its opening gate to its
    // closing tag) so this doesn't get confused by the earlier isMember
    // usages higher up in the file.
    const funnelHeadlineIndex = pageSource.indexOf("{FUNNEL_COPY.headline}");
    assert.ok(funnelHeadlineIndex > -1, "funnel card not found");
    const gateBeforeFunnel = pageSource.lastIndexOf("{!isMember && (", funnelHeadlineIndex);
    assert.ok(
      gateBeforeFunnel > -1,
      "the demo/pricing funnel card must be wrapped in a !isMember check",
    );
    // No card boundary (no other top-level conditional) should sit between
    // the gate and the headline.
    const between = pageSource.slice(gateBeforeFunnel, funnelHeadlineIndex);
    assert.ok(
      !between.includes("{isMember && ("),
      "an isMember (not !isMember) gate must not reopen between the funnel gate and its content",
    );
  });
});
