import type { User } from "@shared/schema";

// ---------------------------------------------------------------------------
// Hard-delete authority for `users`. Deleting a user is guarded and cascading:
//   - Guard: a "paying" user (a real paid seat) can NEVER be hard-deleted; and
//     the last remaining manager of an office can never be deleted (that would
//     orphan the office with no manager). Both are surfaced as a clear,
//     frontend-showable reason.
//   - Cascade: a deletable (non-paying/test) user's dependent rows are removed
//     in a foreign-key-safe order inside one transaction, then the user row last.
// The concrete DB writes are injected (see storage.deleteUser) so the ordering
// and guard logic stay dependency-free and unit-testable.
// ---------------------------------------------------------------------------

// Raised when a user is not eligible for hard delete. `reason` is safe to show
// to the admin verbatim. The route maps it to a 409.
export class UserDeleteBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "UserDeleteBlockedError";
  }
}

// "Paying" reuses the countPaidSeats definition EXACTLY (server/storage.ts):
// a real paid seat is seatActive AND not a demo/QA account. Demo accounts carry
// seatActive=true but never occupy a paid seat, so they stay deletable test
// accounts rather than being treated as paying customers.
export function userIsPaying(user: Pick<User, "seatActive" | "isDemoAccount">): boolean {
  return user.seatActive === true && user.isDemoAccount === false;
}

// Decide whether a user may be hard-deleted. Pure: the caller passes the office
// manager headcount. `otherManagerCount` is the number of OTHER managers in the
// same office (excluding this user).
export function checkUserDeletable(
  user: Pick<User, "role" | "seatActive" | "isDemoAccount">,
  opts: { otherManagerCount: number },
): { ok: true } | { ok: false; reason: string } {
  if (userIsPaying(user)) {
    return {
      ok: false,
      reason:
        "This user has an active paid seat and cannot be deleted. Downgrade or archive their office instead.",
    };
  }
  if (user.role === "manager" && opts.otherManagerCount === 0) {
    return {
      ok: false,
      reason: "This is the only manager for their office. Reassign or delete the office first.",
    };
  }
  return { ok: true };
}

// FK-safe cascade steps for one user. Every dependent table that references
// users.id is cleared before the user row itself. real_conversations references
// the user through TWO columns (submittedByUserId + subjectRepUserId), so its
// step must clear rows matching EITHER. monthly_lifecycle_emails is polymorphic:
// only rows whose recipientType marks a paying user AND whose recipientId equals
// this user id are removed (so a demo_signup row that happens to share the id is
// never touched).
export interface UserCascade {
  deleteCoachingMessages(userId: number): Promise<void>;
  deleteCertificationAttempts(userId: number): Promise<void>;
  deleteIndustryCertifications(userId: number): Promise<void>;
  deleteAcademyCredits(userId: number): Promise<void>;
  deleteRealConversations(userId: number): Promise<void>;
  deleteMonthlyLifecycleEmails(userId: number): Promise<void>;
  deleteSessions(userId: number): Promise<void>;
  deleteUserRow(userId: number): Promise<void>;
}

export async function runUserCascade(userId: number, ops: UserCascade): Promise<void> {
  await ops.deleteCoachingMessages(userId);
  await ops.deleteCertificationAttempts(userId);
  await ops.deleteIndustryCertifications(userId);
  await ops.deleteAcademyCredits(userId);
  await ops.deleteRealConversations(userId);
  await ops.deleteMonthlyLifecycleEmails(userId);
  await ops.deleteSessions(userId);
  await ops.deleteUserRow(userId);
}
