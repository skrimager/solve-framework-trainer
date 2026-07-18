import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parse as parsePattern } from "regexparam";

import { splitHash, hashToPath, hashToSearch } from "./hashLocation";

// The URL Stripe redirects the browser to after a completed checkout.
const STRIPE_REDIRECT_HASH = "#/office-setup/complete?session_id=cs_test_123";

// Mirror of the app's route table (order matters: the exact completion route
// precedes the token route). Returns the winning route pattern for a given
// location path, like wouter's <Switch>.
const ROUTES = ["/office-setup/complete", "/office-setup/:token"] as const;
function matchFirst(path: string): { route: string; token?: string } | null {
  for (const route of ROUTES) {
    const { pattern, keys } = parsePattern(route);
    const m = pattern.exec(path);
    if (m) {
      const token = keys.length ? m[1] : undefined;
      return { route, token };
    }
  }
  return null;
}

describe("hash location parsing", () => {
  test("splits path and search from a hash carrying a query string", () => {
    assert.deepEqual(splitHash(STRIPE_REDIRECT_HASH), {
      path: "/office-setup/complete",
      search: "?session_id=cs_test_123",
    });
  });

  test("hashToPath strips the query so the path is clean", () => {
    assert.equal(hashToPath(STRIPE_REDIRECT_HASH), "/office-setup/complete");
  });

  test("hashToSearch preserves the query for the component to read", () => {
    assert.equal(hashToSearch(STRIPE_REDIRECT_HASH), "?session_id=cs_test_123");
    const sessionId = new URLSearchParams(
      hashToSearch(STRIPE_REDIRECT_HASH),
    ).get("session_id");
    assert.equal(sessionId, "cs_test_123");
  });

  test("handles a hash with no query string", () => {
    assert.deepEqual(splitHash("#/office-setup/complete"), {
      path: "/office-setup/complete",
      search: "",
    });
  });

  test("handles the root hash", () => {
    assert.equal(hashToPath("#/"), "/");
    assert.equal(hashToPath("#"), "/");
    assert.equal(hashToPath(""), "/");
  });
});

describe("office-setup completion routing", () => {
  test("stripped path matches the completion route, not the token route", () => {
    const path = hashToPath(STRIPE_REDIRECT_HASH);
    const match = matchFirst(path);
    assert.equal(match?.route, "/office-setup/complete");
    assert.equal(match?.token, undefined);
  });

  test("regression: the raw hash (with query) is swallowed by the token route", () => {
    // Before the fix, wouter matched against the query-bearing path, so the
    // completion page never rendered and the token page fired the malformed
    // GET /api/office-setup/complete request that 404'd on first load.
    const rawPath = STRIPE_REDIRECT_HASH.replace(/^#/, "");
    const match = matchFirst(rawPath);
    assert.equal(match?.route, "/office-setup/:token");
    assert.equal(match?.token, "complete?session_id=cs_test_123");
  });
});
