import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/app-shell";
import type { Session, RubricScores } from "@shared/schema";

const RUBRIC_LABELS: Record<keyof RubricScores, string> = {
  needsDiscovery: "Needs discovery (drill vs. the hole)",
  objectionPrevention: "Objection prevention via early discovery",
  trustBuilding: "Trust building",
  naturalClose: "Natural, decision-focused close",
  relationshipContinuity: "Relationship continuity / follow-up",
};

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

  const rubric: RubricScores | null = session.rubricScores ? JSON.parse(session.rubricScores) : null;

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
              {(Object.keys(RUBRIC_LABELS) as (keyof RubricScores)[]).map((key) => (
                <div key={key} className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span>{RUBRIC_LABELS[key]}</span>
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
