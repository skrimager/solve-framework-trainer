// Slugs of the internal test scenarios: real, fully-functional practice
// scenarios that exist only as a fixed stage for piloting pipeline changes (new
// voice platforms, new models) against realistic content, and that must never be
// visible to a real customer/consultant/manager in staging or production.
//
// Lives in shared/ because both sides need the slug set: the server to filter
// pools and guard session creation, the client to recognise the scenario when
// the server has chosen to include it. Deliberately contains ONLY the slugs.
// Who counts as the internal account is a server-side secret and lives in
// server/internalTestScenario.ts, so the internal username is never shipped in
// the browser bundle.

export const INTERNAL_TEST_SUV_SLUG = "internal-test-suv-priya";

// The real scenario the internal test scenario is cloned from, verbatim, so
// pilot results stay comparable to a real session.
export const INTERNAL_TEST_SUV_SOURCE_SLUG = "auto-sales-growing-family-suv";

const INTERNAL_TEST_SCENARIO_SLUGS = new Set<string>([INTERNAL_TEST_SUV_SLUG]);

export function isInternalTestScenario(slug: string | undefined | null): boolean {
  return !!slug && INTERNAL_TEST_SCENARIO_SLUGS.has(slug);
}
