import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { DemoSignup } from "@shared/schema";

// ---------------------------------------------------------------------------
// Public "Free Voice Demo" logic. This is intentionally self-contained and
// pure (no DB/HTTP) so it can be unit-tested directly. The demo is separate
// from every seat-gated flow: an anonymous visitor verifies ONE email via a
// 6-digit code, and that verified email is capped at MAX_DEMO_SESSIONS all-time.
// ---------------------------------------------------------------------------

// A verified visitor gets this many free roleplay sessions, ever, per email.
export const MAX_DEMO_SESSIONS = 3;

// Emails in this allowlist never hit the free-session cap. This exists for the
// founder's own live sales demos to prospective business customers, where
// re-using the same email repeatedly must never lock out mid-demo. Configure
// via UNLIMITED_DEMO_EMAILS (comma-separated) to add more without a code
// change; the founder's email is always included as a sane default even if
// the env var is unset or misconfigured.
const DEFAULT_UNLIMITED_DEMO_EMAILS = ["wadeskrimager@icloud.com"];

function unlimitedDemoEmails(): Set<string> {
  const fromEnv = (process.env.UNLIMITED_DEMO_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_UNLIMITED_DEMO_EMAILS, ...fromEnv]);
}

// True if this email is exempt from the demo session cap (case-insensitive).
export function isUnlimitedDemoEmail(email: string): boolean {
  return unlimitedDemoEmails().has(normalizeEmail(email));
}

// A freshly-emailed code is valid for this long before it must be re-sent.
export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// After verifying, this signed token IS the demo's auth for the roleplay calls
// (no login). Kept short-lived; a visitor re-verifies if they let it lapse.
const DEMO_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// The single fixed scenario every demo uses. Seeded by server/seed.ts. There is
// deliberately no scenario selection in the demo.
export const DEMO_SCENARIO_SLUG = "real-estate-demo-buyer-30-days";

function demoSecret(): string {
  return process.env.DEMO_SESSION_SECRET || "solve-demo-dev-secret-change-me";
}

// Normalize emails so "A@B.com " and "a@b.com" collapse to one signup row and
// one usage counter.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// A uniformly-random zero-padded 6-digit code. randomInt is crypto-grade.
export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function codeExpiryFrom(now = Date.now()): string {
  return new Date(now + CODE_TTL_MS).toISOString();
}

// Constant-time compare of two same-length strings; false on length mismatch.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// A code is valid only if it matches the stored code exactly AND that code has
// not expired. Missing code/expiry (already consumed) is invalid.
export function isCodeValid(
  signup: Pick<DemoSignup, "code" | "codeExpiresAt">,
  submitted: string,
  now = Date.now(),
): boolean {
  if (!signup.code || !signup.codeExpiresAt) return false;
  if (!safeEqual(signup.code, submitted.trim())) return false;
  const expiresAt = Date.parse(signup.codeExpiresAt);
  if (Number.isNaN(expiresAt) || expiresAt < now) return false;
  return true;
}

// True once the email has consumed all of its free sessions. `email` is
// optional so existing call sites keep working; pass it whenever available so
// allowlisted emails (see isUnlimitedDemoEmail) are never capped.
export function isSessionLimitReached(sessionsUsed: number, email?: string): boolean {
  if (email && isUnlimitedDemoEmail(email)) return false;
  return sessionsUsed >= MAX_DEMO_SESSIONS;
}

export function remainingSessions(sessionsUsed: number, email?: string): number {
  if (email && isUnlimitedDemoEmail(email)) return Infinity;
  return Math.max(0, MAX_DEMO_SESSIONS - sessionsUsed);
}

// --- Signed demo access token (mirrors the admin HMAC session token) --------
type DemoTokenPayload = { email: string; exp: number };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signDemoToken(email: string, now = Date.now()): string {
  const payload: DemoTokenPayload = { email: normalizeEmail(email), exp: now + DEMO_TOKEN_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", demoSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyDemoToken(token: string | undefined, now = Date.now()): DemoTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", demoSecret()).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as DemoTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    if (typeof payload.email !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

// The signup-intent question shown in the post-demo CTA. Per the product spec
// the user-facing wording says "users"/"consultants" (or "users"/"managers" in
// the leadership context) even though the database and billing still say
// "seats". `track` is the demo scenario's track.
export function ctaSeatQuestion(track: string = "consulting"): string {
  const roleWord = track === "leadership" ? "managers" : "consultants";
  return `How many users or ${roleWord} do you want on your team?`;
}

// Verification email content. Reuses the existing Resend transport in
// server/notifications.ts — this only builds the subject/html.
export function buildVerificationEmail(code: string): { subject: string; html: string } {
  const subject = `Your SOLVE Framework demo code: ${code}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;">
  <h2 style="margin:0 0 12px;">Your free voice demo code</h2>
  <p style="margin:0 0 16px;">Enter this code to start your free live voice roleplay:</p>
  <p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:0 0 16px;">${code}</p>
  <p style="margin:0;color:#555;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
</div>`;
  return { subject, html };
}
