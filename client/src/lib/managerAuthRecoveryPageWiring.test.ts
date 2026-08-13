import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitHash } from "./hashLocation";

// Source-inspection tests for the manager forgot-password / forgot-username /
// reset-password screens, following the same pattern as
// scenariosPageWiring.test.ts and messageCoachPageWiring.test.ts: read the raw
// .tsx and assert on the literal wiring rather than rendering the component
// (this repo has no jsdom/render harness for .tsx files — see
// client/src/lib/*.test.ts for every existing frontend test).

const loginSource = readFileSync(
  fileURLToPath(new URL("../pages/manager-login.tsx", import.meta.url)),
  "utf8",
);
const forgotPasswordSource = readFileSync(
  fileURLToPath(new URL("../pages/manager-forgot-password.tsx", import.meta.url)),
  "utf8",
);
const forgotUsernameSource = readFileSync(
  fileURLToPath(new URL("../pages/manager-forgot-username.tsx", import.meta.url)),
  "utf8",
);
const resetPasswordSource = readFileSync(
  fileURLToPath(new URL("../pages/manager-reset-password.tsx", import.meta.url)),
  "utf8",
);
const appSource = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

describe("manager-login.tsx forgot-password / forgot-username links", () => {
  test("renders a 'Forgot password?' link with the expected test id", () => {
    assert.ok(loginSource.includes('data-testid="link-forgot-password"'));
    assert.match(loginSource, /Forgot password\?/);
  });

  test("renders a 'Forgot username?' link with the expected test id", () => {
    assert.ok(loginSource.includes('data-testid="link-forgot-username"'));
    assert.match(loginSource, /Forgot username\?/);
  });

  test("both links navigate via ROUTES constants, not hardcoded paths", () => {
    const forgotPasswordBlockStart = loginSource.indexOf('data-testid="link-forgot-password"');
    const forgotUsernameBlockStart = loginSource.indexOf('data-testid="link-forgot-username"');
    assert.ok(forgotPasswordBlockStart > -1 && forgotUsernameBlockStart > -1);

    const beforeForgotPassword = loginSource.slice(0, forgotPasswordBlockStart);
    const beforeForgotUsername = loginSource.slice(0, forgotUsernameBlockStart);
    assert.match(beforeForgotPassword.slice(-400), /navigate\(ROUTES\.managerForgotPassword\)/);
    assert.match(beforeForgotUsername.slice(-400), /navigate\(ROUTES\.managerForgotUsername\)/);
    assert.ok(loginSource.includes('import { wrongCredentialTypeRedirect, ROUTES } from "@/lib/routes"'));
  });

  test("both links sit inside the login form, below the submit button", () => {
    const submitIdx = loginSource.indexOf('data-testid="button-manager-login"');
    const forgotPasswordIdx = loginSource.indexOf('data-testid="link-forgot-password"');
    const forgotUsernameIdx = loginSource.indexOf('data-testid="link-forgot-username"');
    const formCloseIdx = loginSource.indexOf("</form>");
    assert.ok(submitIdx < forgotPasswordIdx);
    assert.ok(submitIdx < forgotUsernameIdx);
    assert.ok(forgotPasswordIdx < formCloseIdx);
    assert.ok(forgotUsernameIdx < formCloseIdx);
  });
});

describe("manager-forgot-password.tsx", () => {
  test("posts to /api/manager/forgot-password", () => {
    assert.match(forgotPasswordSource, /apiRequest\("POST",\s*"\/api\/manager\/forgot-password"/);
  });

  test("shows a generic confirmation regardless of outcome (anti-enumeration)", () => {
    assert.ok(forgotPasswordSource.includes('data-testid="text-forgot-password-confirmation"'));
    assert.match(forgotPasswordSource, /If an account exists for that email/);
  });

  test("the confirmation is shown from both the try and catch paths, not just on success", () => {
    const tryBlock = forgotPasswordSource.slice(
      forgotPasswordSource.indexOf("try {"),
      forgotPasswordSource.indexOf("finally"),
    );
    const finallyBlock = forgotPasswordSource.slice(forgotPasswordSource.indexOf("finally"));
    assert.match(finallyBlock.slice(0, 200), /setSubmitted\(true\)/);
    // setSubmitted(true) lives in `finally`, so it runs whether the request
    // resolved or rejected — the one thing that must be true for this test.
    assert.ok(!tryBlock.includes("setSubmitted"));
  });
});

describe("manager-forgot-username.tsx", () => {
  test("posts to /api/manager/forgot-username", () => {
    assert.match(forgotUsernameSource, /apiRequest\("POST",\s*"\/api\/manager\/forgot-username"/);
  });

  test("shows a generic confirmation regardless of outcome (anti-enumeration)", () => {
    assert.ok(forgotUsernameSource.includes('data-testid="text-forgot-username-confirmation"'));
    assert.match(forgotUsernameSource, /If an account exists for that email/);
  });
});

describe("manager-reset-password.tsx token handling", () => {
  test("reads the token from the hash query string via hashToSearch, matching register.tsx's ?code= pattern", () => {
    assert.ok(resetPasswordSource.includes('import { hashToSearch } from "@/lib/hashLocation"'));
    assert.match(
      resetPasswordSource,
      /new URLSearchParams\(hashToSearch\(window\.location\.hash\)\)\.get\("token"\)/,
    );
  });

  test("a #/reset-password?token=... hash actually yields that token via splitHash", () => {
    // Exercises the real parsing helper the page depends on, rather than only
    // asserting on the source text above.
    const { search } = splitHash("#/reset-password?token=abc123");
    const token = new URLSearchParams(search).get("token");
    assert.equal(token, "abc123");
  });

  test("posts the token and new password to /api/manager/reset-password", () => {
    assert.match(
      resetPasswordSource,
      /apiRequest\("POST",\s*"\/api\/manager\/reset-password",\s*\{\s*token,\s*newPassword\s*\}\)/,
    );
  });

  test("shows a dedicated message when the token is missing, instead of silently submitting", () => {
    assert.ok(resetPasswordSource.includes('data-testid="text-reset-password-missing-token"'));
    assert.match(resetPasswordSource, /!token \?/);
  });

  test("offers a link back to request a new reset link on an invalid/expired token", () => {
    assert.ok(resetPasswordSource.includes('data-testid="button-request-new-reset-link"'));
    assert.match(resetPasswordSource, /navigate\(ROUTES\.managerForgotPassword\)/);
  });

  test("redirects toward sign-in after a successful reset", () => {
    assert.ok(resetPasswordSource.includes('data-testid="button-go-to-sign-in"'));
    assert.match(resetPasswordSource, /navigate\(ROUTES\.commandCenter\)/);
  });

  test("rejects submission client-side when the two password fields don't match", () => {
    assert.match(resetPasswordSource, /newPassword !== confirmPassword/);
    assert.match(resetPasswordSource, /Passwords don't match/);
  });
});

describe("App.tsx route registration", () => {
  test("registers /command-center/forgot-password, /command-center/forgot-username, and /reset-password", () => {
    assert.match(appSource, /<Route path="\/command-center\/forgot-password" component=\{ManagerForgotPassword\} \/>/);
    assert.match(appSource, /<Route path="\/command-center\/forgot-username" component=\{ManagerForgotUsername\} \/>/);
    assert.match(appSource, /<Route path="\/reset-password" component=\{ManagerResetPassword\} \/>/);
  });

  test("the forgot-password/forgot-username routes are declared before the generic /command-center route's siblings, all outside RequireAuth", () => {
    const authImportIdx = appSource.indexOf("function RequireAuth");
    const forgotPasswordRouteIdx = appSource.indexOf('path="/command-center/forgot-password"');
    assert.ok(authImportIdx > -1 && forgotPasswordRouteIdx > -1);
    const routeBlock = appSource.slice(
      appSource.indexOf('path="/command-center/forgot-password"') - 20,
      appSource.indexOf('path="/command-center/forgot-password"') + 300,
    );
    assert.ok(!routeBlock.includes("RequireAuth"));
  });
});

describe("routes.ts manager recovery route constants", () => {
  test("routes.ts defines managerForgotPassword, managerResetPassword, and managerForgotUsername", async () => {
    const { ROUTES } = await import("./routes");
    assert.equal(ROUTES.managerForgotPassword, "/command-center/forgot-password");
    assert.equal(ROUTES.managerResetPassword, "/reset-password");
    assert.equal(ROUTES.managerForgotUsername, "/command-center/forgot-username");
  });
});
