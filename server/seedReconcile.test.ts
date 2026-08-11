// Tests for the boot-time reconcile that repairs the six public demo scenarios
// whose rows were persisted with active:false before the source data flipped to
// active:true. The seed loop is insert-only, so without this step a live
// database keeps the stale flag forever.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { reconcileDemoV2Active, scenarios } from "./seed";
import { DEMO_V2_ALL_SLUGS } from "./demoV2";

type Row = { id: number; slug: string; active: boolean };
const LEGACY_DEMO_V2_SLUGS = [
  "demo-v2-re-1",
  "demo-v2-re-2",
  "demo-v2-re-3",
  "demo-v2-auto-1",
  "demo-v2-auto-2",
  "demo-v2-auto-3",
];

// Minimal stand-in for the scenarios table: just enough to observe which rows
// the reconcile writes to, and how many times.
function makeStore(rows: Row[]) {
  const writes: { id: number; active: boolean }[] = [];
  return {
    rows,
    writes,
    async updateScenario(id: number, patch: { active?: boolean }) {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      if (patch.active !== undefined) row.active = patch.active;
      writes.push({ id, active: row.active });
      return row as never;
    },
  };
}

// Mirrors the current production state: the original six demo rows landed with
// active:false, alongside the real training portfolio which is active:true.
function productionLikeRows(): Row[] {
  const demo = LEGACY_DEMO_V2_SLUGS.map((slug, i) => ({ id: 100 + i, slug, active: false }));
  const real = [
    { id: 1, slug: "manufactured-housing-first-time-buyer", active: true },
    { id: 2, slug: "auto-sales-price-shopper", active: true },
    // A real scenario intentionally retired. The reconcile must leave it alone.
    { id: 3, slug: "retired-real-scenario", active: false },
  ];
  return [...real, ...demo];
}

describe("reconcileDemoV2Active", () => {
  test("flips the original persisted demo scenarios to active and touches nothing else", async () => {
    const store = makeStore(productionLikeRows());

    const reconciled = await reconcileDemoV2Active(store.rows, store);

    assert.deepEqual([...reconciled].sort(), [...LEGACY_DEMO_V2_SLUGS].sort());
    for (const slug of LEGACY_DEMO_V2_SLUGS) {
      assert.equal(store.rows.find((r) => r.slug === slug)!.active, true, slug);
    }
    assert.equal(store.rows.find((r) => r.slug === "retired-real-scenario")!.active, false);
    assert.equal(store.rows.find((r) => r.slug === "manufactured-housing-first-time-buyer")!.active, true);
    assert.deepEqual(
      store.writes.map((w) => w.id).sort((a, b) => a - b),
      LEGACY_DEMO_V2_SLUGS.map((_, i) => 100 + i),
    );
  });

  test("running it a second time is a no-op with no further writes", async () => {
    const store = makeStore(productionLikeRows());

    await reconcileDemoV2Active(store.rows, store);
    const writesAfterFirst = store.writes.length;
    const secondRun = await reconcileDemoV2Active(store.rows, store);

    assert.deepEqual(secondRun, []);
    assert.equal(store.writes.length, writesAfterFirst);
    assert.equal(store.rows.length, productionLikeRows().length);
    for (const slug of LEGACY_DEMO_V2_SLUGS) {
      assert.equal(store.rows.find((r) => r.slug === slug)!.active, true, slug);
    }
  });

  test("a fresh database with none of the six rows yet writes nothing", async () => {
    const store = makeStore([{ id: 1, slug: "manufactured-housing-first-time-buyer", active: true }]);

    const reconciled = await reconcileDemoV2Active(store.rows, store);

    assert.deepEqual(reconciled, []);
    assert.equal(store.writes.length, 0);
  });

  test("demo rows already active are left untouched", async () => {
    const rows = DEMO_V2_ALL_SLUGS.map((slug, i) => ({ id: 100 + i, slug, active: true }));
    const store = makeStore(rows);

    const reconciled = await reconcileDemoV2Active(store.rows, store);

    assert.deepEqual(reconciled, []);
    assert.equal(store.writes.length, 0);
  });

  test("the source seed data for the six demo slugs is active:true, so inserts need no repair", () => {
    for (const slug of DEMO_V2_ALL_SLUGS) {
      const row = scenarios.find((s) => s.slug === slug);
      assert.ok(row, `${slug} missing from seed data`);
      assert.equal(row.active, true, slug);
    }
  });
});
