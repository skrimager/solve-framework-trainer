import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ConsultantRoster, type RosterReadOnlyData } from "@/components/consultant-roster";
import { apiRequest, getQueryFn } from "@/lib/queryClient";

// Brand palette (shared with the rest of the app / marketing site).
const NAVY = "#0A1A30";
const ORANGE = "#E06D00";
const DASHBOARD_DEMO_QUERY_KEY = ["/api/public/demo-dashboard"];

type DemoDashboardResponse = {
  office: { name: string; inviteCode: string; subscriptionStatus: string };
  stats: { completed: number; avgScore: number | null; inProgress: number };
} & RosterReadOnlyData;

function errorMessage(error: Error): string {
  return error.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"(.*)"\}$/, "$1");
}

// Read-only Command Center demonstration. The protected data request returns
// null for a visitor without the dashboard-demo cookie, which renders the
// email-and-code gate instead of any sample company data.
export default function DemoDashboard() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<DemoDashboardResponse | null>({
    queryKey: DASHBOARD_DEMO_QUERY_KEY,
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  if (isLoading) {
    return (
      <div className="min-h-dvh bg-background px-4 py-8">
        <div className="mx-auto max-w-2xl">
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-dvh bg-background px-4 py-8">
        <Card className="mx-auto max-w-md">
          <CardContent className="py-6">
            <h1 className="text-lg font-semibold">The demo is temporarily unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {error instanceof Error ? errorMessage(error) : "Please try again in a moment."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <DashboardDemoGate
        onVerified={() => {
          void queryClient.invalidateQueries({ queryKey: DASHBOARD_DEMO_QUERY_KEY });
        }}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-background">
      <DemoBanner />

      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
          <Link
            href="/"
            className="shrink-0 inline-flex items-center rounded-[10px]"
            style={{ backgroundColor: "#050C1C", padding: "8px 16px" }}
            data-testid="link-home-logo"
          >
            <img
              src="/solve-wordmark-bigtag-transparent.png"
              alt="SOLVE Framework - Practice. Performance. Period."
              className="h-14 w-auto block"
              data-testid="img-solve-logo"
            />
          </Link>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight truncate" data-testid="text-page-title">
              Manager overview
            </h1>
            <p className="text-xs text-muted-foreground truncate">SOLVE Platform™ - discovery training</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <div className="space-y-6">
          <Card className="border-2" style={{ borderColor: ORANGE }}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm text-muted-foreground">Your office invite code</p>
                <p className="text-2xl font-bold tracking-widest" data-testid="text-invite-code">
                  {data.office.inviteCode}
                </p>
              </div>
              <p className="text-xs text-muted-foreground max-w-xs">
                Share this code with your consultants so they can join{" "}
                <span className="font-medium">{data.office.name}</span> at sign-up.
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground font-normal">Sessions completed</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-semibold" data-testid="text-completed-count">
                  {data.stats.completed}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground font-normal">Average discovery score</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-semibold" data-testid="text-avg-score">
                  {data.stats.avgScore ?? "-"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground font-normal">In progress</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-semibold" data-testid="text-in-progress-count">
                  {data.stats.inProgress}
                </p>
              </CardContent>
            </Card>
          </div>

          <ConsultantRoster
            officeId={0}
            readOnlyData={{ consultants: data.consultants, details: data.details }}
          />
        </div>
      </main>
    </div>
  );
}

function DashboardDemoGate({ onVerified }: { onVerified: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const sendCode = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/dashboard-demo/request-code", { email });
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      setError(null);
      setResent(step === "code");
      setStep("code");
    },
    onError: (requestError: Error) => setError(errorMessage(requestError)),
  });

  const verifyCode = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/dashboard-demo/verify", { email, code });
      return response.json() as Promise<{ verified: true }>;
    },
    onSuccess: () => {
      setError(null);
      onVerified();
    },
    onError: (requestError: Error) => setError(errorMessage(requestError)),
  });

  return (
    <div className="min-h-dvh bg-background px-4 py-8">
      <div className="mx-auto max-w-md space-y-6">
        <div className="text-center">
          <div
            className="mx-auto inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold text-white"
            style={{ backgroundColor: NAVY }}
            data-testid="badge-dashboard-demo"
          >
            SOLVE Command Center demo
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight" data-testid="text-dashboard-demo-gate-heading">
            See what team progress looks like
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Verify your email to view the read-only Command Center demonstration. No password or account is required.
          </p>
        </div>

        <Card>
          <CardContent className="py-6">
            {step === "email" ? (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (email.trim()) sendCode.mutate();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="dashboard-demo-email">Work email</Label>
                  <Input
                    id="dashboard-demo-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    data-testid="input-dashboard-demo-email"
                  />
                </div>
                {error && <p className="text-sm text-destructive" data-testid="text-dashboard-demo-email-error">{error}</p>}
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!email.trim() || sendCode.isPending}
                  data-testid="button-dashboard-demo-send-code"
                >
                  {sendCode.isPending ? "Sending code..." : "Send my code"}
                </Button>
              </form>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (code.trim()) verifyCode.mutate();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="dashboard-demo-code">6-digit access code</Label>
                  <Input
                    id="dashboard-demo-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                    placeholder="Enter your 6-digit code"
                    maxLength={6}
                    data-testid="input-dashboard-demo-code"
                  />
                  <p className="text-sm text-muted-foreground">
                    We sent a code to <span className="font-medium text-foreground">{email}</span>. It expires in 10 minutes.
                  </p>
                </div>
                {error && <p className="text-sm text-destructive" data-testid="text-dashboard-demo-code-error">{error}</p>}
                {resent && !error && <p className="text-sm text-muted-foreground">A new code is on its way.</p>}
                <Button
                  type="submit"
                  className="w-full"
                  disabled={code.length !== 6 || verifyCode.isPending}
                  data-testid="button-dashboard-demo-verify-code"
                >
                  {verifyCode.isPending ? "Verifying..." : "View the demo"}
                </Button>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <button
                    type="button"
                    className="text-muted-foreground underline underline-offset-4"
                    onClick={() => {
                      setError(null);
                      setStep("email");
                    }}
                    data-testid="button-dashboard-demo-change-email"
                  >
                    Use a different email
                  </button>
                  <button
                    type="button"
                    className="text-primary underline underline-offset-4 disabled:opacity-50"
                    onClick={() => sendCode.mutate()}
                    disabled={sendCode.isPending}
                    data-testid="button-dashboard-demo-resend-code"
                  >
                    {sendCode.isPending ? "Sending..." : "Resend code"}
                  </button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DemoBanner() {
  return (
    <div
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 px-4 py-3 text-center text-sm text-white"
      style={{ backgroundColor: NAVY }}
      data-testid="banner-demo"
    >
      <span className="font-semibold" data-testid="text-demo-company-label">SOLVE DEMO COMPANY</span>
      <span className="text-white/80" data-testid="text-demo-fiction-label">
        ILLUSTRATIVE EXAMPLE DATA: ACME SALES, A FICTIONAL ACCOUNT
      </span>
      <Button
        asChild
        size="sm"
        className="bg-white text-[#0A1A30] hover:bg-white/90"
        data-testid="button-test-my-team"
      >
        <Link href="/signup">TEST MY TEAM</Link>
      </Button>
      <a
        href="mailto:hello@solveframework.com"
        className="inline-flex items-center rounded-md border border-white/70 px-3 py-1 text-xs font-semibold text-white transition-opacity hover:opacity-90"
        data-testid="link-ask-service-rep"
      >
        ASK A SERVICE REP
      </a>
    </div>
  );
}
