import type { InsertCoinAward, Scenario, Session } from "@shared/schema";
import type { IStorage } from "./storage";

export const ROLLING_SESSION_LIMIT = 20;

export type IntelligenceTrack = "consulting" | "leadership";
export type CoinTier = "bronze" | "silver" | "gold";

export const CONSULTING_RUBRIC_DIMENSIONS = [
  { key: "needsDiscovery", label: "Needs discovery (drill vs. the hole)" },
  { key: "objectionPrevention", label: "Objection prevention via early discovery" },
  { key: "trustBuilding", label: "Trust building" },
  { key: "naturalClose", label: "Natural, decision-focused close" },
  { key: "relationshipContinuity", label: "Relationship continuity / follow-up" },
] as const;

export const LEADERSHIP_RUBRIC_DIMENSIONS = [
  { key: "activeListening", label: "Active listening (let them fully vent)" },
  { key: "empathyAcknowledgment", label: "Empathy / acknowledged the feeling" },
  { key: "rootCauseDiscovery", label: "Root-cause discovery" },
  { key: "solutionVisualization", label: "Co-created the solution" },
  { key: "blamelessResolution", label: "Blameless resolution" },
] as const;

const TIER_FOR_LEVEL: Record<string, CoinTier> = {
  beginner: "bronze",
  intermediate: "silver",
  advanced: "gold",
};

function sessionDate(session: Pick<Session, "createdAt">): string {
  return session.createdAt;
}

export function latestCompletedScoredSessions(sessions: Session[]): Session[] {
  return sessions
    .filter((session) => session.status === "completed" && session.score !== null)
    .sort((a, b) => sessionDate(b).localeCompare(sessionDate(a)))
    .slice(0, ROLLING_SESSION_LIMIT);
}

export function rollingAverageScore(sessions: Session[]): number | null {
  const window = latestCompletedScoredSessions(sessions);
  if (window.length === 0) return null;
  return window.reduce((sum, session) => sum + (session.score as number), 0) / window.length;
}

export function coinTierForLevel(level: string): CoinTier | null {
  return TIER_FOR_LEVEL[level] ?? null;
}

export async function awardCoinForAdvancement(
  awards: Pick<IStorage, "insertCoinAwardIfAbsent">,
  input: {
    userId: number;
    officeId: number;
    track: IntelligenceTrack;
    levelCrossed: string;
    earnedAt: string;
  },
): Promise<boolean> {
  const tier = coinTierForLevel(input.levelCrossed);
  if (!tier) return false;
  const award: InsertCoinAward = {
    userId: input.userId,
    officeId: input.officeId,
    track: input.track,
    tier,
    earnedAt: input.earnedAt,
  };
  return awards.insertCoinAwardIfAbsent(award);
}

type Dimension = { key: string; label: string };

function parseRubric(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function deriveStrengthsAndWeaknesses(
  sessions: Session[],
  scenarios: Scenario[],
  track: IntelligenceTrack,
): {
  strength: { key: string; label: string; average: number } | null;
  weakness: { key: string; label: string; average: number } | null;
  sampleSize: number;
} {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const dimensions: readonly Dimension[] =
    track === "leadership" ? LEADERSHIP_RUBRIC_DIMENSIONS : CONSULTING_RUBRIC_DIMENSIONS;
  const window = sessions
    .filter((session) => {
      const scenario = scenarioById.get(session.scenarioId);
      const sessionTrack: IntelligenceTrack = scenario?.track === "leadership" ? "leadership" : "consulting";
      return session.status === "completed" && sessionTrack === track;
    })
    .sort((a, b) => sessionDate(b).localeCompare(sessionDate(a)))
    .slice(0, ROLLING_SESSION_LIMIT);

  if (window.length === 0) return { strength: null, weakness: null, sampleSize: 0 };

  const averages = dimensions
    .map((dimension) => {
      const values = window
        .map((session) => parseRubric(session.rubricScores)?.[dimension.key])
        .filter((value): value is number => typeof value === "number");
      if (values.length === 0) return null;
      return {
        ...dimension,
        average: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    })
    .filter((dimension): dimension is Dimension & { average: number } => dimension !== null);

  if (averages.length === 0) return { strength: null, weakness: null, sampleSize: window.length };

  const strength = averages.reduce((best, current) => current.average > best.average ? current : best);
  const weakness = averages.reduce((worst, current) => current.average < worst.average ? current : worst);
  return { strength, weakness, sampleSize: window.length };
}
