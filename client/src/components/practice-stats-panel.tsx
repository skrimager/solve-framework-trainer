import { useQuery } from "@tanstack/react-query";
import { Flame, Trophy, Award } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/auth";

// Game-stat panel palette. Reuses the platform navy + orange only. Lime green is
// reserved for the admin vault login and must never appear on a consultant or
// manager screen, so it is deliberately absent here.
const NAVY = "#0A1A30";
const NAVY_DEEP = "#05162D";
const ORANGE = "#E06D00";
const ORANGE_LIGHT = "#F1830D";

const LEVEL_LABELS: Record<string, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

const levelLabel = (level: string) => LEVEL_LABELS[level] ?? level;

// Shape returned by GET /api/consultant/dashboard. When the office has not paid
// for the Manager Dashboard add-on the server returns only { entitled: false }.
type ConsultantDashboard = {
  entitled: boolean;
  streak?: { current: number; qualifyingScore: number };
  rank?: { position: number | null; outOf: number; metric: string };
  certification?: {
    level: string;
    nextLevel: string | null;
    certified: boolean;
    qualifyingSessions: number;
    requiredSessions: number;
  };
};

// A small, gamified stat panel for the consultant's practice landing page:
// current practice streak, rank among office peers, and progress toward the
// next certification level. Renders nothing at all unless the backend confirms
// the office holds the paid dashboard add-on (entitled), so an unentitled office
// simply sees no widget rather than a broken or nagging UI.
export function PracticeStatsPanel() {
  const { user } = useAuth();

  const { data } = useQuery<ConsultantDashboard>({
    queryKey: [`/api/consultant/dashboard?requesterId=${user?.id}`],
    enabled: !!user,
  });

  if (!data || !data.entitled || !data.streak || !data.rank || !data.certification) {
    return null;
  }

  const { streak, rank, certification } = data;
  const streakActive = streak.current > 0;

  const progressPct = certification.certified
    ? 100
    : Math.round((certification.qualifyingSessions / certification.requiredSessions) * 100);

  const progressLabel = certification.certified
    ? "SOLVE Framework Certified"
    : certification.nextLevel
      ? `Progress to ${levelLabel(certification.nextLevel)}`
      : "Progress to certification";

  return (
    <Card
      className="border-0 overflow-hidden"
      style={{ backgroundColor: NAVY }}
      data-testid="panel-practice-stats"
    >
      <div className="grid gap-px sm:grid-cols-3" style={{ backgroundColor: "rgba(255,255,255,0.08)" }}>
        {/* Streak */}
        <div className="flex items-center gap-3 p-4" style={{ backgroundColor: NAVY }} data-testid="stat-streak">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
            style={{
              backgroundColor: NAVY_DEEP,
              border: `1px solid ${streakActive ? ORANGE : "rgba(255,255,255,0.15)"}`,
              boxShadow: streakActive ? `0 0 14px rgba(224,109,0,0.55)` : "none",
            }}
            aria-hidden="true"
          >
            <Flame
              className="h-5 w-5"
              style={{ color: streakActive ? ORANGE_LIGHT : "rgba(255,255,255,0.4)" }}
            />
          </div>
          <div className="min-w-0">
            <p className="text-2xl font-bold leading-none text-white" data-testid="text-streak-count">
              {streak.current}
            </p>
            <p className="mt-1 text-xs text-white/60">day practice streak</p>
          </div>
        </div>

        {/* Rank */}
        <div className="flex items-center gap-3 p-4" style={{ backgroundColor: NAVY }} data-testid="stat-rank">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: NAVY_DEEP, border: "1px solid rgba(255,255,255,0.15)" }}
            aria-hidden="true"
          >
            <Trophy className="h-5 w-5" style={{ color: ORANGE_LIGHT }} />
          </div>
          <div className="min-w-0">
            {rank.position != null ? (
              <>
                <p className="text-2xl font-bold leading-none text-white" data-testid="text-rank">
                  #{rank.position}
                </p>
                <p className="mt-1 text-xs text-white/60">of {rank.outOf} in your office</p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold leading-none text-white" data-testid="text-rank">
                  Not ranked yet
                </p>
                <p className="mt-1 text-xs text-white/60">Finish a session to join the ranking</p>
              </>
            )}
          </div>
        </div>

        {/* Certification progress */}
        <div className="flex flex-col justify-center gap-2 p-4" style={{ backgroundColor: NAVY }} data-testid="stat-certification">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-white/70">
              <Award className="h-3.5 w-3.5" style={{ color: ORANGE_LIGHT }} aria-hidden="true" />
              {progressLabel}
            </span>
            {!certification.certified && (
              <Badge
                variant="secondary"
                className="border-0 text-white"
                style={{ backgroundColor: NAVY_DEEP }}
                data-testid="badge-cert-progress"
              >
                {certification.qualifyingSessions}/{certification.requiredSessions}
              </Badge>
            )}
          </div>
          <Progress
            value={progressPct}
            className="h-2 [&>div]:bg-[#E06D00]"
            style={{ backgroundColor: NAVY_DEEP }}
            data-testid="progress-certification"
          />
          <p className="text-[11px] text-white/50">
            {certification.certified
              ? "You have earned your certification"
              : `Qualifying sessions at ${levelLabel(certification.level)}`}
          </p>
        </div>
      </div>
    </Card>
  );
}
