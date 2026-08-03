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
