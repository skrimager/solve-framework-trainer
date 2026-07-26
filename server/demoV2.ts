// Pure selection logic for the demo v2 flow (industry choice + no-repeat
// rotation). Deliberately free of express, storage, and network concerns so the
// picker can be unit tested directly. server/demo.ts is untouched by this file:
// v2 imports its primitives from there rather than reimplementing them.

export type DemoV2IndustryKey = "auto" | "real_estate";

export type DemoV2Industry = {
  key: DemoV2IndustryKey;
  label: string;
  blurb: string;
};

// Served from GET /api/demo-v2/options so the client never hardcodes this list.
export const DEMO_V2_INDUSTRIES: DemoV2Industry[] = [
  {
    key: "auto",
    label: "Auto Sales",
    blurb: "A customer walks in or calls about a vehicle. What they ask for is almost never what they actually need.",
  },
  {
    key: "real_estate",
    label: "Real Estate",
    blurb: "A buyer opens with a listing, a price, or a neighborhood. The real reason they are moving sits underneath it.",
  },
];

// Fixed per-industry order. The picker walks these in order, so the sequence a
// visitor sees inside one industry is stable and reviewable.
export const DEMO_V2_SLUGS: Record<DemoV2IndustryKey, string[]> = {
  auto: ["demo-v2-auto-1", "demo-v2-auto-2", "demo-v2-auto-3"],
  real_estate: ["demo-v2-re-1", "demo-v2-re-2", "demo-v2-re-3"],
};

export const DEMO_V2_ALL_SLUGS: string[] = [
  ...DEMO_V2_SLUGS.auto,
  ...DEMO_V2_SLUGS.real_estate,
];

export function industryForSlug(slug: string): DemoV2IndustryKey | null {
  if (DEMO_V2_SLUGS.auto.includes(slug)) return "auto";
  if (DEMO_V2_SLUGS.real_estate.includes(slug)) return "real_estate";
  return null;
}

export function isDemoV2Industry(value: unknown): value is DemoV2IndustryKey {
  return value === "auto" || value === "real_estate";
}

// One candidate scenario. Only the fields the picker needs, so tests can build
// candidates without a full scenario row.
export type DemoV2ScenarioOption = {
  id: number;
  slug: string;
  industry: DemoV2IndustryKey;
};

// A prior v2 session for this email, oldest first. listDemoSessionsBySignup
// orders by ascending id, which is chronological, and the exhaustion fallback
// below relies on that ordering.
export type DemoV2PriorSession = { scenarioId: number };

/**
 * Chooses the scenario for this visitor's next session in `industryKey`.
 *
 * Exclusion is scoped per industry: the caller passes every v2 session for the
 * email, and scenarios from the other industry simply never match a candidate,
 * so three Real Estate sessions in a row yield three distinct Real Estate
 * scenarios regardless of how much Auto history exists.
 */
export function pickNextV2Scenario(
  industryKey: DemoV2IndustryKey,
  priorSessions: DemoV2PriorSession[],
  pool: DemoV2ScenarioOption[],
): DemoV2ScenarioOption {
  const candidates = pool.filter((option) => option.industry === industryKey);
  if (candidates.length === 0) {
    throw new Error(`No demo v2 scenarios available for industry ${industryKey}`);
  }

  const seen = new Set(priorSessions.map((session) => session.scenarioId));
  const unseen = candidates.find((option) => !seen.has(option.id));
  if (unseen) return unseen;

  // Exhaustion fallback. Unreachable with three scenarios and a three-session
  // cap, but a shrunken pool (a scenario deactivated mid-flight) must degrade to
  // a repeat rather than a 500. Least recently used: the candidate whose most
  // recent appearance in this email's history is furthest back.
  const lastSeenAt = new Map<number, number>();
  priorSessions.forEach((session, index) => {
    lastSeenAt.set(session.scenarioId, index);
  });
  return candidates.reduce((leastRecent, option) => {
    const optionSeenAt = lastSeenAt.get(option.id) ?? -1;
    const bestSeenAt = lastSeenAt.get(leastRecent.id) ?? -1;
    return optionSeenAt < bestSeenAt ? option : leastRecent;
  }, candidates[0]);
}
