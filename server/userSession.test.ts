import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { USER_SESSION_TTL_MS, signUserSession, verifyUserSession } from "./userSession";

describe("command-center user sessions", () => {
  test("verifies a signed cookie for its logged-in user", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const token = signUserSession(42, now);

    assert.deepEqual(verifyUserSession(token, now + 1), {
      userId: 42,
      exp: now + USER_SESSION_TTL_MS,
    });
  });

  test("rejects tampered and expired cookies", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    const token = signUserSession(42, now);

    assert.equal(verifyUserSession(`${token}x`, now + 1), null);
    assert.equal(verifyUserSession(token, now + USER_SESSION_TTL_MS), null);
  });
});
