import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Session, Office } from "@shared/schema";

const ACTIVE_STATUSES = ["active", "trialing"];
function officeActive(office?: Office): boolean {
  return !!office && ACTIVE_STATUSES.includes(office.subscriptionStatus);
}

// Shared by 'manager' and 'qa' roles — both need to review sessions across consultants.
export default function Dashboard() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  const { data: sessions, isLoading } = useQuery<Session[]>({
    queryKey: [`/api/sessions?requesterId=${user?.id}`],
    enabled: !!user,
  });

  const { data: office } = useQuery<Office>({
    queryKey: [`/api/offices/${user?.officeId}`],
    enabled: !!user && user.role === "manager",
    // Poll while the subscription isn't active yet so the dashboard flips to the
    // unlocked state moments after the Stripe webhook grants access.
    refetchInterval: (query) => (officeActive(query.state.data as Office | undefined) ? false : 4000),
  });

  const completed = sessions?.filter((s) => s.status === "completed") ?? [];
  const avgScore = completed.length
    ? Math.round(completed.reduce((sum, s) => sum + (s.score ?? 0), 0) / completed.length)
    : null;

  return (
    <AppShell title={user?.role === "manager" ? "Manager overview" : "QA review"}>
      <div className="space-y-6">
        {user?.role === "manager" && office && <BillingCard office={office} />}
        {user?.role === "manager" && office && officeActive(office) && (
          <Card className="border-2" style={{ borderColor: "#E06D00" }}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm text-muted-foreground">Your office invite code</p>
                <p className="text-2xl font-bold tracking-widest" data-testid="text-invite-code">{office.inviteCode}</p>
              </div>
              <p className="text-xs text-muted-foreground max-w-xs">
                Share this code with your consultants so they can join <span className="font-medium">{office.name}</span> at sign-up.
              </p>
            </CardContent>
          </Card>
        )}
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

// Manager billing controls. Three states:
//  - inactive: prompt to start Stripe Checkout (access is granted by webhook, so the
//    office query polls until it flips active).
//  - past_due: immediate-lockout warning + Manage Billing to fix payment.
//  - active: Manage Billing + "Add my own training seat" (managers need a paid seat
//    to run roleplay; the dashboard itself is admin-only).
function BillingCard({ office }: { office: Office }) {
  const { user, setUser } = useAuth();
  const { toast } = useToast();
  const [busy, setBusy] = useState<null | "checkout" | "portal" | "seat">(null);

  async function redirectTo(action: "checkout" | "portal") {
    setBusy(action);
    try {
      const res = await apiRequest("POST", `/api/billing/${action}`, { userId: user?.id });
      const { url } = await res.json();
      window.location.href = url;
    } catch (err: any) {
      toast({ title: "Billing error", description: humanError(err), variant: "destructive" });
      setBusy(null);
    }
  }

  async function addOwnSeat() {
    setBusy("seat");
    try {
      const res = await apiRequest("POST", "/api/billing/manager-seat", { userId: user?.id });
      const { user: updated } = await res.json();
      if (updated && user) setUser({ ...user, ...updated });
      toast({ title: "Training seat added", description: "You can now run roleplay sessions." });
    } catch (err: any) {
      toast({ title: "Couldn't add your seat", description: humanError(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  const isActive = officeActive(office);
  const isPastDue = ["past_due", "unpaid"].includes(office.subscriptionStatus);

  if (!isActive) {
    return (
      <Card className="border-2" style={{ borderColor: "#E06D00" }}>
        <CardHeader>
          <CardTitle className="text-lg">
            {isPastDue ? "Payment needed to restore access" : "Activate your subscription"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground" data-testid="text-billing-status">
            {isPastDue
              ? "Your latest payment failed, so training is locked for your whole office until billing is brought current."
              : "Your office needs an active subscription before you or your consultants can start training."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => redirectTo(isPastDue && office.stripeCustomerId ? "portal" : "checkout")}
              disabled={busy !== null}
              style={{ backgroundColor: "#E06D00", color: "white" }}
              data-testid="button-activate-subscription"
            >
              {busy ? "Opening…" : isPastDue ? "Manage billing" : "Set up billing"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-2" style={{ borderColor: "#E06D00" }}>
      <CardHeader>
        <CardTitle className="text-lg">Billing &amp; subscription</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" data-testid="badge-subscription-status">{office.subscriptionStatus}</Badge>
          <span className="text-sm text-muted-foreground">{office.activeSeatCount} paid seat(s)</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => redirectTo("portal")}
            disabled={busy !== null}
            data-testid="button-manage-billing"
          >
            {busy === "portal" ? "Opening…" : "Manage billing"}
          </Button>
          {!user?.seatActive && (
            <Button
              onClick={addOwnSeat}
              disabled={busy !== null}
              style={{ backgroundColor: "#E06D00", color: "white" }}
              data-testid="button-add-training-seat"
            >
              {busy === "seat" ? "Adding…" : "Add my own training seat"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function humanError(err: any): string {
  const msg = String(err?.message ?? "");
  const match = msg.match(/^\d+:\s*([\s\S]*)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.message) return parsed.message;
    } catch {
      if (match[1]) return match[1];
    }
  }
  return "Please try again.";
}
