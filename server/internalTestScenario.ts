// Server-side access control for the internal test scenarios declared in
// shared/internalTestScenarios.ts.
//
// The visibility mechanism mirrors DEMO_ONLY_SCENARIO_SLUGS in server/routes.ts:
// a slug set is the single source of truth, and realTrainingScenarios() is the
// choke point every trainee-facing pool already flows through, so no schema
// column or migration is needed.
//
// The difference from demo-only content is that these are not hidden from
// everyone: exactly one internal account may see and run them. That account is
// identified by USERNAME, never by numeric id, because staging and production
// are seeded separately and the same person holds different ids in each.

import type { User } from "@shared/schema";
import { isInternalTestScenario } from "@shared/internalTestScenarios";

export {
  INTERNAL_TEST_SUV_SLUG,
  INTERNAL_TEST_SUV_SOURCE_SLUG,
  isInternalTestScenario,
} from "@shared/internalTestScenarios";

// The dedicated internal test account seeded by server/seed.ts. This is the
// value INTERNAL_TEST_USERNAME is meant to be set to.
//
// It is deliberately NOT a default for the gate below. Seeding the account and
// switching the gate on stay two separate acts: the row can exist harmlessly in
// every environment while the scenario remains hidden until someone sets the env
// var on purpose. Exported so seed.ts and the docs cannot drift from the gate.
export const INTERNAL_TEST_ACCOUNT_USERNAME = "Testdummy";

// Username of the single internal account allowed to see and start internal test
// scenarios, read from the environment so staging and production can each point
// at a real personal login without a code change, and so the value never has to
// be committed.
//
// Deliberately has NO default. When unset, nobody qualifies and internal test
// scenarios are hidden from absolutely everyone, which is the safe direction to
// fail: a pilot stage that is silently visible to customers is far worse than one
// that needs a config value before it switches on. See .env.example.
export function internalTestUsername(): string | null {
  const raw = process.env.INTERNAL_TEST_USERNAME;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Whether this user is the internal test account. Comparison is exact and
// case-sensitive, matching how storage.getUserByUsername looks users up, so a
// near-miss username can never inherit internal visibility.
export function isInternalTestUser(user: Pick<User, "username"> | null | undefined): boolean {
  const configured = internalTestUsername();
  if (!configured || !user) return false;
  return user.username === configured;
}

// Whether a scenario slug may be shown to, or started by, this user. Any slug
// that is not an internal test scenario passes unconditionally, so this is safe
// to call across the whole catalog.
export function canAccessScenarioSlug(
  slug: string,
  user: Pick<User, "username"> | null | undefined,
): boolean {
  return !isInternalTestScenario(slug) || isInternalTestUser(user);
}
