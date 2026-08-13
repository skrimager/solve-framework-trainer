// One-off, idempotent backfill: creates a `contacts` row for each of the 6
// already-verified demo signups that predate the auto-create-Contact-on-verify
// behavior added alongside this script (see server/routes.ts POST
// /api/demo/verify + enrollDemoVoiceContact in server/contacts.ts). Without
// this, these real leads verified their demo code and got the activation
// drip, but never showed up in the admin Contacts tab for manual follow-up.
//
// The list below is the exact, already-confirmed set of demo_signups rows
// with ZERO existing contact row (verified against production data -- do not
// re-derive or expand it):
//   - id 11, shane9399@gmail.com
//   - id 10, jacquelyn.foland@outlook.com
//   - id 9,  wskrimager@gmail.com
//   - id 7,  tina@riversteamaz.com
//   - id 3,  kasotharvey@gmail.com
//   - id 2,  ozleng@yahoo.com
//
// Explicitly EXCLUDED (do not add):
//   - id 6, sheld68@gmail.com             -> already has 2 contact rows from the CTA form
//   - id 4, ksyost@pldi.net               -> already has 1 contact row from the CTA form
//   - id 8, solvetest.qa@example.com      -> internal test account, not a real lead
//   - id 5, verify-test-16jul@example.com -> internal test account, not a real lead
//
// Field mapping is IDENTICAL to the live auto-create path (source
// "voice_demo", type "role_play", etc.) via buildVoiceDemoContact, except
// `createdAt` is backdated to the signup's original demo_signups.created_at
// (not "now"), so the Contacts list reflects when they actually signed up.
//
// Per the product decision for this backfill: these 6 contacts are NOT
// enrolled in any drip email retroactively (they were never in the drip
// system; enrolling them now would look like a stale "welcome" email arriving
// weeks late). This script only ever calls storage.listContacts/createLead --
// it never touches demoDrip.ts or enrollDemoDrip.
//
// IDEMPOTENT: uses the same hasVoiceDemoContact check as the live path (a
// "voice_demo"-sourced contact already existing for the email, case
// insensitive) to skip rows that were already backfilled (or already
// auto-created going forward) on a re-run.
//
// Run against whatever DATABASE_URL points at, e.g. production after this PR
// is reviewed and merged:
//   DATABASE_URL=postgres://... npx tsx scripts/backfill_voice_demo_contacts.ts
//
// Do NOT run this inside the sandbox / against production as part of this
// change-set. It is a documented manual step for after merge (see the PR
// description for the exact command).
import { storage } from "../server/storage";
import { buildVoiceDemoContact, hasVoiceDemoContact } from "../server/contacts";
import type { Contact, DemoSignup, InsertContact } from "@shared/schema";

// The corrected, final backfill list (signup id -> email), confirmed against
// production data. Kept as a literal list (not re-derived from a live query)
// per the spec, so this script can't silently pick up unrelated new signups.
export const BACKFILL_SIGNUP_IDS: number[] = [11, 10, 9, 7, 3, 2];

export type BackfillAction =
  | { kind: "create"; signupId: number; email: string; contact: InsertContact }
  | { kind: "skip_no_signup"; signupId: number }
  | { kind: "skip_already_backfilled"; signupId: number; email: string };

// Pure planning step: given the target signup ids, a lookup for each
// demo_signups row, and the current contacts snapshot, decides exactly what
// to do for each id, without performing any I/O. This is the piece unit-tested
// in scripts/backfill_voice_demo_contacts.test.ts; main() below just executes
// the plan against the real DB. Kept side-effect-free and dependency-injected
// so the idempotency and field-mapping rules can be verified without a database.
export function planBackfill(
  signupIds: number[],
  getSignup: (id: number) => DemoSignup | undefined,
  existingContacts: Pick<Contact, "email" | "source">[],
): BackfillAction[] {
  const actions: BackfillAction[] = [];
  // Track emails "created" within this same planning pass too, so a
  // (hypothetical) duplicate id in the list can't plan two creates.
  const alreadyPlanned = new Set(
    existingContacts.filter((c) => c.source === "voice_demo").map((c) => c.email.trim().toLowerCase()),
  );
  for (const signupId of signupIds) {
    const signup = getSignup(signupId);
    if (!signup) {
      actions.push({ kind: "skip_no_signup", signupId });
      continue;
    }
    const key = signup.email.trim().toLowerCase();
    if (alreadyPlanned.has(key) || hasVoiceDemoContact(existingContacts, signup.email)) {
      actions.push({ kind: "skip_already_backfilled", signupId, email: signup.email });
      continue;
    }
    alreadyPlanned.add(key);
    actions.push({
      kind: "create",
      signupId,
      email: signup.email,
      contact: buildVoiceDemoContact(signup.email, signup.createdAt),
    });
  }
  return actions;
}

async function main() {
  const existingContacts = await storage.listContacts({ archived: "all" });
  const signupCache = new Map<number, DemoSignup | undefined>();
  for (const id of BACKFILL_SIGNUP_IDS) {
    signupCache.set(id, await storage.getDemoSignup(id));
  }
  const actions = planBackfill(BACKFILL_SIGNUP_IDS, (id) => signupCache.get(id), existingContacts);

  let created = 0;
  let skippedNoSignup = 0;
  let skippedAlreadyBackfilled = 0;

  for (const action of actions) {
    if (action.kind === "skip_no_signup") {
      console.warn(`[backfill] demo_signups id ${action.signupId} not found; skipping.`);
      skippedNoSignup += 1;
      continue;
    }
    if (action.kind === "skip_already_backfilled") {
      console.log(`[backfill] ${action.email} (signup ${action.signupId}) already has a voice_demo contact; skipping.`);
      skippedAlreadyBackfilled += 1;
      continue;
    }
    const contact = await storage.createLead(action.contact);
    console.log(
      `[backfill] created contact ${contact.id} for ${action.email} (signup ${action.signupId}), createdAt=${action.contact.createdAt}`,
    );
    created += 1;
  }

  console.log(
    `[backfill] done. created=${created} skippedAlreadyBackfilled=${skippedAlreadyBackfilled} skippedNoSignup=${skippedNoSignup}`,
  );
  process.exit(0);
}

// Only run main() when this file is executed directly (via tsx), not when
// imported by the test file for planBackfill.
if (process.argv[1] && process.argv[1].endsWith("backfill_voice_demo_contacts.ts")) {
  main().catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
}
