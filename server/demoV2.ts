// Pure selection logic for the demo v2 flow (industry choice + no-repeat
// rotation). Deliberately free of express, storage, and network concerns so the
// picker can be unit tested directly. server/demo.ts is untouched by this file:
// v2 imports its primitives from there rather than reimplementing them.

export type DemoV2IndustryKey =
  | "auto"
  | "real_estate"
  | "apartment_rental"
  | "employee_grievance"
  | "financial_advisor"
  | "home_improvement"
  | "hvac_sales"
  | "hvac_service"
  | "insurance_auto"
  | "manufactured_housing"
  | "manufactured_housing_community"
  | "peer_conflict"
  | "pest_control"
  | "plumbing"
  | "pool_landscaping"
  | "roofing"
  | "saas"
  | "solar"
  | "upset_customer_service";

export type DemoV2Industry = {
  key: DemoV2IndustryKey;
  label: string;
  blurb: string;
  group: "sales_service" | "leadership";
};

// Served from GET /api/demo/options so the client never hardcodes this list.
export const DEMO_V2_INDUSTRIES: DemoV2Industry[] = [
  {
    key: "auto",
    label: "Auto Sales",
    blurb: "A customer walks in or calls about a vehicle. What they ask for is almost never what they actually need.",
    group: "sales_service",
  },
  {
    key: "real_estate",
    label: "Real Estate",
    blurb: "A buyer opens with a listing, a price, or a neighborhood. The real reason they are moving sits underneath it.",
    group: "sales_service",
  },
  {
    key: "apartment_rental",
    label: "Apartment Rental",
    blurb: "A renter asks about price or location. The reason they need to move is where the real conversation begins.",
    group: "sales_service",
  },
  {
    key: "financial_advisor",
    label: "Financial Advisor",
    blurb: "A client asks where to put their money. What it is meant to protect or make possible matters more than the product.",
    group: "sales_service",
  },
  {
    key: "home_improvement",
    label: "Home Improvement",
    blurb: "A homeowner asks for one upgrade. The plans behind the project determine what will actually serve them.",
    group: "sales_service",
  },
  {
    key: "hvac_sales",
    label: "HVAC Sales",
    blurb: "A homeowner asks for the cheapest system. The comfort problem they have learned to live with may be the real need.",
    group: "sales_service",
  },
  {
    key: "hvac_service",
    label: "HVAC Service",
    blurb: "A homeowner wants the air back on fast. Understanding who is affected changes what a helpful solution looks like.",
    group: "sales_service",
  },
  {
    key: "insurance_auto",
    label: "Auto Insurance",
    blurb: "A caller asks for a rate. The event that made them shop is usually the question worth asking first.",
    group: "sales_service",
  },
  {
    key: "manufactured_housing",
    label: "Manufactured Housing",
    blurb: "A buyer focuses on the lowest price. The family situation behind that budget is what shapes the right home.",
    group: "sales_service",
  },
  {
    key: "manufactured_housing_community",
    label: "Housing Community",
    blurb: "A prospective resident reacts to the lot rent. A fair comparison starts with what they are comparing it to.",
    group: "sales_service",
  },
  {
    key: "pest_control",
    label: "Pest Control",
    blurb: "A homeowner asks for a quick treatment. The pattern behind the problem tells you whether a quick fix is enough.",
    group: "sales_service",
  },
  {
    key: "plumbing",
    label: "Plumbing",
    blurb: "A homeowner wants a drain fixed fast. The history of the issue reveals whether this is really a simple repair.",
    group: "sales_service",
  },
  {
    key: "pool_landscaping",
    label: "Pool & Landscaping",
    blurb: "A homeowner asks for something small and simple. How they hope to use the space is what should guide the design.",
    group: "sales_service",
  },
  {
    key: "roofing",
    label: "Roofing",
    blurb: "A homeowner asks for a quote to compare. The sign that prompted the call may matter more than the number.",
    group: "sales_service",
  },
  {
    key: "saas",
    label: "SaaS",
    blurb: "A buyer asks for a tool or feature. The workflow and control they need underneath the request determine the fit.",
    group: "sales_service",
  },
  {
    key: "solar",
    label: "Solar",
    blurb: "A homeowner questions whether solar pays off. The concern behind the skepticism is where a useful conversation starts.",
    group: "sales_service",
  },
  {
    key: "employee_grievance",
    label: "Employee Grievance",
    blurb: "An employee raises a complaint. The impact they are reluctant to name is usually the real issue to understand.",
    group: "leadership",
  },
  {
    key: "peer_conflict",
    label: "Peer Conflict",
    blurb: "An employee is frustrated with a coworker. The stakes they feel personally may be driving the conflict.",
    group: "leadership",
  },
  {
    key: "upset_customer_service",
    label: "Upset Customer Service",
    blurb: "A customer asks for a refund. Understanding why the miss mattered is how you begin to make it right.",
    group: "leadership",
  },
];

// Fixed per-industry order. The picker walks these in order, so the sequence a
// visitor sees inside one industry is stable and reviewable.
export const DEMO_V2_SLUGS: Record<DemoV2IndustryKey, string[]> = {
  auto: ["demo-v2-auto-1", "demo-v2-auto-2", "demo-v2-auto-3"],
  real_estate: ["demo-v2-re-1", "demo-v2-re-2", "demo-v2-re-3"],
  apartment_rental: ["demo-v2-apartment-rental-1"],
  employee_grievance: ["demo-v2-employee-grievance-1"],
  financial_advisor: ["demo-v2-financial-advisor-1"],
  home_improvement: ["demo-v2-home-improvement-1"],
  hvac_sales: ["demo-v2-hvac-sales-1"],
  hvac_service: ["demo-v2-hvac-service-1"],
  insurance_auto: ["demo-v2-insurance-auto-1"],
  manufactured_housing: ["demo-v2-manufactured-housing-1"],
  manufactured_housing_community: ["demo-v2-manufactured-housing-community-1"],
  peer_conflict: ["demo-v2-peer-conflict-1"],
  pest_control: ["pest-control-one-time-vs-ongoing-plan"],
  plumbing: ["demo-v2-plumbing-1"],
  pool_landscaping: ["demo-v2-pool-landscaping-1"],
  roofing: ["demo-v2-roofing-1"],
  saas: ["saas-website-refresh-first-project"],
  solar: ["demo-v2-solar-1"],
  upset_customer_service: ["demo-v2-upset-customer-service-1"],
};

export const DEMO_V2_ALL_SLUGS: string[] = Object.values(DEMO_V2_SLUGS).flat();

// The free demo always runs at Beginner, no matter what the scenario row says.
// A brand-new visitor gets exactly one session, and that first impression has to
// be encouraging rather than punishing. Pinning it here at request time (instead
// of relying on the six rows being seeded "beginner") means an admin edit, a
// partial reseed, or any future difficulty picker can never quietly hand someone
// an Advanced conversation on their first try. The paid/trainee flow in
// server/routes.ts is untouched and still honors the scenario's own difficulty.
export const DEMO_V2_DIFFICULTY = "beginner";

// The scenario the demo should actually run: the stored row with difficulty
// forced to Beginner. Applied at every point the demo loads a scenario, so the
// difficulty the customer is generated at and the difficulty the session is
// scored at are always the same value and can never drift apart.
export function demoV2Scenario<T extends { difficulty: string }>(scenario: T): T {
  return { ...scenario, difficulty: DEMO_V2_DIFFICULTY };
}

export function industryForSlug(slug: string): DemoV2IndustryKey | null {
  return (
    (Object.keys(DEMO_V2_SLUGS) as DemoV2IndustryKey[]).find((industry) =>
      DEMO_V2_SLUGS[industry].includes(slug),
    ) ?? null
  );
}

export function isDemoV2Industry(value: unknown): value is DemoV2IndustryKey {
  return (
    typeof value === "string" &&
    (Object.keys(DEMO_V2_SLUGS) as string[]).includes(value)
  );
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
 * so repeated Real Estate sessions yield distinct Real Estate scenarios
 * regardless of how much Auto history exists.
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

  // Exhaustion fallback. Unreachable while the per-industry pool is larger than
  // the number of sessions one visitor can run, but a shrunken pool (a scenario
  // deactivated mid-flight) must degrade to a repeat rather than a 500. Least recently used: the candidate whose most
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
