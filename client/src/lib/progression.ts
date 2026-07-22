import type { Level } from "@/lib/auth";

// Advancing a level and becoming exam-eligible both require REQUIRED_QUALIFYING
// sessions that EACH score QUALIFYING_SCORE or higher at the relevant level.
// These come from @shared/advancement — the single source of truth shared with
// the server — and are re-exported under the local names this module already
// uses so importers (and the academy path copy) stay unchanged.
import {
  ADVANCE_THRESHOLD,
  REQUIRED_QUALIFYING_SESSIONS,
} from "@shared/advancement";

export const REQUIRED_QUALIFYING = REQUIRED_QUALIFYING_SESSIONS;
export const QUALIFYING_SCORE = ADVANCE_THRESHOLD;

export type StageKey = "beginner" | "intermediate" | "advanced" | "certified";
export type StageState = "complete" | "current" | "locked";

export type PathStage = {
  key: StageKey;
  label: string;
  state: StageState;
  // Shown under a locked stage: exactly what unlocks it, phrased with the real
  // thresholds above. Undefined for stages the consultant has already reached.
  unlockCriteria?: string;
};

// Full progression path, in order. The first three mirror the practice levels;
// "certified" is the credential earned by passing the exam after Advanced.
export const STAGE_ORDER: StageKey[] = ["beginner", "intermediate", "advanced", "certified"];

const STAGE_LABELS: Record<StageKey, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
  certified: "Certified",
};

// What each stage requires to unlock, stated with the real thresholds. Beginner
// is the entry point, so it has no precondition. The certified line states the
// exam requirement up front, matching the locked exam card copy.
const STAGE_UNLOCK: Record<StageKey, string | undefined> = {
  beginner: undefined,
  intermediate: `Reach Intermediate by completing ${REQUIRED_QUALIFYING} qualifying Beginner sessions scoring ${QUALIFYING_SCORE} or higher.`,
  advanced: `Reach Advanced by completing ${REQUIRED_QUALIFYING} qualifying Intermediate sessions scoring ${QUALIFYING_SCORE} or higher.`,
  certified: `Complete ${REQUIRED_QUALIFYING} Advanced sessions scoring ${QUALIFYING_SCORE} or higher, then pass the certification exam.`,
};

// Index of the consultant's current position on the path. A certified consultant
// sits on the final "certified" stage; everyone else sits on their activeLevel.
export function currentStageIndex(activeLevel: Level, certified: boolean): number {
  if (certified) return STAGE_ORDER.indexOf("certified");
  return STAGE_ORDER.indexOf(activeLevel);
}

// Build the full Beginner -> Intermediate -> Advanced -> Certified path with each
// stage marked complete / current / locked relative to where the consultant is.
// Every stage is always returned (locked ones are greyed out, never hidden), so
// the path is fully visible from day one at Beginner.
export function buildProgressionPath(activeLevel: Level, certified: boolean): PathStage[] {
  const currentIndex = currentStageIndex(activeLevel, certified);
  return STAGE_ORDER.map((key, i) => {
    const state: StageState = i < currentIndex ? "complete" : i === currentIndex ? "current" : "locked";
    return {
      key,
      label: STAGE_LABELS[key],
      state,
      unlockCriteria: state === "locked" ? STAGE_UNLOCK[key] : undefined,
    };
  });
}
