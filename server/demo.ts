import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import type { DemoSignup, InsertDemoSignup, DemoSession } from "@shared/schema";

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

// Minimal storage surface healUnlimitedDemoUsage needs. Declared here (rather
// than importing the concrete storage) so the heal is trivially unit-testable
// with a fake, and so demo.ts stays free of a DB dependency.
export interface DemoUsageStore {
  listDemoSignups(): Promise<DemoSignup[]>;
  updateDemoSignup(id: number, patch: Partial<InsertDemoSignup>): Promise<DemoSignup | undefined>;
}

// Reset the persisted `sessionsUsed` counter to 0 for every allowlisted
// (unlimited) email whose row still shows usage. The runtime cap check
// (isSessionLimitReached) already exempts these emails, but a row created
// BEFORE the email was allowlisted keeps its stale sessionsUsed >= MAX. That is
// misleading in the admin export and leaves the account brittle to any code
// path that reads the raw count. Running this on boot heals such rows on the
// next deploy with no manual SQL. Idempotent: only touches rows that need it.
// Returns the list of emails it reset (for logging/tests).
export async function healUnlimitedDemoUsage(store: DemoUsageStore): Promise<string[]> {
  const signups = await store.listDemoSignups();
  const reset: string[] = [];
  for (const signup of signups) {
    if (signup.sessionsUsed > 0 && isUnlimitedDemoEmail(signup.email)) {
      await store.updateDemoSignup(signup.id, { sessionsUsed: 0 });
      reset.push(signup.email);
    }
  }
  return reset;
}

// A freshly-emailed code is valid for this long before it must be re-sent.
export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// After verifying, this signed token IS the demo's auth for the roleplay calls
// (no login). Kept short-lived; a visitor re-verifies if they let it lapse.
const DEMO_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// The real-estate demo scenario. Seeded by server/seed.ts (active:false so it
// never shows in the trainee picker; the demo reaches it by slug only).
export const DEMO_SCENARIO_SLUG = "real-estate-demo-buyer-30-days";

// Industry options a visitor can pick from before starting the free demo. Each
// maps to an existing seeded scenario (reused as-is — no new content). All are
// consulting-track discovery conversations, so downstream wording/scoring is
// identical regardless of choice. Automotive is first and the default.
export type DemoScenarioOption = { key: string; label: string; blurb: string; slug: string };
export const DEMO_SCENARIO_OPTIONS: DemoScenarioOption[] = [
  {
    key: "auto",
    label: "Automotive Sales / F&I",
    blurb: "A car buyer whose real priorities sit beneath the features they open with.",
    slug: "auto-sales-tech-worker-upgrade",
  },
  {
    key: "real_estate",
    label: "Real Estate",
    blurb: "A motivated home buyer who needs to purchase within the next 30 days.",
    slug: DEMO_SCENARIO_SLUG,
  },
];
export const DEFAULT_DEMO_SCENARIO_KEY = "auto";

// Resolve a visitor's chosen option key to a scenario slug. Unknown/missing keys
// fall back to the default (automotive) so the demo always starts.
export function demoScenarioSlugForKey(key: string | undefined | null): string {
  const opt = DEMO_SCENARIO_OPTIONS.find((o) => o.key === key);
  if (opt) return opt.slug;
  return DEMO_SCENARIO_OPTIONS.find((o) => o.key === DEFAULT_DEMO_SCENARIO_KEY)!.slug;
}

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

// ---------------------------------------------------------------------------
// Multi-layer abuse protection. These caps sit BEHIND the marketed "3 free
// sessions per email" promise and only ever surface when someone exceeds fair
// use (a new email on an already-used device, or many emails from one IP). The
// legitimate first-time flow never sees them. Every cap is bypassed for
// allowlisted (founder) emails via isUnlimitedDemoEmail so live sales demos are
// never locked out. All logic here is pure so it can be unit-tested directly.
// ---------------------------------------------------------------------------

// A single device gets this many free sessions total, regardless of how many
// different emails are used from it. Same number as the per-email cap: a new
// email on an already-capped device does not reset the count.
export const MAX_DEMO_SESSIONS_PER_DEVICE = 3;

// A single IP address gets this many free sessions in any rolling 30-day window.
// Higher than the per-device cap so a shared office/household NAT is not caught
// by ordinary legitimate use, but low enough to stop scripted email churn.
export const MAX_DEMO_SESSIONS_PER_IP = 6;

// The rolling window for the per-IP cap. Must survive restarts/deploys, which is
// why the IP counter is derived from durable demo_sessions rows, not the
// in-memory RateLimiter.
export const IP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// True once a device fingerprint has consumed all of its free sessions. A
// missing/blocked fingerprint (count derived as 0) never trips this on its own.
export function isDeviceLimitReached(deviceSessionCount: number, email?: string): boolean {
  if (email && isUnlimitedDemoEmail(email)) return false;
  return deviceSessionCount >= MAX_DEMO_SESSIONS_PER_DEVICE;
}

// True once an IP has consumed all of its free sessions inside the rolling
// window. `ipSessionCountInWindow` is the count already filtered to the window
// (see countDemoSessionsInIpWindow).
export function isIpLimitReached(ipSessionCountInWindow: number, email?: string): boolean {
  if (email && isUnlimitedDemoEmail(email)) return false;
  return ipSessionCountInWindow >= MAX_DEMO_SESSIONS_PER_IP;
}

// Count how many of the given sessions fall inside the rolling 30-day IP window
// ending at `now`. A session created exactly IP_WINDOW_MS ago (or older) is
// OUTSIDE the window and does not count, so a session from 31 days ago never
// blocks a fresh one. Unparseable timestamps are ignored (treated as outside).
export function countDemoSessionsInIpWindow(
  sessions: Pick<DemoSession, "createdAt">[],
  now = Date.now(),
): number {
  const cutoff = now - IP_WINDOW_MS;
  let count = 0;
  for (const s of sessions) {
    const t = Date.parse(s.createdAt);
    if (!Number.isNaN(t) && t > cutoff) count += 1;
  }
  return count;
}

// Admin abuse-protection analytics, derived purely from durable demo_sessions
// rows so the view survives restarts. Kept pure (no DB) for direct unit testing.
// A "blocked" device/IP is one that has reached its cap, i.e. any further email
// from it would be turned away at session start. `emails` is the count of
// distinct emails seen from that device/IP (the abuse signal the ticket asks
// for: how many emails one device or IP churned through).
export type DemoAbuseAnalytics = {
  totalSessions: number;
  uniqueDevices: number;
  sessionsPerDay: { date: string; count: number }[];
  blockedDevices: { fingerprint: string; sessions: number; emails: number; lastAt: string }[];
  blockedIps: { ip: string; sessions: number; emails: number; lastAt: string }[];
};

type AnalyticsSession = Pick<DemoSession, "createdAt" | "deviceFingerprint" | "ipAddress" | "email">;

export function demoAbuseAnalytics(
  sessions: AnalyticsSession[],
  now = Date.now(),
): DemoAbuseAnalytics {
  const perDay = new Map<string, number>();
  const deviceSessions = new Map<string, AnalyticsSession[]>();
  const ipSessions = new Map<string, AnalyticsSession[]>();
  const deviceSet = new Set<string>();

  for (const s of sessions) {
    const day = (s.createdAt ?? "").slice(0, 10);
    if (day) perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (s.deviceFingerprint) {
      deviceSet.add(s.deviceFingerprint);
      const list = deviceSessions.get(s.deviceFingerprint) ?? [];
      list.push(s);
      deviceSessions.set(s.deviceFingerprint, list);
    }
    if (s.ipAddress) {
      const list = ipSessions.get(s.ipAddress) ?? [];
      list.push(s);
      ipSessions.set(s.ipAddress, list);
    }
  }

  const sessionsPerDay = Array.from(perDay.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const lastAtOf = (rows: AnalyticsSession[]): string =>
    rows.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), "");
  const emailsOf = (rows: AnalyticsSession[]): number =>
    new Set(rows.map((r) => r.email)).size;

  const blockedDevices = Array.from(deviceSessions.entries())
    .filter(([, rows]) => rows.length >= MAX_DEMO_SESSIONS_PER_DEVICE)
    .map(([fingerprint, rows]) => ({
      fingerprint,
      sessions: rows.length,
      emails: emailsOf(rows),
      lastAt: lastAtOf(rows),
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const blockedIps = Array.from(ipSessions.entries())
    .filter(([, rows]) => countDemoSessionsInIpWindow(rows, now) >= MAX_DEMO_SESSIONS_PER_IP)
    .map(([ip, rows]) => ({
      ip,
      sessions: countDemoSessionsInIpWindow(rows, now),
      emails: emailsOf(rows),
      lastAt: lastAtOf(rows),
    }))
    .sort((a, b) => b.sessions - a.sessions);

  return {
    totalSessions: sessions.length,
    uniqueDevices: deviceSet.size,
    sessionsPerDay,
    blockedDevices,
    blockedIps,
  };
}

// Voice (server-side TTS) is unlocked only on the third free session for cost
// containment; the first two default to text mode. Allowlisted founder emails
// always get voice so live sales demos are never text-only. `sessionNumber` is
// the session's 1-based ordinal for the email.
export function isVoiceUnlockedForDemo(sessionNumber: number, email?: string): boolean {
  if (email && isUnlimitedDemoEmail(email)) return true;
  return sessionNumber >= MAX_DEMO_SESSIONS;
}

// Disposable/temporary email domains (mailinator, 10minutemail, guerrillamail,
// and ~120k more) come from the maintained open-source `disposable-email-domains`
// package so the list updates independently of this code. Loaded once via a
// runtime require (the package ships a JSON array) into a Set for O(1) lookups.
const require = createRequire(import.meta.url);
const DISPOSABLE_DOMAINS: Set<string> = new Set(
  (require("disposable-email-domains") as string[]).map((d) => d.toLowerCase()),
);

// True if the email's domain is a known disposable/temporary provider. Checked
// at signup so a throwaway address is rejected before any code is sent.
export function isDisposableEmail(email: string): boolean {
  const at = normalizeEmail(email).lastIndexOf("@");
  if (at === -1) return false;
  const domain = normalizeEmail(email).slice(at + 1);
  return DISPOSABLE_DOMAINS.has(domain);
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
