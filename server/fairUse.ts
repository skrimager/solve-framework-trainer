// Fair-use practice cap. Every consultant seat gets a fixed amount of practice
// time per calendar month (text and voice sessions count equally). At the warn
// threshold the app shows a friendly heads-up; at the cap it stops new sessions
// from starting until the counter resets on the first of the next month. Unused
// time never rolls over: the total is summed from time-bounded, per-month
// queries, so hours used in one month never count against the next.
//
// Demo/founder accounts (users.isDemoAccount) bypass the cap entirely, following
// the same permanently-free convention used for seat billing (see
// checkSeatAccess in server/routes.ts).

import type { Session } from "@shared/schema";

// 10 hours/month hard cap, with a friendly warning once 9 hours are used. Kept
// in seconds so partial-session durations compare exactly against the threshold.
export const MONTHLY_CAP_MINUTES = 10 * 60; // 600
export const WARN_THRESHOLD_MINUTES = 9 * 60; // 540
export const MONTHLY_CAP_SECONDS = MONTHLY_CAP_MINUTES * 60; // 36000
export const WARN_THRESHOLD_SECONDS = WARN_THRESHOLD_MINUTES * 60; // 32400

// Whole-UTC-month bounds [start, nextStart) for the month containing `now`.
// createdAt timestamps are ISO strings, so string/Date comparison against these
// bounds is exact and needs no timezone gymnastics.
export function monthBounds(now: Date): { start: Date; nextStart: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const nextStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, nextStart };
}

// The reset date: first instant of the next calendar month (UTC). Returned as an
// ISO string so the client can format it in the user's local time.
export function resetDate(now: Date): string {
  return monthBounds(now).nextStart.toISOString();
}

// Sum practice seconds a user consumed in the calendar month containing `now`.
// Only sessions that have ended (durationSeconds set) count, and each is
// attributed to the month it was CREATED in, so a June session never leaks into
// July's total. In-progress sessions (null duration) contribute nothing yet.
export function sumMonthlyPracticeSeconds(sessions: Session[], now: Date): number {
  const { start, nextStart } = monthBounds(now);
  let total = 0;
  for (const s of sessions) {
    if (s.durationSeconds == null) continue;
    const created = new Date(s.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    if (created >= start && created < nextStart) {
      total += s.durationSeconds;
    }
  }
  return total;
}

export type PracticeCapStatus = {
  // True for demo/founder accounts: cap never applies, never warns, never blocks.
  bypassed: boolean;
  minutesUsed: number;
  limitMinutes: number;
  warnMinutes: number;
  minutesRemaining: number;
  // At or past the warn threshold but under the cap.
  warning: boolean;
  // At or past the cap: new sessions must be refused.
  blocked: boolean;
  // ISO first-of-next-month; when the counter resets.
  resetDate: string;
};

// Evaluate a user's current standing against the monthly cap. `isDemoAccount`
// short-circuits to a permanently-clear status so founder/demo seats are never
// warned or blocked.
export function evaluatePracticeCap(args: {
  sessions: Session[];
  now: Date;
  isDemoAccount: boolean;
}): PracticeCapStatus {
  const { sessions, now, isDemoAccount } = args;
  const reset = resetDate(now);

  if (isDemoAccount) {
    return {
      bypassed: true,
      minutesUsed: 0,
      limitMinutes: MONTHLY_CAP_MINUTES,
      warnMinutes: WARN_THRESHOLD_MINUTES,
      minutesRemaining: MONTHLY_CAP_MINUTES,
      warning: false,
      blocked: false,
      resetDate: reset,
    };
  }

  const usedSeconds = sumMonthlyPracticeSeconds(sessions, now);
  const minutesUsed = Math.floor(usedSeconds / 60);
  const minutesRemaining = Math.max(0, MONTHLY_CAP_MINUTES - minutesUsed);
  const blocked = usedSeconds >= MONTHLY_CAP_SECONDS;
  const warning = !blocked && usedSeconds >= WARN_THRESHOLD_SECONDS;

  return {
    bypassed: false,
    minutesUsed,
    limitMinutes: MONTHLY_CAP_MINUTES,
    warnMinutes: WARN_THRESHOLD_MINUTES,
    minutesRemaining,
    warning,
    blocked,
    resetDate: reset,
  };
}

// A human-readable UTC reset date for the server-side blocked message (e.g.
// "August 1, 2026"). The client formats the ISO resetDate into local time for
// display; this string is the plain-text fallback carried in the error message.
export function formatResetDateUtc(isoResetDate: string): string {
  const d = new Date(isoResetDate);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// The friendly, user-facing message shown when a new session is blocked. No em
// dashes, "practice" (not "train") as the verb, navy/orange UI handled client
// side.
export function blockedMessage(isoResetDate: string): string {
  return `You've reached your 10 hours of practice time for this month. Your practice time resets on ${formatResetDateUtc(
    isoResetDate,
  )}. Thanks for putting in the reps.`;
}

// Seconds of practice time between a session's start and its end. Never negative
// (clock skew or out-of-order timestamps floor to 0).
export function computeDurationSeconds(createdAtIso: string, endIso: string): number {
  const start = new Date(createdAtIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}
