import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/app-shell";
import type { Session, RubricScores, LeadershipRubricScores } from "@shared/schema";

const RUBRIC_LABELS: Record<keyof RubricScores, string> = {
  needsDiscovery: "Needs discovery (drill vs. the hole)",
  objectionPrevention: "Objection prevention via early discovery",
  trustBuilding: "Trust building",
  naturalClose: "Natural, decision-focused close",
  relationshipContinuity: "Relationship continuity / follow-up",
};

// Leadership / Conflict-Management sessions store a different rubric shape in the
// same field; we tell them apart by which keys the stored JSON contains.
const LEADERSHIP_RUBRIC_LABELS: Record<keyof LeadershipRubricScores, string> = {
  activeListening: "Active listening (let them fully vent)",
  empathyAcknowledgment: "Empathy / acknowledged the feeling",
  rootCauseDiscovery: "Root-cause discovery",
  solutionVisualization: "Co-created the solution",
  blamelessResolution: "Blameless resolution",
};

function isLeadershipRubric(
  rubric: Record<string, number>,
): rubric is LeadershipRubricScores {
  return "activeListening" in rubric;
}

export default function Results() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();

  const { data: session, isLoading } = useQuery<Session>({
    queryKey: ["/api/sessions", id],
  });

  if (isLoading || !session) {
    return (
      <AppShell title="Session results">
        <Skeleton className="h-64 rounded-lg" />
      </AppShell>
    );
  }

  const rubric: Record<string, number> | null = session.rubricScores ? JSON.parse(session.rubricScores) : null;
  const rubricLabels: Record<string, string> =
    rubric && isLeadershipRubric(rubric) ? LEADERSHIP_RUBRIC_LABELS : RUBRIC_LABELS;

  return (
    <AppShell title="Session results">
      <div className="space-y-6 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center justify-between">
              Overall discovery score
              <span className="text-2xl font-semibold" data-testid="text-overall-score">{session.score ?? "—"}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground" data-testid="text-feedback">{session.feedback}</p>
          </CardContent>
        </Card>

        {rubric && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {Object.keys(rubricLabels).map((key) => (
                <div key={key} className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span>{rubricLabels[key]}</span>
                    <span className="text-muted-foreground" data-testid={`text-rubric-${key}`}>{rubric[key]}</span>
                  </div>
                  <Progress value={rubric[key]} data-testid={`progress-${key}`} />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Button onClick={() => navigate("/scenarios")} data-testid="button-back-to-scenarios">
          Try another scenario
        </Button>
      </div>
    </AppShell>
  );
}
