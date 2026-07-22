import type { IStorage } from "./storage";
import type { DemoSignup, User } from "@shared/schema";
import { sendInboundEmail } from "./notifications";
import { inboundBodyToHtml } from "./opportunities";
import { unsubscribeFooter, normalizeUnsubEmail } from "./unsubscribe";

// ===========================================================================
// Monthly "Practice makes money!" lifecycle email.
//
// Two segments, one table (monthly_lifecycle_emails):
//   - Unconverted demo users (verified demo_signups with no matching seat-active
//     paying account) get a conversion nudge.
//   - Paying seat-active users get a retention/engagement nudge.
//
// Self-perpetuating: each eligible recipient with no existing row is seeded with
// a scheduled row due now; after a row sends, the next month's row is enqueued
// (~30 days out) IF the recipient is still eligible and not suppressed. The
// shared background sender delivers due rows. Idempotent send-and-mark contract,
// identical to the drips. Suppressed recipients are skipped (marked `stopped`).
//
// Note on addressing: `users` has no email column; the login `username` is the
// address for self-serve paid accounts, so paying-user sends target usernames
// that look like an email. This also backs the demo->paying "already converted"
// match (case-insensitive username vs demo_signups.email). Both are documented
// assumptions, not new schema.
//
// Copy rules (enforced by tests): "practice" not "train"/"training"; no
// em-dashes; navy/orange only. Every email carries the unsubscribe footer.
// ===========================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
export const MONTHLY_INTERVAL_DAYS = 30;

const GET_STARTED_URL = "https://www.solveframework.com";
const DEMO_URL = "https://www.solveframework.com/demo";

export const MONTHLY_SUBJECT = "Practice makes money!";

export const RECIPIENT_TYPE_DEMO = "demo_signup" as const;
export const RECIPIENT_TYPE_PAYING = "paying_user" as const;

const MONTHLY_STATUS_SCHEDULED = "scheduled" as const;
const MONTHLY_STATUS_SENT = "sent" as const;
const MONTHLY_STATUS_STOPPED = "stopped" as const;

// A minimal email shape check: enough to avoid emailing admin-created consultant
// usernames that are not addresses. Not a validator, just a guard.
export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

// The normalized addresses of every seat-active, non-demo paying user whose
// username is an email. Used both to send to payers and to detect which demo
// signups have already converted.
export function payingUserEmails(users: Pick<User, "username" | "seatActive" | "isDemoAccount">[]): Set<string> {
  const set = new Set<string>();
  for (const u of users) {
    if (u.seatActive && !u.isDemoAccount && looksLikeEmail(u.username)) {
      set.add(normalizeUnsubEmail(u.username));
    }
  }
  return set;
}

// A verified demo signup that has NOT converted to a paying seat and has not
// opted out via the demo mirror flag.
export function isUnconvertedDemo(
  signup: Pick<DemoSignup, "email" | "verified" | "unsubscribed">,
  payingEmails: Set<string>,
): boolean {
  if (!signup.verified || signup.unsubscribed) return false;
  return !payingEmails.has(normalizeUnsubEmail(signup.email));
}

// Conversion nudge for an unconverted demo user.
export function buildMonthlyDemoBody(email: string): string {
  const body = `Practice makes money.

That is not a slogan. The professionals who keep the most deals alive are the ones who keep practicing the conversation before it happens for real.

You tried the SOLVE Framework demo, and your free practice sessions showed you how it works: real conversations, scored by your SOLVE Coach, with feedback on exactly where trust was won or lost.

A full account removes the three-session cap and gives you the complete scenario library, so you can practice the exact conversations your role runs into, as often as you want.

Get Started: ${GET_STARTED_URL}

Or run another free practice session first: ${DEMO_URL}`;
  return body + unsubscribeFooter(email, "You are getting this because you started a SOLVE Framework demo.");
}

// Retention/engagement nudge for a paying seat-active user.
export function buildMonthlyPayingBody(email: string): string {
  const body = `Practice makes money.

The reps who improve fastest are not the ones with the most talent. They are the ones who practice a little every month, so the hard conversations feel familiar before they happen.

This is your monthly nudge to run a session or two. Pick a conversation you have been avoiding, talk through it, and let your SOLVE Coach show you one thing to sharpen. That one thing compounds.

Jump back in: ${GET_STARTED_URL}`;
  return body + unsubscribeFooter(email, "You are getting this because you have a SOLVE Framework account.");
}

export function buildMonthlyBody(recipientType: string, email: string): string {
  return recipientType === RECIPIENT_TYPE_PAYING ? buildMonthlyPayingBody(email) : buildMonthlyDemoBody(email);
}

export interface MonthlySeedDeps {
  storage: Pick<
    IStorage,
    "listDemoSignups" | "listUsers" | "listMonthlyLifecycleEmails" | "getEmailSuppression" | "createMonthlyLifecycleEmail"
  >;
  now?: () => Date;
}

// Seed a scheduled row (due now) for every currently eligible recipient that has
// no monthly row yet. Once a recipient has any row, self-perpetuation keeps the
// cycle going, so this only ever enrolls NEW eligible recipients. Suppressed
// recipients are never seeded. Never throws. Returns the number seeded.
export async function seedMonthlyLifecycleEmails(deps: MonthlySeedDeps): Promise<{ seeded: number }> {
  let seeded = 0;
  try {
    const now = deps.now ? deps.now() : new Date();
    const nowIso = now.toISOString();

    const [signups, users, existing] = await Promise.all([
      deps.storage.listDemoSignups(),
      deps.storage.listUsers(),
      deps.storage.listMonthlyLifecycleEmails(),
    ]);

    const seen = new Set<string>();
    for (const row of existing) seen.add(`${row.recipientType}:${row.recipientId}`);

    const payers = payingUserEmails(users);

    for (const u of users) {
      if (!(u.seatActive && !u.isDemoAccount && looksLikeEmail(u.username))) continue;
      const key = `${RECIPIENT_TYPE_PAYING}:${u.id}`;
      if (seen.has(key)) continue;
      const email = normalizeUnsubEmail(u.username);
      if (await deps.storage.getEmailSuppression(email)) continue;
      await deps.storage.createMonthlyLifecycleEmail({
        recipientType: RECIPIENT_TYPE_PAYING,
        recipientId: u.id,
        email,
        emailSubject: MONTHLY_SUBJECT,
        emailBody: buildMonthlyPayingBody(email),
        scheduledAt: nowIso,
        sentAt: null,
        status: MONTHLY_STATUS_SCHEDULED,
      });
      seen.add(key);
      seeded += 1;
    }

    for (const s of signups) {
      if (!isUnconvertedDemo(s, payers)) continue;
      const key = `${RECIPIENT_TYPE_DEMO}:${s.id}`;
      if (seen.has(key)) continue;
      const email = normalizeUnsubEmail(s.email);
      if (await deps.storage.getEmailSuppression(email)) continue;
      await deps.storage.createMonthlyLifecycleEmail({
        recipientType: RECIPIENT_TYPE_DEMO,
        recipientId: s.id,
        email,
        emailSubject: MONTHLY_SUBJECT,
        emailBody: buildMonthlyDemoBody(email),
        scheduledAt: nowIso,
        sentAt: null,
        status: MONTHLY_STATUS_SCHEDULED,
      });
      seen.add(key);
      seeded += 1;
    }
  } catch (err) {
    console.warn("[monthlyEmail] Failed to seed monthly lifecycle emails:", err);
  }
  return { seeded };
}

export interface MonthlySendDeps {
  storage: Pick<
    IStorage,
    | "listDueMonthlyLifecycleEmails"
    | "getEmailSuppression"
    | "updateMonthlyLifecycleEmail"
    | "createMonthlyLifecycleEmail"
    | "listDemoSignups"
    | "listUsers"
  >;
  send: typeof sendInboundEmail;
  now?: () => Date;
}

// Send every scheduled monthly row whose scheduledAt has passed. Idempotent:
// only `scheduled` rows are fetched and flipped to `sent` only on a real 2xx, so
// a failed send stays scheduled for the next tick. Suppressed recipients are
// marked `stopped`. After a successful send, the next month's row (+30d) is
// enqueued IF the recipient is still eligible and not suppressed, making the
// series self-perpetuating. Never throws. Returns counts for logging/tests.
export async function sendDueMonthlyEmails(deps: MonthlySendDeps): Promise<{ sent: number; failed: number; stopped: number }> {
  const now = deps.now ? deps.now() : new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const due = await deps.storage.listDueMonthlyLifecycleEmails(nowIso);
  let sent = 0;
  let failed = 0;
  let stopped = 0;

  // Eligibility for the NEXT enqueue is rechecked against current data, loaded
  // once per tick.
  let payers: Set<string> | null = null;
  let demoEligible: Set<number> | null = null;
  let payingEligible: Set<number> | null = null;
  const loadEligibility = async () => {
    if (payers) return;
    const [signups, users] = await Promise.all([deps.storage.listDemoSignups(), deps.storage.listUsers()]);
    payers = payingUserEmails(users);
    demoEligible = new Set(signups.filter((s) => isUnconvertedDemo(s, payers!)).map((s) => s.id));
    payingEligible = new Set(
      users.filter((u) => u.seatActive && !u.isDemoAccount && looksLikeEmail(u.username)).map((u) => u.id),
    );
  };

  for (const row of due) {
    const suppressed = await deps.storage.getEmailSuppression(normalizeUnsubEmail(row.email));
    if (suppressed) {
      await deps.storage.updateMonthlyLifecycleEmail(row.id, { status: MONTHLY_STATUS_STOPPED });
      stopped += 1;
      continue;
    }

    const ok = await deps.send(row.email, row.emailSubject, inboundBodyToHtml(row.emailBody), row.emailBody);
    if (!ok) {
      failed += 1;
      continue; // stays `scheduled`; retried next tick
    }
    await deps.storage.updateMonthlyLifecycleEmail(row.id, { status: MONTHLY_STATUS_SENT, sentAt: nowIso });
    sent += 1;

    // Self-perpetuate: enqueue next month if still eligible.
    await loadEligibility();
    const stillEligible =
      row.recipientType === RECIPIENT_TYPE_PAYING
        ? payingEligible!.has(row.recipientId)
        : demoEligible!.has(row.recipientId);
    if (stillEligible) {
      await deps.storage.createMonthlyLifecycleEmail({
        recipientType: row.recipientType,
        recipientId: row.recipientId,
        email: row.email,
        emailSubject: MONTHLY_SUBJECT,
        emailBody: buildMonthlyBody(row.recipientType, row.email),
        scheduledAt: new Date(nowMs + MONTHLY_INTERVAL_DAYS * DAY_MS).toISOString(),
        sentAt: null,
        status: MONTHLY_STATUS_SCHEDULED,
      });
    }
  }
  return { sent, failed, stopped };
}
