// Pure rotation for the dedicated Stall & Excuse Handling module. It deliberately
// has no storage or route dependencies, so callers can supply the user's session
// history and the currently active stall-scenario pool directly.

export type StallScenarioOption = {
  id: number;
  slug: string;
  stallType: string;
};

// Sessions must be oldest first, matching storage.listSessionsByUser(). The
// userId is included so callers may pass a broader history without leaking one
// trainee's recent stall pattern into another trainee's rotation.
export type StallPriorSession = {
  userId: number;
  scenarioId: number;
};

/**
 * Picks the next Stall & Excuse Handling scenario for one user.
 *
 * Prefer unseen scenarios, then fall back to least recently used once the pool
 * is exhausted. In both cases, a candidate with the immediately preceding stall
 * type is excluded so consecutive stall practices always vary their diagnosis.
 */
export function pickNextStallScenario(
  userId: number,
  sessions: StallPriorSession[],
  pool: StallScenarioOption[],
): StallScenarioOption {
  if (pool.length === 0) {
    throw new Error("No Stall & Excuse Handling scenarios available");
  }

  const byId = new Map(pool.map((scenario) => [scenario.id, scenario]));
  const priorStallSessions = sessions.filter(
    (session) => session.userId === userId && byId.has(session.scenarioId),
  );
  const immediatelyPrior = priorStallSessions.at(-1);
  const immediatelyPriorType = immediatelyPrior
    ? byId.get(immediatelyPrior.scenarioId)?.stallType
    : undefined;
  const eligible = immediatelyPriorType
    ? pool.filter((scenario) => scenario.stallType !== immediatelyPriorType)
    : pool;

  if (eligible.length === 0) {
    throw new Error("No Stall & Excuse Handling scenario can avoid repeating the prior stall type");
  }

  const seen = new Set(priorStallSessions.map((session) => session.scenarioId));
  const unseen = eligible.find((scenario) => !seen.has(scenario.id));
  if (unseen) return unseen;

  // Pool exhausted: choose the candidate whose most recent appearance was
  // furthest back in this user's chronological session history.
  const lastSeenAt = new Map<number, number>();
  priorStallSessions.forEach((session, index) => lastSeenAt.set(session.scenarioId, index));
  return eligible.reduce((leastRecent, scenario) => {
    const scenarioSeenAt = lastSeenAt.get(scenario.id) ?? -1;
    const leastRecentSeenAt = lastSeenAt.get(leastRecent.id) ?? -1;
    return scenarioSeenAt < leastRecentSeenAt ? scenario : leastRecent;
  }, eligible[0]);
}
