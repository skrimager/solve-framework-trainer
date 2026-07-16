import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  LayoutDashboard,
  Users,
  ListChecks,
  Trophy,
  Flame,
  LogOut,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConsultantRoster } from "@/components/consultant-roster";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { verticalLabel } from "@/lib/verticals";
import type { Office, Scenario } from "@shared/schema";

// Manager command-center palette (matches manager-login.tsx and the manager
// dashboard chrome). Lime green is reserved exclusively for the admin vault and
// is intentionally never used here.
const NAVY_DEEP = "#05162D";
const NAVY = "#0A1A30";
const PANEL = "#0E2340";
const ORANGE = "#E06D00";
const ORANGE_LIGHT = "#F1830D";
const GRID = "rgba(255,255,255,0.08)";
const AXIS = "rgba(255,255,255,0.55)";

// Orange-family palette for the vertical donut. Deliberately no lime.
const DONUT_COLORS = [
  "#E06D00",
  "#F1830D",
  "#F5A93F",
  "#B85600",
  "#FFC680",
  "#8A4100",
  "#FFB25E",
  "#6B3200",
];

const ACTIVE_STATUSES = ["active", "trialing"];
function officeActive(office?: Office): boolean {
  return !!office && ACTIVE_STATUSES.includes(office.subscriptionStatus);
}

type DashboardStats = {
  period: { label: string; days: number; since: string };
  kpis: {
    teamAverageScore: number | null;
    practiceSessionsThisPeriod: number;
    certificationsEarned: number;
    activeConsultants: number;
    consultantCount: number;
  };
  scoreOverTime: { date: string; averageScore: number; sessions: number }[];
  discoveryDimensions: { key: string; label: string; average: number }[] | null;
  leaderboard: {
    id: number;
    displayName: string;
    averageScore: number | null;
    sessionsCompleted: number;
    tier: string;
  }[];
  levelDistribution: { tier: string; count: number }[];
  verticalBreakdown: { vertical: string; count: number }[];
  streaksAndRankings: {
    id: number;
    displayName: string;
    streak: number;
    rank: number | null;
    outOf: number;
  }[];
  totals: { completed: number; inProgress: number };
  academyCredits: { totalCents: number; availableCents: number; display: string };
};

type Section = "dashboard" | "team" | "scenarios" | "leaderboard";

const NAV: { key: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "team", label: "Team", icon: Users },
  { key: "scenarios", label: "Scenarios", icon: ListChecks },
  { key: "leaderboard", label: "Leaderboard", icon: Trophy },
];

// Shared by 'manager' and 'qa' roles (both review across consultants).
export default function Dashboard() {
  const { user, setUser } = useAuth();
  const [, navigate] = useLocation();
  const [section, setSection] = useState<Section>("dashboard");

  const { data: office } = useQuery<Office>({
    queryKey: [`/api/offices/${user?.officeId}`],
    enabled: !!user && user.role === "manager",
    // Poll while inactive so the dashboard unlocks moments after the Stripe
    // webhook grants access.
    refetchInterval: (query) => (officeActive(query.state.data as Office | undefined) ? false : 4000),
  });

  const { data: stats, isLoading: statsLoading, isError: statsError } = useQuery<DashboardStats>({
    queryKey: [`/api/manager/dashboard-stats?requesterId=${user?.id}`],
    enabled: !!user,
  });

  return (
    <div className="min-h-dvh flex flex-col lg:flex-row" style={{ backgroundColor: NAVY_DEEP }}>
      {/* Sidebar / top nav */}
      <aside
        className="lg:w-60 shrink-0 border-b lg:border-b-0 lg:border-r"
        style={{ backgroundColor: NAVY, borderColor: "rgba(255,255,255,0.08)" }}
      >
        <div className="flex items-center gap-3 px-4 py-4">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: PANEL, boxShadow: "0 6px 20px rgba(224,109,0,0.3)" }}
            aria-hidden="true"
          >
            <span className="text-lg font-bold" style={{ color: ORANGE_LIGHT }}>S</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white leading-tight truncate">Command Center</p>
            <div className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ backgroundColor: ORANGE_LIGHT, boxShadow: `0 0 6px ${ORANGE_LIGHT}` }}
                aria-hidden="true"
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/60">Live</span>
            </div>
          </div>
        </div>
        <nav className="flex lg:flex-col gap-1 px-2 pb-3 overflow-x-auto" aria-label="Manager sections">
          {NAV.map(({ key, label, icon: Icon }) => {
            const active = section === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSection(key)}
                aria-current={active ? "page" : undefined}
                data-testid={`nav-${key}`}
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors"
                style={
                  active
                    ? { backgroundColor: ORANGE, color: "white" }
                    : { color: "rgba(255,255,255,0.7)" }
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header
          className="flex items-center justify-between gap-4 px-4 sm:px-6 py-3 border-b"
          style={{ borderColor: "rgba(255,255,255,0.08)" }}
        >
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-white truncate" data-testid="text-page-title">
              {NAV.find((n) => n.key === section)?.label}
            </h1>
            <p className="text-xs text-white/50 truncate">SOLVE Platform - discovery training</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="https://solveframework.com"
              className="text-xs font-medium hidden sm:inline-flex items-center gap-1 hover:underline"
              style={{ color: ORANGE_LIGHT }}
              data-testid="link-back-to-solveframework"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to SOLVE Framework
            </a>
            <span className="text-xs text-white/50 hidden sm:inline" data-testid="text-current-user">
              {user?.displayName} · {user?.role}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="text-white/70 hover:text-white"
              onClick={() => {
                setUser(null);
                navigate("/");
              }}
              aria-label="Sign out"
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>

        <main className="flex-1 min-w-0 px-4 sm:px-6 py-6 space-y-6">
          {/* Billing gate stays at the top whenever a manager's office is inactive. */}
          {user?.role === "manager" && office && !officeActive(office) && <BillingCard office={office} />}

          {section === "dashboard" && (
            <DashboardSection
              stats={stats}
              loading={statsLoading}
              locked={statsError}
              office={office}
              isManager={user?.role === "manager"}
            />
          )}
          {section === "team" && (
            <TeamSection office={office} isManager={user?.role === "manager"} userId={user?.id} officeId={user?.officeId} />
          )}
          {section === "scenarios" && <ScenariosSection stats={stats} loading={statsLoading} locked={statsError} />}
          {section === "leaderboard" && <LeaderboardSection stats={stats} loading={statsLoading} locked={statsError} full />}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared panel primitives (dark command-center chrome).
// ---------------------------------------------------------------------------

function Panel({
  title,
  caption,
  children,
  className,
  testId,
}: {
  title?: string;
  caption?: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={`rounded-xl border p-4 sm:p-5 ${className ?? ""}`}
      style={{ backgroundColor: NAVY, borderColor: "rgba(255,255,255,0.1)" }}
      data-testid={testId}
    >
      {title && (
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {caption && <p className="text-xs text-white/45 mt-0.5">{caption}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

function EmptyState({ message, testId }: { message: string; testId?: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed py-10 text-center text-sm text-white/45"
      style={{ borderColor: "rgba(255,255,255,0.15)" }}
      data-testid={testId}
    >
      {message}
    </div>
  );
}

// Shown when the dashboard-stats endpoint reports the office is not entitled to
// the paid Manager Dashboard add-on (HTTP 403). A calm informational state, not
// a hard error or a pushy upsell.
function AddOnLocked() {
  return (
    <Panel testId="panel-dashboard-locked">
      <div className="py-8 text-center">
        <p className="text-sm font-medium text-white">Manager Dashboard add-on not active</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-white/50">
          Your office does not currently include the Manager Dashboard add-on, so team analytics,
          streaks, and rankings are unavailable.
        </p>
      </div>
    </Panel>
  );
}

function InitialsAvatar({ name, highlight }: { name: string; highlight?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{
        backgroundColor: highlight ? ORANGE : PANEL,
        color: "white",
        border: `1px solid ${highlight ? ORANGE_LIGHT : "rgba(255,255,255,0.15)"}`,
      }}
      aria-hidden="true"
    >
      {initials || "?"}
    </div>
  );
}

function chartTooltipStyle() {
  return {
    contentStyle: {
      backgroundColor: NAVY_DEEP,
      border: "1px solid rgba(255,255,255,0.2)",
      borderRadius: 8,
      color: "white",
      fontSize: 12,
    },
    labelStyle: { color: "rgba(255,255,255,0.7)" },
    itemStyle: { color: "white" },
  };
}

// ---------------------------------------------------------------------------
// Dashboard section: the full analytics view.
// ---------------------------------------------------------------------------

function DashboardSection({
  stats,
  loading,
  locked,
  office,
  isManager,
}: {
  stats?: DashboardStats;
  loading: boolean;
  locked?: boolean;
  office?: Office;
  isManager: boolean;
}) {
  if (locked) return <AddOnLocked />;
  if (loading || !stats) {
    return (
      <div className="space-y-6">
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    );
  }

  const { kpis } = stats;
  const kpiCards = [
    { label: "Team average score", value: kpis.teamAverageScore ?? "—", testId: "kpi-team-average" },
    { label: `Practice sessions (${stats.period.label.toLowerCase()})`, value: kpis.practiceSessionsThisPeriod, testId: "kpi-practice-sessions" },
    { label: "Certifications earned", value: kpis.certificationsEarned, testId: "kpi-certifications" },
    { label: "Active consultants", value: kpis.activeConsultants, testId: "kpi-active-consultants" },
    { label: "Conversations completed", value: stats.totals.completed, testId: "kpi-conversations-completed" },
    { label: "Academy Credits available", value: stats.academyCredits.display, testId: "kpi-academy-credits" },
  ];

  return (
    <div className="space-y-6">
      {isManager && office && officeActive(office) && <InviteCodeCard office={office} />}

      {/* 1. KPI strip */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-6" data-testid="kpi-strip">
        {kpiCards.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border p-4"
            style={{ backgroundColor: NAVY, borderColor: "rgba(255,255,255,0.1)" }}
            data-testid={c.testId}
          >
            <p className="text-[11px] uppercase tracking-wide text-white/45 leading-tight">{c.label}</p>
            <p className="mt-2 text-2xl font-bold text-white">{c.value}</p>
          </div>
        ))}
      </div>

      {/* 2. Team performance over time */}
      <Panel
        title="Team performance over time"
        caption="Average score of completed discovery sessions, by day"
        testId="panel-score-over-time"
      >
        {stats.scoreOverTime.length === 0 ? (
          <EmptyState message="No completed sessions yet" testId="empty-score-over-time" />
        ) : (
          <div className="h-72 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.scoreOverTime} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="date" tickFormatter={fmtShortDate} stroke={AXIS} tick={{ fontSize: 11 }} tickMargin={8} />
                <YAxis domain={[0, 100]} stroke={AXIS} tick={{ fontSize: 11 }} />
                <Tooltip {...chartTooltipStyle()} labelFormatter={fmtShortDate} />
                <Line
                  type="monotone"
                  dataKey="averageScore"
                  name="Avg score"
                  stroke={ORANGE_LIGHT}
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: ORANGE }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 3. Discovery skill radar (real persisted rubric dimensions) */}
        <Panel
          title="Discovery skill mastery"
          caption="Office average across the AI coach's five discovery dimensions"
          testId="panel-discovery-radar"
        >
          {!stats.discoveryDimensions ? (
            <EmptyState message="No scored discovery sessions yet" testId="empty-discovery-radar" />
          ) : (
            <div className="h-72 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={stats.discoveryDimensions} outerRadius="72%">
                  <PolarGrid stroke={GRID} />
                  <PolarAngleAxis dataKey="label" tick={{ fill: AXIS, fontSize: 10 }} />
                  <PolarRadiusAxis domain={[0, 100]} tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 9 }} axisLine={false} />
                  <Radar dataKey="average" name="Avg" stroke={ORANGE} fill={ORANGE} fillOpacity={0.45} />
                  <Tooltip {...chartTooltipStyle()} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        {/* 5. Certification tier distribution */}
        <Panel title="Consultants by tier" caption="Beginner, Intermediate, Advanced, Certified" testId="panel-level-distribution">
          {stats.kpis.consultantCount === 0 ? (
            <EmptyState message="No consultants have joined yet" testId="empty-level-distribution" />
          ) : (
            <div className="h-72 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.levelDistribution} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="tier" stroke={AXIS} tick={{ fontSize: 11 }} tickMargin={8} />
                  <YAxis allowDecimals={false} stroke={AXIS} tick={{ fontSize: 11 }} />
                  <Tooltip {...chartTooltipStyle()} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
                  <Bar dataKey="count" name="Consultants" fill={ORANGE} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 4. Top performers */}
        <Panel title="Top performers" caption="Ranked by average discovery score" testId="panel-top-performers">
          <Leaderboard leaderboard={stats.leaderboard} limit={5} />
        </Panel>

        {/* 6. Conversations by vertical */}
        <Panel title="Conversations by vertical" caption="Completed discovery sessions across verticals" testId="panel-vertical-breakdown">
          <VerticalBreakdown data={stats.verticalBreakdown} />
        </Panel>
      </div>

      {/* 7. Streaks & rankings */}
      <Panel
        title="Streaks & rankings"
        caption="Each consultant's current practice streak and office rank"
        testId="panel-streaks-rankings"
      >
        <StreaksAndRankings rows={stats.streaksAndRankings} />
      </Panel>
    </div>
  );
}

function StreaksAndRankings({ rows }: { rows: DashboardStats["streaksAndRankings"] }) {
  if (rows.length === 0) {
    return <EmptyState message="No consultants have joined yet" testId="empty-streaks-rankings" />;
  }
  return (
    <ul className="space-y-2" data-testid="list-streaks-rankings">
      {rows.map((r) => (
        <li
          key={r.id}
          className="flex items-center gap-3 rounded-lg px-3 py-2"
          style={{ backgroundColor: PANEL }}
          data-testid={`streaks-row-${r.id}`}
        >
          <span
            className="w-10 shrink-0 text-center text-sm font-bold"
            style={{ color: r.rank === 1 ? ORANGE_LIGHT : "rgba(255,255,255,0.5)" }}
          >
            {r.rank != null ? `#${r.rank}` : "-"}
          </span>
          <InitialsAvatar name={r.displayName} highlight={r.rank === 1} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{r.displayName}</p>
            <p className="text-xs text-white/45">Rank {r.rank != null ? `${r.rank} of ${r.outOf}` : "unranked"}</p>
          </div>
          <span
            className="flex items-center gap-1.5 text-sm font-semibold shrink-0"
            style={{ color: r.streak > 0 ? ORANGE_LIGHT : "rgba(255,255,255,0.4)" }}
          >
            <Flame className="h-4 w-4" aria-hidden="true" />
            {r.streak} {r.streak === 1 ? "day" : "days"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function VerticalBreakdown({ data }: { data: DashboardStats["verticalBreakdown"] }) {
  if (data.length === 0) {
    return <EmptyState message="No completed sessions yet" testId="empty-vertical-breakdown" />;
  }
  const pie = data.map((d) => ({ name: verticalLabel(d.vertical), value: d.count }));
  const total = pie.reduce((sum, p) => sum + p.value, 0);
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <div className="h-56 w-full sm:w-2/5 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={pie} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="none">
              {pie.map((_, i) => (
                <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip {...chartTooltipStyle()} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full sm:w-3/5 space-y-1.5" data-testid="list-vertical-legend">
        {pie.map((p, i) => (
          <li key={p.name} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
                aria-hidden="true"
              />
              <span className="text-white/75 line-clamp-2" title={p.name}>
                {p.name}
              </span>
            </span>
            <span className="text-white/50 shrink-0">
              {p.value} ({Math.round((p.value / total) * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Leaderboard({
  leaderboard,
  limit,
}: {
  leaderboard: DashboardStats["leaderboard"];
  limit?: number;
}) {
  const ranked = leaderboard.filter((l) => l.averageScore !== null);
  const rows = limit ? ranked.slice(0, limit) : leaderboard;
  if (ranked.length === 0) {
    return <EmptyState message="No scored sessions yet" testId="empty-leaderboard" />;
  }
  return (
    <ol className="space-y-2" data-testid="list-leaderboard">
      {rows.map((c, i) => (
        <li
          key={c.id}
          className="flex items-center gap-3 rounded-lg px-3 py-2"
          style={{ backgroundColor: PANEL }}
          data-testid={`leaderboard-row-${c.id}`}
        >
          <span className="w-5 text-center text-sm font-bold" style={{ color: i === 0 ? ORANGE_LIGHT : "rgba(255,255,255,0.5)" }}>
            {i + 1}
          </span>
          <InitialsAvatar name={c.displayName} highlight={i === 0} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white truncate">{c.displayName}</p>
            <p className="text-xs text-white/45">
              {c.tier} · {c.sessionsCompleted} {c.sessionsCompleted === 1 ? "conversation" : "conversations"}
            </p>
          </div>
          <span className="text-lg font-bold text-white shrink-0">
            {c.averageScore ?? "No sessions yet"}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Team section: the existing roster, on the command-center chrome.
// ---------------------------------------------------------------------------

function TeamSection({
  office,
  isManager,
  userId,
  officeId,
}: {
  office?: Office;
  isManager: boolean;
  userId?: number;
  officeId?: number;
}) {
  return (
    <div className="space-y-6">
      {isManager && office && officeActive(office) && <InviteCodeCard office={office} />}
      {userId != null && officeId != null && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
          <div className="[&_*]:!text-inherit">
            <ConsultantRoster officeId={officeId} requesterId={userId} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenarios section: real practice distribution across verticals.
// ---------------------------------------------------------------------------

function ScenariosSection({ stats, loading, locked }: { stats?: DashboardStats; loading: boolean; locked?: boolean }) {
  const { data: scenarios } = useQuery<Scenario[]>({ queryKey: ["/api/scenarios"] });

  if (locked) return <AddOnLocked />;
  if (loading || !stats) {
    return <Skeleton className="h-72 rounded-xl" />;
  }

  // Count available active scenarios per vertical (catalog breadth) alongside the
  // office's completed-session counts (usage). Both are real values.
  const catalogByVertical = new Map<string, number>();
  for (const s of scenarios ?? []) {
    catalogByVertical.set(s.vertical, (catalogByVertical.get(s.vertical) ?? 0) + 1);
  }
  const completedByVertical = new Map(stats.verticalBreakdown.map((v) => [v.vertical, v.count]));
  const verticals = new Set<string>([
    ...Array.from(catalogByVertical.keys()),
    ...Array.from(completedByVertical.keys()),
  ]);
  const rows = Array.from(verticals)
    .map((vertical) => ({
      vertical,
      catalog: catalogByVertical.get(vertical) ?? 0,
      completed: completedByVertical.get(vertical) ?? 0,
    }))
    .sort((a, b) => b.completed - a.completed || b.catalog - a.catalog);

  return (
    <Panel
      title="Scenario coverage"
      caption="Available practice scenarios and completed conversations, by vertical"
      testId="panel-scenarios"
    >
      {rows.length === 0 ? (
        <EmptyState message="No scenarios available yet" testId="empty-scenarios" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-scenarios">
            <thead>
              <tr className="text-left text-white/45 border-b" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
                <th className="py-2 pr-4 font-medium">Vertical</th>
                <th className="py-2 pr-4 font-medium text-right">Scenarios available</th>
                <th className="py-2 font-medium text-right">Conversations completed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.vertical} className="border-b last:border-0" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                  <td className="py-2 pr-4 text-white/85">{verticalLabel(r.vertical)}</td>
                  <td className="py-2 pr-4 text-right text-white/60">{r.catalog}</td>
                  <td className="py-2 text-right text-white/85 font-medium">{r.completed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard section: full ranked list.
// ---------------------------------------------------------------------------

function LeaderboardSection({ stats, loading, locked }: { stats?: DashboardStats; loading: boolean; locked?: boolean; full?: boolean }) {
  if (locked) return <AddOnLocked />;
  if (loading || !stats) {
    return <Skeleton className="h-72 rounded-xl" />;
  }
  return (
    <Panel title="Leaderboard" caption="Every consultant, ranked by average discovery score" testId="panel-leaderboard-full">
      <Leaderboard leaderboard={stats.leaderboard} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Invite code + billing (billing logic preserved from the prior dashboard).
// ---------------------------------------------------------------------------

function InviteCodeCard({ office }: { office: Office }) {
  return (
    <div
      className="rounded-xl border-2 flex flex-wrap items-center justify-between gap-3 px-5 py-4"
      style={{ borderColor: ORANGE, backgroundColor: NAVY }}
    >
      <div>
        <p className="text-xs uppercase tracking-wide text-white/45">Your office invite code</p>
        <p className="text-2xl font-bold tracking-widest text-white" data-testid="text-invite-code">
          {office.inviteCode}
        </p>
      </div>
      <p className="text-xs text-white/50 max-w-xs">
        Share this code with your consultants so they can join{" "}
        <span className="font-medium text-white/70">{office.name}</span> at sign-up.
      </p>
    </div>
  );
}

function BillingCard({ office }: { office: Office }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [busy, setBusy] = useState<null | "checkout" | "portal">(null);

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

  const isPastDue = ["past_due", "unpaid"].includes(office.subscriptionStatus);

  return (
    <div className="rounded-xl border-2 px-5 py-4 space-y-3" style={{ borderColor: ORANGE, backgroundColor: NAVY }}>
      <h2 className="text-lg font-semibold text-white">
        {isPastDue ? "Payment needed to restore access" : "Activate your subscription"}
      </h2>
      <p className="text-sm text-white/60" data-testid="text-billing-status">
        {isPastDue
          ? "Your latest payment failed, so practice is locked for your whole office until billing is brought current."
          : "Your office needs an active subscription before you or your consultants can start practicing."}
      </p>
      <Button
        onClick={() => redirectTo(isPastDue && office.stripeCustomerId ? "portal" : "checkout")}
        disabled={busy !== null}
        style={{ backgroundColor: ORANGE, color: "white" }}
        data-testid="button-activate-subscription"
      >
        {busy ? "Opening…" : isPastDue ? "Manage billing" : "Set up billing"}
      </Button>
    </div>
  );
}

function fmtShortDate(iso: string): string {
  // iso is a YYYY-MM-DD day key; render as "Mar 3" without pulling in a locale lib.
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[Number(parts[1]) - 1] ?? parts[1];
  return `${m} ${Number(parts[2])}`;
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
