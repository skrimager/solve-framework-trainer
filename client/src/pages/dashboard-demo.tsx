import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { RosterReadOnlyData } from "@/components/consultant-roster";
import { CommandCenterSection, TeamSection, type CommandCenterExtras, type CommandCenterReadOnlyData, type DashboardStats, type DateRangeValue } from "@/pages/dashboard";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { LogoMark } from "@/pages/manager-login";
import chromeStyles from "@/pages/manager-login.module.css";

// Brand palette (shared with the rest of the app / marketing site).
const NAVY = "#0A1A30";
const ORANGE = "#E06D00";
const DASHBOARD_DEMO_QUERY_KEY = ["/api/public/demo-dashboard"];

type DemoDashboardResponse = {
  office: { name: string; inviteCode: string; subscriptionStatus: string };
  stats: { completed: number; avgScore: number | null; inProgress: number };
  commandCenter: {
    stats: DashboardStats;
    extras: CommandCenterExtras;
    readOnlyData: CommandCenterReadOnlyData;
  };
} & RosterReadOnlyData;

function errorMessage(error: Error): string {
  return error.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"(.*)"\}$/, "$1");
}

// Read-only Command Center demonstration. The protected data request returns
// null for a visitor without the dashboard-demo cookie, which renders the
// email-and-code gate instead of any sample company data.
export default function DemoDashboard() {
  const queryClient = useQueryClient();
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => ({
    since: new Date("2026-07-16T00:00:00.000Z"),
    until: new Date("2026-08-15T23:59:59.999Z"),
    preset: "30d",
  }));
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
    <div className="min-h-dvh" style={{ backgroundColor: "#050B18" }}>
      <DemoBanner />
      <header className="border-b" style={{ backgroundColor: "#0A1428", borderColor: "rgba(255,255,255,0.09)" }}>
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-4 sm:px-6">
          <Link
            href="/"
            className="shrink-0 inline-flex items-center rounded-[10px]"
            style={{ backgroundColor: "#050C1C", padding: "8px 16px" }}
            data-testid="link-home-logo"
          >
            <img
              src="/solve-wordmark-bigtag-transparent.png"
              alt="SOLVE Framework - Practice. Performance. Period."
              className="h-11 w-auto block"
              data-testid="img-solve-logo"
            />
          </Link>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-orange-300" data-testid="text-demo-read-only-label">
              Read-only Command Center
            </p>
            <h1 className="text-lg font-semibold leading-tight text-white truncate" data-testid="text-page-title">
              {data.office.name}
            </h1>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:py-8" data-testid="demo-command-center">
        <section className="space-y-6" aria-labelledby="demo-overview-heading" data-testid="section-demo-overview">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-300">Overview</p>
            <h2 id="demo-overview-heading" className="mt-1 text-xl font-bold text-white">What SOLVE is seeing</h2>
            <p className="mt-1 text-sm text-white/60">Team health, discovery performance, conversation outcomes, and coaching signals for Acme Sales.</p>
          </div>
          <CommandCenterSection
            stats={data.commandCenter.stats}
            statsLoading={false}
            extras={data.commandCenter.extras}
            extrasLoading={false}
            isManager={false}
            onGoToScenarios={() => undefined}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            earliestSessionAt={data.commandCenter.stats.earliestSessionAt}
            readOnlyData={data.commandCenter.readOnlyData}
          />
        </section>

        <section className="mt-10 border-t pt-8" style={{ borderColor: "rgba(255,255,255,0.09)" }} aria-labelledby="demo-people-heading" data-testid="section-demo-people">
          <div className="mb-6">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-300">People</p>
            <h2 id="demo-people-heading" className="mt-1 text-xl font-bold text-white">Consultant roster</h2>
            <p className="mt-1 text-sm text-white/60">View tier, certification, progress, conversations, score, and recent activity. Demo data is illustrative and cannot be changed.</p>
          </div>
          <TeamSection isManager={false} officeId={0} readOnlyData={{ consultants: data.consultants, details: data.details }} />
        </section>
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
    <main className={chromeStyles.page} data-testid="dashboard-demo-gate">
      <div className={`${chromeStyles.pageContent} ${chromeStyles.demoPageContent}`}>
        <header className={chromeStyles.brand}>
          <div className={chromeStyles.brandLockup}>
            <LogoMark />
            <div className={chromeStyles.brandName}>
              <div className={chromeStyles.solve}>
                SOLVE<span className={chromeStyles.period}>.</span>
              </div>
              <span className={chromeStyles.framework}>FRAMEWORK</span>
            </div>
          </div>
          <div className="mx-auto mb-4 inline-flex items-center rounded-full border border-orange-300/60 bg-[#0A1A30]/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange-100" data-testid="badge-dashboard-demo">
            SOLVE Command Center demo
          </div>
          <h1 className={chromeStyles.headline} data-testid="text-dashboard-demo-gate-heading">DASHBOARD DEMO</h1>
          <div className={chromeStyles.loginHeading}>DEMO ACCESS</div>
          <p className={chromeStyles.tagline}>See what team progress looks like</p>
        </header>

        <section className={`${chromeStyles.loginCard} ${chromeStyles.demoLoginCard}`} aria-labelledby="dashboard-demo-access-heading">
          <div className={chromeStyles.cardCorners} />
          <div className={chromeStyles.cardTitleRow}>
            <span className={chromeStyles.lockSymbol} aria-hidden="true" />
            <div>
              <h2 id="dashboard-demo-access-heading">VIEW THE DEMO</h2>
              <p>Verify your email to enter the read-only Command Center.</p>
            </div>
          </div>

          {step === "email" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (email.trim()) sendCode.mutate();
              }}
              noValidate
            >
              <div className={chromeStyles.formGroup}>
                <label htmlFor="dashboard-demo-email">Work email</label>
                <div className={chromeStyles.inputWrapper}>
                  <span className={chromeStyles.fieldIcon} aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M3 6h18v12H3z" /><path d="m3 7 9 6 9-6" /></svg>
                  </span>
                  <input
                    id="dashboard-demo-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    data-testid="input-dashboard-demo-email"
                  />
                </div>
              </div>
              <p className="mb-5 text-sm text-[#aab8cb]">No password or account is required.</p>
              {error && <p className={`${chromeStyles.statusMessage} ${chromeStyles.statusMessageVisible}`} data-testid="text-dashboard-demo-email-error">{error}</p>}
              <button
                type="submit"
                className={chromeStyles.submitButton}
                disabled={!email.trim() || sendCode.isPending}
                data-testid="button-dashboard-demo-send-code"
              >
                {sendCode.isPending ? "Sending code..." : "Send my code"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (code.trim()) verifyCode.mutate();
              }}
              noValidate
            >
              <div className={chromeStyles.formGroup}>
                <label htmlFor="dashboard-demo-code">6-digit access code</label>
                <div className={chromeStyles.inputWrapper}>
                  <span className={chromeStyles.fieldIcon} aria-hidden="true">
                    <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v3" /></svg>
                  </span>
                  <input
                    id="dashboard-demo-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                    placeholder="Enter your 6-digit code"
                    maxLength={6}
                    data-testid="input-dashboard-demo-code"
                  />
                </div>
                <p className="mt-3 text-sm text-[#aab8cb]">We sent a code to <span className="font-medium text-white">{email}</span>. It expires in 10 minutes.</p>
              </div>
              {error && <p className={`${chromeStyles.statusMessage} ${chromeStyles.statusMessageVisible}`} data-testid="text-dashboard-demo-code-error">{error}</p>}
              {resent && !error && <p className={`${chromeStyles.statusMessage} ${chromeStyles.statusMessageVisible}`}>A new code is on its way.</p>}
              <button
                type="submit"
                className={chromeStyles.submitButton}
                disabled={code.length !== 6 || verifyCode.isPending}
                data-testid="button-dashboard-demo-verify-code"
              >
                {verifyCode.isPending ? "Verifying..." : "View the demo"}
              </button>
              <div className={chromeStyles.formLinks}>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStep("email");
                  }}
                  data-testid="button-dashboard-demo-change-email"
                >
                  Use a different email
                </button>
                <span className={chromeStyles.formDivider} aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => sendCode.mutate()}
                  disabled={sendCode.isPending}
                  data-testid="button-dashboard-demo-resend-code"
                >
                  {sendCode.isPending ? "Sending..." : "Resend code"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </main>
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
