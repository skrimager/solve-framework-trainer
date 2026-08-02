import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-inspection tests for the practice/scenarios screen, following the
// same pattern as messageCoachCopy.test.ts: read the raw .tsx and assert on
// the literal wiring rather than rendering the component. This screen has no
// existing dedicated test file, so this covers just the new
// "Score an Outbound Text or Email" card added for members with an active
// seat.
const pageSource = readFileSync(
  fileURLToPath(new URL("../pages/scenarios.tsx", import.meta.url)),
  "utf8",
);

describe("Score an Outbound Text or Email card", () => {
  test("is gated on an active seat, not just being logged in", () => {
    const code = pageSource.replace(/\/\/.*$/gm, "");
    assert.match(code, /\{user\?\.seatActive && \(/);
    assert.ok(code.includes('data-testid="card-score-outbound-message"'));
  });

  test("routes to the Message Coach page, which already gives members unlimited scoring", () => {
    const code = pageSource.replace(/\/\/.*$/gm, "");
    assert.match(code, /onClick=\{\(\) => navigate\("\/message-coach"\)\}/);
    assert.ok(code.includes('data-testid="button-open-message-coach"'));
  });

  test("the card's own unlimited-access copy sits inside the seatActive gate", () => {
    // Isolate just the card's JSX block (from its data-testid to its closing
    // </Card>) and check the seatActive gate and the "unlimited" claim both
    // live inside it, rather than string-searching the whole file (which
    // also contains "Unlimited" inside an explanatory code comment above the
    // gate).
    const cardStart = pageSource.indexOf('data-testid="card-score-outbound-message"');
    assert.ok(cardStart > -1, "card not found");
    const cardEnd = pageSource.indexOf("</Card>", cardStart);
    const gateOpenBeforeCard = pageSource.lastIndexOf("{user?.seatActive && (", cardStart);
    const cardBlock = pageSource.slice(cardStart, cardEnd);
    assert.ok(gateOpenBeforeCard > -1, "seatActive gate must open before the card");
    assert.ok(cardBlock.includes("Unlimited with"), "card copy must mention unlimited access");
  });
});
