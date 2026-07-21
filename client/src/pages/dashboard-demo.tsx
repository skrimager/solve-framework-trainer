import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConsultantRoster, type RosterReadOnlyData } from "@/components/consultant-roster";

// Brand palette (shared with the rest of the app / marketing site).
const NAVY = "#0A1A30";
const ORANGE = "#E06D00";

// Where the persistent banner's "Request Access" button points. The marketing
// site's "Request Access" is a JS-triggered modal (no page anchor), so we link
// to the pricing section where the real Request Access buttons live.
const REQUEST_ACCESS_URL = "https://www.solveframework.com/#pricing";

type DemoDashboardResponse = {
  office: { name: string; inviteCode: string; subscriptionStatus: string };
  stats: { completed: number; avgScore: number | null; inProgress: number };
} & RosterReadOnlyData;

// Public, UNAUTHENTICATED read-only demo of the manager dashboard.
//
// Route: /#/dashboard-demo. It deliberately does NOT use AppShell (which reads
// the logged-in session and renders logout / into-the-app navigation) and does
// NOT call useAuth. All data comes from the public, no-auth endpoint
// GET /api/public/demo-dashboard, which serves only the seeded sample office.
// There is no create/edit/delete control anywhere on this page, and no link
// into the authenticated app.
export default function DemoDashboard() {
  const { data, isLoading } = useQuery<DemoDashboardResponse>({
    queryKey: ["/api/public/demo-dashboard"],
  });

  return (
    <div className="min-h-dvh bg-background">
      <DemoBanner />

      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
          <Link href="/" className="shrink-0 inline-flex items-center rounded-[10px]" style={{ backgroundColor: "#050C1C", padding: "8px 16px" }} data-testid="link-home-logo">
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
        {isLoading && <Skeleton className="h-64 rounded-lg" />}
        {!isLoading && data && (
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
              requesterId={0}
              readOnlyData={{ consultants: data.consultants, details: data.details }}
            />
          </div>
        )}
      </main>
    </div>
  );
}

// Persistent (sticky) top banner. Stays visible on scroll and carries the
// Request Access CTA out to the marketing site.
function DemoBanner() {
  return (
    <div
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-center text-sm text-white"
      style={{ backgroundColor: NAVY }}
      data-testid="banner-demo"
    >
      <span>
        Demo Dashboard — sample data. Request Access to set up your team.
      </span>
      <a
        href={REQUEST_ACCESS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center rounded-md px-3 py-1 text-xs font-semibold text-white transition-opacity hover:opacity-90"
        style={{ backgroundColor: ORANGE }}
        data-testid="button-request-access"
      >
        Request Access
      </a>
    </div>
  );
}
