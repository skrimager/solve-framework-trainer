import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parse as parsePattern } from "regexparam";

import {
  ROUTES,
  LEGACY_REDIRECTS,
  wrongCredentialTypeRedirect,
  postLoginPath,
} from "./routes";

// Mirror of the app's canonical route table (App.tsx <Switch>), in order. Each
// entry is the path a wouter <Route> matches. Redirect targets are resolved from
// LEGACY_REDIRECTS so this stays a single source of truth with the app.
const ROUTE_TABLE = [
  { path: "/", name: "home" },
  { path: "/practice", name: "practice" },
  { path: "/command-center", name: "command-center" },
  { path: "/register", name: "register" },
  { path: "/demo", name: "demo" },
  { path: "/academy", name: "academy" },
  { path: "/scenarios", name: "scenarios" },
  // Legacy aliases (redirect-only routes) come before the catch-all.
  { path: "/login", name: "redirect" },
  { path: "/manager-login", name: "redirect" },
  { path: "/dashboard", name: "redirect" },
  { path: "/certification", name: "redirect" },
] as const;

function matchFirst(path: string): string | null {
  for (const route of ROUTE_TABLE) {
    const { pattern } = parsePattern(route.path);
    if (pattern.exec(path)) return route.name;
  }
  return null;
}

describe("chooser and canonical routes", () => {
  test("root path renders the chooser, not a login form", () => {
    assert.equal(matchFirst("/"), "home");
  });

  test("consultant practice login lives at /practice", () => {
    assert.equal(matchFirst("/practice"), "practice");
    assert.equal(ROUTES.practice, "/practice");
  });

  test("manager command center lives at /command-center", () => {
    assert.equal(matchFirst("/command-center"), "command-center");
    assert.equal(ROUTES.commandCenter, "/command-center");
  });

  test("academy (certification) has its own route", () => {
    assert.equal(matchFirst("/academy"), "academy");
    assert.equal(ROUTES.academy, "/academy");
  });

  test("demo path is preserved", () => {
    assert.equal(matchFirst("/demo"), "demo");
    assert.equal(ROUTES.demo, "/demo");
  });
});

describe("backward-compatible redirects", () => {
  test("old paths still match a route (never fall through to 404)", () => {
    for (const oldPath of Object.keys(LEGACY_REDIRECTS)) {
      assert.equal(matchFirst(oldPath), "redirect", `${oldPath} should be a redirect route`);
    }
  });

  test("legacy paths map to their new canonical equivalents", () => {
    assert.equal(LEGACY_REDIRECTS["/login"], "/practice");
    assert.equal(LEGACY_REDIRECTS["/manager-login"], "/command-center");
    assert.equal(LEGACY_REDIRECTS["/dashboard"], "/command-center");
    assert.equal(LEGACY_REDIRECTS["/certification"], "/academy");
  });
});

describe("post-login destination by role", () => {
  test("consultants go to practice scenarios", () => {
    assert.equal(postLoginPath("consultant"), "/scenarios");
  });

  test("managers and qa go to the command center", () => {
    assert.equal(postLoginPath("manager"), "/command-center");
    assert.equal(postLoginPath("qa"), "/command-center");
  });
});

describe("wrong-credential-type redirect", () => {
  test("manager account on the consultant form is redirected to the Command Center", () => {
    const r = wrongCredentialTypeRedirect("consultant", "manager");
    assert.ok(r);
    assert.equal(r!.redirectTo, "/command-center");
    assert.match(r!.message, /manager account/i);
  });

  test("consultant account on the manager form is redirected to Practice", () => {
    const r = wrongCredentialTypeRedirect("manager", "consultant");
    assert.ok(r);
    assert.equal(r!.redirectTo, "/practice");
    assert.match(r!.message, /consultant account/i);
  });

  test("matching roles produce no redirect (normal sign-in)", () => {
    assert.equal(wrongCredentialTypeRedirect("consultant", "consultant"), null);
    assert.equal(wrongCredentialTypeRedirect("manager", "manager"), null);
  });

  test("qa is treated as a manager-side account on the manager form", () => {
    // qa is a non-consultant role; it belongs on the command-center side, so the
    // manager form should sign it in rather than bounce it to Practice.
    assert.equal(wrongCredentialTypeRedirect("manager", "qa"), null);
  });

  test("the redirect copy contains no em dash (site-wide style rule)", () => {
    const a = wrongCredentialTypeRedirect("consultant", "manager");
    const b = wrongCredentialTypeRedirect("manager", "consultant");
    assert.doesNotMatch(a!.message, /—/);
    assert.doesNotMatch(b!.message, /—/);
  });
});
