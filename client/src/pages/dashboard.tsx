import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/lib/auth";
import type { Session } from "@shared/schema";

// Shared by 'manager' and 'qa' roles — both need to review sessions across consultants.
export default function Dashboard() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  const { data: sessions, isLoading } = useQuery<Session[]>({
    queryKey: ["/api/sessions"],
  });

  const completed = sessions?.filter((s) => s.status === "completed") ?? [];
  const avgScore = completed.length
    ? Math.round(completed.reduce((sum, s) => sum + (s.score ?? 0), 0) / completed.length)
    : null;

  return (
    <AppShell title={user?.role === "manager" ? "Manager overview" : "QA review"}>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal">Sessions completed</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold" data-testid="text-completed-count">{completed.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal">Average discovery score</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold" data-testid="text-avg-score">{avgScore ?? "—"}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground font-normal">In progress</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold" data-testid="text-in-progress-count">
                {(sessions?.length ?? 0) - completed.length}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">All sessions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading && <Skeleton className="h-32 rounded-lg" />}
            {!isLoading && sessions?.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="text-no-sessions">No sessions recorded yet.</p>
            )}
            {sessions?.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(`/results/${s.id}`)}
                className="w-full flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm text-left hover-elevate active-elevate-2"
                data-testid={`row-session-${s.id}`}
              >
                <span className="text-muted-foreground">Session #{s.id} · consultant #{s.userId}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {s.score !== null && <span className="font-medium">{s.score}</span>}
                  <Badge variant={s.status === "completed" ? "secondary" : "outline"}>{s.status}</Badge>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
