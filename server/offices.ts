import type { Office, User } from "@shared/schema";
import { officeIsActive } from "./billing";
import { userIsPaying } from "./users";

// ---------------------------------------------------------------------------
// Delete/archive authority for `offices` (the data behind the Vault "Sales"
// rollup). The core rule: a REAL PAYING CUSTOMER office can never be hard
// deleted, only archived. "Real paying customer" reuses the exact signals the
// codebase already uses elsewhere:
//   - officeIsActive(office) (server/billing.ts): subscriptionStatus in
//     {active, trialing}, the same check the Sales rollup (computeSalesRow)
//     uses for `active`. Combined with a live stripeSubscriptionId reference so
//     a free/demo office (active status, no Stripe subscription) is NOT treated
//     as paying.
//   - userIsPaying (server/users.ts): a seatActive, non-demo user, the exact
//     countPaidSeats definition of a real paid seat.
// Only offices with NO paying signal (test/trial/no-signal) may be hard-deleted,
// cascading through their dependent rows (including their non-paying test users).
// ---------------------------------------------------------------------------

// Raised when a hard delete is attempted on a paying-customer office. `reason`
// is safe to show to the admin verbatim. The route maps it to a 409.
export class OfficeDeleteBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "OfficeDeleteBlockedError";
  }
}

// A live Stripe subscription reference: the office both carries a subscription
// id AND is in a paid-up Stripe status. A canceled/incomplete office keeps its
// old id but is not live, so it is not a paying signal on its own.
export function officeHasLiveStripeSubscription(
  office: Pick<Office, "subscriptionStatus" | "stripeSubscriptionId">,
): boolean {
  return Boolean(office.stripeSubscriptionId) && officeIsActive(office);
}

// True when the office is a real paying customer and must be archive-only.
// Paying = any real paid-seat user OR a live Stripe subscription reference.
export function officeIsPayingCustomer(
  office: Pick<Office, "subscriptionStatus" | "stripeSubscriptionId">,
  users: Pick<User, "seatActive" | "isDemoAccount">[],
): boolean {
  return users.some(userIsPaying) || officeHasLiveStripeSubscription(office);
}

// Which archived state to include in the Sales list. Defaults to "active" so
// archived offices are hidden from the normal view but reachable via "archived".
export const OFFICE_ARCHIVE_VIEWS = ["active", "archived", "all"] as const;
export type OfficeArchiveView = (typeof OFFICE_ARCHIVE_VIEWS)[number];

export function filterOfficesByArchive<T extends { archivedAt: string | null }>(
  offices: T[],
  view: OfficeArchiveView,
): T[] {
  return offices.filter((o) => {
    if (view === "active") return !o.archivedAt;
    if (view === "archived") return Boolean(o.archivedAt);
    return true;
  });
}

// FK-safe cascade steps for hard-deleting a (non-paying) office. Its test users
// are deleted first (each through the full user cascade), which clears the
// DB-enforced users.officeId FK and every user-level dependent row. Remaining
// office-scoped rows are then cleared (academy_credits/real_conversations,
// already emptied by the user cascade in practice, but the office-keyed sweep
// keeps it correct even for any denormalized leftovers) and the nullable
// paid_office_signups / billing_events references are detached (nulled) so those
// audit rows survive. The office row itself is removed last.
export interface OfficeCascade {
  deleteUsers(officeId: number): Promise<void>;
  deleteAcademyCredits(officeId: number): Promise<void>;
  deleteRealConversations(officeId: number): Promise<void>;
  detachPaidOfficeSignups(officeId: number): Promise<void>;
  detachBillingEvents(officeId: number): Promise<void>;
  deleteOfficeRow(officeId: number): Promise<void>;
}

export async function runOfficeCascade(officeId: number, ops: OfficeCascade): Promise<void> {
  await ops.deleteUsers(officeId);
  await ops.deleteAcademyCredits(officeId);
  await ops.deleteRealConversations(officeId);
  await ops.detachPaidOfficeSignups(officeId);
  await ops.detachBillingEvents(officeId);
  await ops.deleteOfficeRow(officeId);
}
