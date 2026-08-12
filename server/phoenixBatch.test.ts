import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { planPhoenixBatch, distinctSegments, deriveContactEmail, phoenixBatchSeed } from "./phoenixBatch";

describe("phoenix discovery batch", () => {
  const plan = planPhoenixBatch();

  test("loads exactly 7 companies for the Phoenix, AZ market", () => {
    assert.equal(plan.companies.length, 7);
    assert.equal(plan.search.resultsCount, 7);
    assert.equal(plan.search.geography, "Phoenix, AZ");
    assert.equal(plan.search.status, "pending_review");
  });

  test("geography is data, not a hardcoded 'Phoenix' constant elsewhere", () => {
    // The only place the market appears is the search's geography field.
    assert.equal(phoenixBatchSeed.geography, "Phoenix, AZ");
    // Companies carry their own city/state; not every company is in Phoenix.
    const cities = new Set(plan.companies.map((c) => c.company.city));
    assert.ok(cities.size > 1, "companies span multiple cities, not hardcoded to Phoenix");
  });

  test("Sunstate Equipment is excluded", () => {
    const names = plan.companies.map((c) => c.company.name.toLowerCase());
    assert.ok(!names.some((n) => n.includes("sunstate")), "Sunstate must not be in this batch");
  });

  test("each company is tagged with its own segment", () => {
    const bySegment = new Map<string, string[]>();
    for (const c of plan.companies) {
      const list = bySegment.get(c.company.segment) ?? [];
      list.push(c.company.name);
      bySegment.set(c.company.segment, list);
    }
    assert.deepEqual(bySegment.get("HVAC / Home Services"), [
      "Chas Roberts Air Conditioning, Inc.",
      "Parker and Sons",
    ]);
    assert.deepEqual(bySegment.get("Manufactured Housing Community Management"), [
      "Valley Vistas Management Company Inc",
      "MAR Communities",
    ]);
    assert.deepEqual(bySegment.get("Auto Dealerships"), ["Berge Auto Group"]);
    assert.deepEqual(bySegment.get("Property Management / Conflict-Heavy Service Businesses"), [
      "Plaza Companies",
      "Commercial Properties Inc. (CPI)",
    ]);
  });

  test("the batch's search row records every segment it spans", () => {
    const segments = distinctSegments(phoenixBatchSeed);
    for (const s of segments) assert.ok(plan.search.segment.includes(s), `search segment includes "${s}"`);
  });

  test("all 28 contacts insert with a required non-empty email", () => {
    assert.equal(plan.contactCount, 28);
    for (const c of plan.companies) {
      for (const ct of c.contacts) {
        assert.ok(ct.contact.email.length > 0, `${ct.contact.fullName} has an email`);
        assert.match(ct.contact.email, /@/);
      }
    }
  });

  test("real captured email is preserved over a derived one", () => {
    const vv = plan.companies.find((c) => c.company.name.startsWith("Valley Vistas"))!;
    const tj = vv.contacts.find((ct) => ct.contact.fullName === "TJ Geninatti")!;
    assert.equal(tj.contact.email, "tj@valleyvistasmc.com");
  });

  test("derived placeholder emails are first.last@domain", () => {
    assert.equal(deriveContactEmail("Sissie Shank", "chasroberts.com"), "sissie.shank@chasroberts.com");
  });

  test("every contact gets a three-step draft drip", () => {
    assert.equal(plan.outreachCount, plan.contactCount * 3);
    for (const c of plan.companies) {
      for (const ct of c.contacts) {
        assert.deepEqual(
          ct.outreach.map((o) => o.sequenceStep),
          [1, 2, 3],
        );
        for (const o of ct.outreach) {
          assert.equal(o.status, "draft");
          assert.equal(o.scheduledAt, null);
          assert.equal(o.sentAt, null);
        }
      }
    }
  });

  test("generated outreach copy honors the discovery-training terminology convention", () => {
    for (const c of plan.companies) {
      for (const ct of c.contacts) {
        for (const o of ct.outreach) {
          const copy = `${o.emailSubject} ${o.emailBody}`.toLowerCase();
          assert.doesNotMatch(copy, /\bsales\b/, "no 'sales' in prospect copy");
          assert.doesNotMatch(copy, /ai roleplay/, "no 'AI roleplay' in prospect copy");
          assert.match(copy, /role-play/);
          assert.match(copy, /scor|track/);
          assert.match(copy, /certification/);
          assert.match(copy, /solveframework\.com\/demo/);
        }
      }
    }
  });
});
