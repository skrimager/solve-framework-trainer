import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../pages/demo-v2.tsx", import.meta.url)), "utf8");

describe("demo v2 grouped industry picker", () => {
  test("keeps one accessible radio group while separating sales and leadership choices", () => {
    assert.match(source, /role="radiogroup"/);
    assert.match(source, /role="radio"/);
    assert.match(source, /aria-checked=\{isSelected\}/);
    assert.match(source, /option\.group === "sales_service"/);
    assert.match(source, /option\.group === "leadership"/);
  });

  test("renders stable group and option test ids", () => {
    assert.match(source, /data-testid="demo-v2-industry-picker"/);
    assert.match(source, /data-testid="demo-v2-industry-group-sales-service"/);
    assert.match(source, /data-testid="demo-v2-industry-group-leadership"/);
    assert.match(source, /demo-v2-industry-option-\$\{option\.key\}/);
  });

  test("uses independently responsive grids for both conversation groups", () => {
    assert.match(source, /Sales &amp; Service/);
    assert.match(source, /Leadership Conversations/);
    assert.match(source, /grid gap-3 sm:grid-cols-3/);
    assert.match(source, /grid gap-3 sm:grid-cols-2/);
  });
});
