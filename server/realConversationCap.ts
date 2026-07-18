// Real Conversation fair-use cap (Phase 3). Each rep seat gets a fixed number of
// real-conversation submissions per calendar month. This is a HARD block: once a
// rep reaches the cap, no further submissions are accepted (whether the rep
// submits for themselves or a manager submits on their behalf) until the counter
// resets on the first of the next month. Unused submissions never roll over.
//
// The cap is keyed on the SUBJECT rep (real_conversations.subject_rep_user_id),
// not the submitter, since the seat being consumed is the rep's. A submission is
// counted the moment it is created (submission_counted_for_cap = true) and is
// never recalculated after the fact, so the historical count is stable even if
// what "counts" changes in a later phase.
//
// Reuses the same whole-UTC-month boundary math as the practice cap (monthBounds
// in ./fairUse) so both caps agree on when a month starts and resets.

import type { RealConversation } from "@shared/schema";
import { monthBounds, resetDate, formatResetDateUtc } from "./fairUse";

// 20 real-conversation submissions per rep seat per calendar month.
export const REAL_CONVERSATION_MONTHLY_CAP = 20;

// Count a rep's real-conversation submissions that counted toward the cap in the
// calendar month containing `now`. Only rows explicitly flagged
// submissionCountedForCap === true are tallied, and each is attributed to the
// month it was CREATED in, so a submission in one month never leaks into another.
export function countMonthlyCountedSubmissions(
  rows: Pick<RealConversation, "createdAt" | "submissionCountedForCap">[],
  now: Date,
): number {
  const { start, nextStart } = monthBounds(now);
  let count = 0;
  for (const r of rows) {
    if (r.submissionCountedForCap !== true) continue;
    const created = new Date(r.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    if (created >= start && created < nextStart) count += 1;
  }
  return count;
}

export type RealConversationCapStatus = {
  count: number;
  limit: number;
  remaining: number;
  // At or past the cap: new submissions must be refused.
  blocked: boolean;
  // ISO first-of-next-month; when the counter resets.
  resetDate: string;
};

// Evaluate a rep's current standing against the monthly submission cap. Pass the
// rep's OWN real-conversation rows (subject_rep_user_id == the rep). There is no
// demo/founder bypass here: the cap protects a shared scoring resource and applies
// to every seat, matching the standing product decision.
export function evaluateRealConversationCap(args: {
  rows: Pick<RealConversation, "createdAt" | "submissionCountedForCap">[];
  now: Date;
}): RealConversationCapStatus {
  const { rows, now } = args;
  const count = countMonthlyCountedSubmissions(rows, now);
  const remaining = Math.max(0, REAL_CONVERSATION_MONTHLY_CAP - count);
  return {
    count,
    limit: REAL_CONVERSATION_MONTHLY_CAP,
    remaining,
    blocked: count >= REAL_CONVERSATION_MONTHLY_CAP,
    resetDate: resetDate(now),
  };
}

// The user-facing message shown when a submission is blocked by the cap. No em
// dashes, "discovery"/"real conversation" language (never "sales"), and it names
// the concrete reset date so the rep knows when submissions become available
// again. Phrased to read correctly whether the rep or their manager triggered it.
export function realConversationCapBlockedMessage(isoResetDate: string): string {
  return `This rep has reached the ${REAL_CONVERSATION_MONTHLY_CAP} real-conversation submissions for this month. Submissions reset on ${formatResetDateUtc(
    isoResetDate,
  )}.`;
}
