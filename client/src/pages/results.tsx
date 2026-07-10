import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/app-shell";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { Session, RubricScores, LeadershipRubricScores, CoachingMessage } from "@shared/schema";

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

type CoachingThreadResponse = { messages: CoachingMessage[]; canPost: boolean };

// The SOLVE Coach follow-up Q&A panel shown under the rubric feedback. The
// trainee who ran the scenario can ask follow-up questions or push back and get
// a conversational reply; a manager/QA viewing the attempt sees the same thread
// read-only (no composer). The thread lives only until the trainee starts their
// next scenario, at which point the server soft-clears it.
function CoachingPanel({ sessionId, ownerId }: { sessionId: string; ownerId: number }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const requesterId = user?.id;
  const isOwner = requesterId === ownerId;

  const threadKey = ["/api/sessions", sessionId, "coaching", requesterId];
  const { data, isLoading } = useQuery<CoachingThreadResponse>({
    queryKey: threadKey,
    enabled: !!requesterId,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/sessions/${sessionId}/coaching?requesterId=${requesterId}`,
      );
      return res.json();
    },
  });

  const ask = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/sessions/${sessionId}/coaching`, {
        userId: requesterId,
        content,
      });
      return res.json() as Promise<CoachingThreadResponse>;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(threadKey, result);
      setDraft("");
    },
  });

  const messages = data?.messages ?? [];

  return (
    <Card data-testid="card-solve-coach">
      <CardHeader>
        <CardTitle className="text-lg">Ask SOLVE Coach</CardTitle>
        <p className="text-sm text-muted-foreground">
          Follow-up questions or pushback on this feedback? Talk it through with SOLVE Coach.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-16 rounded-md" />
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-coaching-empty">
            {isOwner
              ? "No questions yet. Ask anything about your discovery approach in this scenario."
              : "This trainee hasn't asked SOLVE Coach anything on this attempt yet."}
          </p>
        ) : (
          <div className="space-y-3" data-testid="list-coaching-messages">
            {messages.map((m) => (
              <div
                key={m.id}
                className={m.role === "trainee" ? "flex justify-end" : "flex justify-start"}
                data-testid={`coaching-message-${m.role}`}
              >
                <div
                  className={
                    m.role === "trainee"
                      ? "max-w-[85%] rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm"
                      : "max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm"
                  }
                >
                  <div className="text-xs font-medium mb-0.5 opacity-70">
                    {m.role === "trainee" ? "You" : "SOLVE Coach"}
                  </div>
                  {m.content}
                </div>
              </div>
            ))}
          </div>
        )}

        {isOwner ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. How could I have opened that conversation to uncover their real need sooner?"
              rows={3}
              data-testid="input-coaching-question"
            />
            <Button
              onClick={() => ask.mutate(draft.trim())}
              disabled={!draft.trim() || ask.isPending}
              data-testid="button-ask-coach"
            >
              {ask.isPending ? "SOLVE Coach is thinking…" : "Ask SOLVE Coach"}
            </Button>
            {ask.isError && (
              <p className="text-sm text-destructive" data-testid="text-coaching-error">
                Something went wrong reaching SOLVE Coach. Please try again.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="text-coaching-readonly">
            Read-only: you're viewing this trainee's SOLVE Coach conversation.
          </p>
        )}
      </CardContent>
    </Card>
  );
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
              <span className="text-2xl font-semibold" data-testid="text-overall-score">{session.score ?? "-"}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground" data-testid="text-feedback">{session.feedback}</p>
            <p className="text-xs font-medium" style={{ color: "#E06D00" }} data-testid="text-coach-byline">
              Scored by SOLVE Coach™
            </p>
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

        {session.status === "completed" && (
          <CoachingPanel sessionId={id} ownerId={session.userId} />
        )}

        <Button onClick={() => navigate("/scenarios")} data-testid="button-back-to-scenarios">
          Try another scenario
        </Button>
      </div>
    </AppShell>
  );
}
