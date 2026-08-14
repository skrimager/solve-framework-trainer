import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// This cookie is intentionally separate from the admin-session cookie. It is
// only used to authorize manager/QA access to sensitive command-center data.
export const USER_SESSION_COOKIE = "solve_user_session";
export const USER_SESSION_TTL_MS = 1000 * 60 * 60 * 12;

type UserSessionPayload = {
  userId: number;
  exp: number;
};

// Local development and tests need a stable secret for the life of the process
// without ever shipping a known signing key. Production must supply a durable
// value so cookies remain valid across restarts/instances.
const developmentSessionSecret = randomBytes(32).toString("base64url");

function sessionSecret(): string {
  if (process.env.USER_SESSION_SECRET) return process.env.USER_SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("USER_SESSION_SECRET is required to sign command-center sessions in production");
  }
  return developmentSessionSecret;
}

function sign(body: string): string {
  return createHmac("sha256", sessionSecret()).update(body).digest("base64url");
}

export function signUserSession(userId: number, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ userId, exp: now + USER_SESSION_TTL_MS } satisfies UserSessionPayload),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyUserSession(token: string | undefined, now = Date.now()): UserSessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const supplied = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as UserSessionPayload;
    if (!Number.isInteger(payload.userId) || typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
