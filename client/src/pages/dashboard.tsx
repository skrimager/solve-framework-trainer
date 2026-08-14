import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  AreaChart,
  Area,
} from "recharts";
import {
  LayoutDashboard,
  Users,
  ListChecks,
  Trophy,
  Flame,
  LogOut,
  ArrowLeft,
  ClipboardCheck,
  Mail,
  Settings,
  Bell,
  Radio,
  Medal,
  Award,
  Star,
  Crown,
  Sparkles,
  TrendingUp,
  TrendingDown,
  GraduationCap,
  MessageSquareText,
  FileBarChart,
  CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import type { DateRange } from "react-day-picker";
import { format as dateFnsFormat } from "date-fns";
import { ConsultantRoster } from "@/components/consultant-roster";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { verticalLabel } from "@/lib/verticals";
import { planForSeatCount } from "@shared/pricing";
import type { Office, Scenario } from "@shared/schema";

// ---------------------------------------------------------------------------
// Command Center palette. This is a manager-only, premium paid surface, so
// (unlike the rest of the app) the usual navy/orange-only rule is explicitly
// relaxed here: the reference "mission control" design uses a full colorful
// accent set (green/blue/orange/purple/gold) against a near-black base so the
// dashboard reads as valuable, exciting, data-rich real estate. Lime green is
// still reserved exclusively for the admin vault and is never used here.
// ---------------------------------------------------------------------------
const INK = "#050B18"; // page background, near-black
const NAVY_DEEP = "#0A1428"; // sidebar / header base
const NAVY = "#0F1D38"; // panel background
const PANEL = "#152847"; // nested row / chip background
const BORDER = "rgba(255,255,255,0.09)";
const GRID = "rgba(255,255,255,0.07)";
const AXIS = "rgba(255,255,255,0.5)";

const BLUE = "#3B82F6";
const BLUE_LIGHT = "#60A5FA";
const GREEN = "#22C55E";
const GREEN_LIGHT = "#4ADE80";
const ORANGE = "#F97316";
const ORANGE_LIGHT = "#FB923C";
const PURPLE = "#A855F7";
const PURPLE_LIGHT = "#C084FC";
const GOLD = "#EAB308";
const GOLD_LIGHT = "#FDE047";
const RED = "#EF4444";
const RED_LIGHT = "#F87171";

// Multi-color family for donuts / distributions so charts feel vivid rather
// than monochrome, matching the reference's colorful outcome donut and bars.
const VIVID_COLORS = [BLUE, GREEN, ORANGE, PURPLE, GOLD, RED, BLUE_LIGHT, GREEN_LIGHT];

const ACTIVE_STATUSES = ["active", "trialing"];
function officeActive(office?: Office): boolean {
  return !!office && ACTIVE_STATUSES.includes(office.subscriptionStatus);
}

type DashboardStats = {
  period: { label: string; days: number; since: string; until?: string };
  earliestSessionAt?: string | null;
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

// Additive Command Center widget data — see server buildCommandCenterExtras.
// Deliberately a separate query/type from DashboardStats so the original
// dashboard-stats response and its consumers are untouched.
type CommandCenterExtras = {
  teamHealth: { score: number | null; deltaPercent: number | null };
  conversations: { count: number; deltaPercent: number | null; sparkline: number[] };
  completionRate: { percent: number | null; deltaPercent: number | null };
  certifications: { count: number; deltaPercent: number | null };
  alerts: { id: number; displayName: string; reasons: ("inactive" | "lowScore")[] }[];
  liveFeed: {
    id: string;
    type: "certification" | "high_score" | "session_completed";
    userId: number;
    displayName: string;
    detail: string;
    occurredAt: string;
    sessionId: number | null;
  }[];
  performanceOverTime: { date: string; teamScore: number | null; top20: number | null }[];
  scoreDistribution: { band: string; count: number; percent: number }[];
  conversationOutcomes: { outcome: string; count: number }[];
  popularScenarios: {
    scenarioId: number;
    title: string;
    vertical: string;
    averageScore: number | null;
    sessionCount: number;
  }[];
  achievements: {
    id: string;
    userId: number;
    displayName: string;
    badge: "gold_achiever" | "silver_achiever" | "top_performer" | "role_play_master" | "streak_master";
    label: string;
    earnedAt: string | null;
  }[];
  summaryStrip: {
    teamMembersActive: number;
    totalSessions: number;
    avgScore: number | null;
    goalProgress: number | null;
    certificationsTotal: number;
    hoursTrainedThisPeriod: number;
  };
  widgetConfig: Record<string, boolean>;
};

// Mirrors server DASHBOARD_WIDGET_KEYS exactly (single source of truth lives
// server-side; kept in sync here for the settings UI labels/order/icons).
const DASHBOARD_WIDGET_KEYS = [
  "teamHealth",
  "conversations",
  "completionRate",
  "certifications",
  "alerts",
  "liveFeed",
  "performanceOverTime",
  "skillRadar",
  "topPerformers",
  "conversationOutcomes",
  "scoreDistribution",
  "achievements",
  "popularScenarios",
  "ctaPanel",
  "summaryStrip",
] as const;
type DashboardWidgetKey = (typeof DASHBOARD_WIDGET_KEYS)[number];

const WIDGET_LABELS: Record<DashboardWidgetKey, { label: string; caption: string }> = {
  teamHealth: { label: "Team Health Score", caption: "Composite score ring with week-over-week trend" },
  conversations: { label: "Conversations", caption: "Completed conversations this period, with sparkline" },
  completionRate: { label: "Completion Rate", caption: "Share of started sessions that finish" },
  certifications: { label: "Certifications Earned", caption: "New certifications this period" },
  alerts: { label: "Alerts", caption: "Consultants who need attention (inactive or scoring low)" },
  liveFeed: { label: "Live Feed", caption: "Recent certifications, high scores, and completed sessions" },
  performanceOverTime: { label: "Team Performance Over Time", caption: "Team average vs. your office's top 20%" },
  skillRadar: { label: "Skill Performance Summary", caption: "Radar of the five SOLVE discovery dimensions" },
  topPerformers: { label: "Top Performers", caption: "Ranked leaderboard by average score" },
  conversationOutcomes: { label: "Conversation Outcomes", caption: "Successful / converted / in progress / no outcome" },
  scoreDistribution: { label: "Score Distribution", caption: "Session counts across score bands" },
  achievements: { label: "Recent Achievements", caption: "Badges earned from real certifications, streaks, and scores" },
  popularScenarios: { label: "Popular Scenarios This Week", caption: "Most-practiced scenarios with average score" },
  ctaPanel: { label: "Elevate Your Team CTA", caption: "Shortcut panel to Training Center and team reports" },
  summaryStrip: { label: "Summary Strip", caption: "Bottom-of-page team totals" },
};

type Section = "dashboard" | "team" | "scenarios" | "leaderboard" | "settings";

const NAV: { key: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "team", label: "Team", icon: Users },
  { key: "scenarios", label: "Scenarios", icon: ListChecks },
  { key: "leaderboard", label: "Leaderboard", icon: Trophy },
  { key: "settings", label: "Dashboard Settings", icon: Settings },
];

// ---------------------------------------------------------------------------
// Command Center date range. Controls every widget on the dashboard (KPI
// cards, deltas, the performance-over-time chart, score distribution,
// conversation outcomes, live feed period-scoping, popular scenarios, etc).
// Defaults to the last 30 days on page load, per product requirements (a
// more useful default than the old hardcoded 7-day window, though 7 days
// remains one of the presets).
// ---------------------------------------------------------------------------
type DateRangeValue = { since: Date; until: Date; preset: DateRangePreset };
type DateRangePreset = "7d" | "30d" | "90d" | "all" | "custom";

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function daysAgo(n: number, now: Date): Date {
  return startOfDay(new Date(now.getTime() - n * 24 * 60 * 60 * 1000));
}

function defaultDateRange(now: Date = new Date()): DateRangeValue {
  return { since: daysAgo(29, now), until: endOfDay(now), preset: "30d" };
}

// Short "Mon D" formatter for range labels, e.g. "Mar 1" or "Aug 4". Uses
// date-fns (already a dependency elsewhere in this codebase) rather than a
// new formatting library.
function fmtRangeDate(d: Date): string {
  return dateFnsFormat(d, "MMM d");
}

// Human label for the currently selected range, shown in card/chart captions
// instead of a fixed "(last 7 days)" or "This week" string.
function rangeLabel(range: DateRangeValue): string {
  if (range.preset === "7d") return "Last 7 days";
  if (range.preset === "30d") return "Last 30 days";
  if (range.preset === "90d") return "Last 90 days";
  if (range.preset === "all") return "All time";
  return `${fmtRangeDate(range.since)} - ${fmtRangeDate(range.until)}`;
}

const DATE_RANGE_PRESETS: { key: DateRangePreset; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "all", label: "All time" },
];

function DateRangePicker({
  range,
  onChange,
  earliestSessionAt,
}: {
  range: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  earliestSessionAt: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>({ from: range.since, to: range.until });

  const applyPreset = (preset: DateRangePreset) => {
    const now = new Date();
    if (preset === "7d") return onChange({ since: daysAgo(6, now), until: endOfDay(now), preset });
    if (preset === "30d") return onChange({ since: daysAgo(29, now), until: endOfDay(now), preset });
    if (preset === "90d") return onChange({ since: daysAgo(89, now), until: endOfDay(now), preset });
    if (preset === "all") {
      const earliest = earliestSessionAt ? startOfDay(new Date(earliestSessionAt)) : daysAgo(29, now);
      return onChange({ since: earliest, until: endOfDay(now), preset });
    }
  };

  const applyCustomRange = () => {
    if (!draft?.from) return;
    const since = startOfDay(draft.from);
    const until = endOfDay(draft.to ?? draft.from);
    onChange({ since, until, preset: "custom" });
    setOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="control-date-range-picker">
      {DATE_RANGE_PRESETS.map(({ key, label }) => {
        const active = range.preset === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => applyPreset(key)}
            data-testid={`button-range-preset-${key}`}
            aria-pressed={active}
            className="rounded-md px-3 py-1.5 text-xs font-medium transition-colors border"
            style={
              active
                ? { backgroundColor: ORANGE, borderColor: ORANGE, color: "white" }
                : { backgroundColor: "transparent", borderColor: BORDER, color: "rgba(255,255,255,0.7)" }
            }
          >
            {label}
          </button>
        );
      })}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setDraft({ from: range.since, to: range.until });
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="button-range-custom"
            aria-pressed={range.preset === "custom"}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors border"
            style={
              range.preset === "custom"
                ? { backgroundColor: ORANGE, borderColor: ORANGE, color: "white" }
                : { backgroundColor: "transparent", borderColor: BORDER, color: "rgba(255,255,255,0.7)" }
            }
          >
            <CalendarDays className="w-3.5 h-3.5" />
            Custom
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0 border"
          align="start"
          style={{ backgroundColor: NAVY, borderColor: BORDER }}
          data-testid="popover-range-calendar"
        >
          <div className="text-white">
            <Calendar
              mode="range"
              numberOfMonths={2}
              defaultMonth={draft?.from}
              selected={draft}
              onSelect={setDraft}
              disabled={{ after: new Date() }}
              className="text-white"
            />
          </div>
          <div className="flex items-center justify-between gap-2 border-t p-3" style={{ borderColor: BORDER }}>
            <p className="text-xs text-white/50" data-testid="text-range-draft">
              {draft?.from ? fmtRangeDate(draft.from) : "Start date"}
              {" - "}
              {draft?.to ? fmtRangeDate(draft.to) : "End date"}
            </p>
            <Button size="sm" onClick={applyCustomRange} disabled={!draft?.from} data-testid="button-apply-range">
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// Shared by 'manager' and 'qa' roles (both review across consultants).
export default function Dashboard() {
  const { user, setUser } = useAuth();
  const [, navigate] = useLocation();
  const [section, setSection] = useState<Section>("dashboard");

  // Command Center date range. Defaults to the last 30 days on load; the
  // manager can switch to 7/90 days, all time, or a custom calendar range,
  // and every dashboard widget below re-scopes to it. Included in both query
  // keys below so switching the range triggers a refetch and each range is
  // cached separately (queryKey doubles as the literal fetch URL, see
  // getQueryFn in lib/queryClient.ts).
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => defaultDateRange());
  const sinceParam = dateRange.since.toISOString();
  const untilParam = dateRange.until.toISOString();

  const { data: office } = useQuery<Office>({
    queryKey: [`/api/offices/${user?.officeId}`],
    enabled: !!user && user.role === "manager",
    // Poll while inactive so the dashboard unlocks moments after the Stripe
    // webhook grants access.
    refetchInterval: (query) => (officeActive(query.state.data as Office | undefined) ? false : 4000),
  });

  const { data: stats, isLoading: statsLoading, isError: statsError } = useQuery<DashboardStats>({
    queryKey: [`/api/manager/dashboard-stats?since=${sinceParam}&until=${untilParam}`],
    enabled: !!user,
  });

  // Additive Command Center widgets. Kept as its own query (rather than
  // merged into dashboard-stats) so the original endpoint/response shape is
  // never touched. Same 403-on-no-add-on behavior as dashboard-stats.
  const { data: extras, isLoading: extrasLoading, isError: extrasError } = useQuery<CommandCenterExtras>({
    queryKey: [`/api/manager/dashboard-command-center?since=${sinceParam}&until=${untilParam}`],
    enabled: !!user,
  });

  return (
    <div className="min-h-dvh flex flex-col lg:flex-row" style={{ backgroundColor: INK }}>
      {/* Sidebar / top nav */}
      <aside
        className="lg:w-60 shrink-0 border-b lg:border-b-0 lg:border-r"
        style={{ backgroundColor: NAVY_DEEP, borderColor: BORDER }}
      >
        <div className="flex items-center gap-3 px-4 py-4">
          <img
            src="/solve-logo-square.png"
            alt="SOLVE Framework"
            className="w-9 h-9 rounded-lg shrink-0 object-contain"
            style={{ boxShadow: `0 6px 20px rgba(59,130,246,0.35)` }}
            data-testid="img-sidebar-logo"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white leading-tight truncate">Command Center</p>
            <div className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ backgroundColor: GREEN_LIGHT, boxShadow: `0 0 6px ${GREEN_LIGHT}` }}
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
                    ? { backgroundColor: BLUE, color: "white" }
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
          style={{ borderColor: BORDER }}
        >
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-white truncate" data-testid="text-page-title">
              {NAV.find((n) => n.key === section)?.label}
            </h1>
            <p className="text-xs text-white/50 truncate">SOLVE Platform - discovery training</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/real-conversations")}
              className="gap-1.5 bg-transparent text-white hover:text-white"
              style={{ borderColor: BLUE }}
              data-testid="link-nav-real-conversations"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Real Conversations</span>
            </Button>
            <a
              href="https://solveframework.com"
              className="text-xs font-medium hidden sm:inline-flex items-center gap-1 hover:underline"
              style={{ color: BLUE_LIGHT }}
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
              onClick={async () => {
                await apiRequest("POST", "/api/logout").catch(() => undefined);
                queryClient.clear();
                setUser(null);
                navigate("/command-center");
              }}
              aria-label="Sign out"
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>

        <main className="flex-1 min-w-0 px-4 sm:px-6 py-6 space-y-6">
          {/* Pending free-path offices show an activation notice instead of the
              billing card; they are activated by an admin, not via self-serve Stripe. */}
          {office?.status === "pending" && <PendingBanner />}
          {/* Billing gate stays at the top whenever a PAID manager's office is inactive. */}
          {user?.role === "manager" && office && office.status !== "pending" && !officeActive(office) && (
            <BillingCard office={office} />
          )}

          {section === "dashboard" && (
            <CommandCenterSection
              stats={stats}
              statsLoading={statsLoading}
              locked={statsError || extrasError}
              extras={extras}
              extrasLoading={extrasLoading}
              office={office}
              isManager={user?.role === "manager"}
              onGoToScenarios={() => setSection("scenarios")}
              dateRange={dateRange}
              onDateRangeChange={setDateRange}
              earliestSessionAt={stats?.earliestSessionAt}
            />
          )}
          {section === "team" && (
            <TeamSection office={office} isManager={user?.role === "manager"} userId={user?.id} officeId={user?.officeId} />
          )}
          {section === "scenarios" && (
            <ScenariosSection stats={stats} loading={statsLoading} locked={statsError} office={office} isManager={user?.role === "manager"} />
          )}
          {section === "leaderboard" && (
            <LeaderboardSection stats={stats} loading={statsLoading} locked={statsError} office={office} isManager={user?.role === "manager"} full />
          )}
          {section === "settings" && (
            <SettingsSection userId={user?.id} locked={statsError || extrasError} office={office} isManager={user?.role === "manager"} />
          )}
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
  accent,
}: {
  title?: string;
  caption?: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  accent?: string;
}) {
  return (
    <section
      className={`rounded-xl border p-4 sm:p-5 ${className ?? ""}`}
      style={{
        backgroundColor: NAVY,
        borderColor: accent ? `${accent}40` : BORDER,
        boxShadow: accent ? `0 0 0 1px ${accent}14` : undefined,
      }}
      data-testid={testId}
    >
      {title && (
        <div className="mb-4 flex items-center gap-2">
          {accent && (
            <span
              className="w-1.5 h-5 rounded-full shrink-0"
              style={{ backgroundColor: accent }}
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">{title}</h2>
            {caption && <p className="text-xs text-white/45 mt-0.5">{caption}</p>}
          </div>
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

// Shown when the office has not purchased the paid Manager Dashboard add-on
// (the dashboard-stats endpoint returns 403). Never a discouraging error: a
// friendly invitation showing what the dashboard unlocks, the monthly price at
// the office's tier, and a one-click "Add Dashboard" for managers. Consultants
// see the same invitation without the action.
function AddOnLocked({ office, isManager }: { office?: Office; isManager?: boolean }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const plan = planForSeatCount(office?.activeSeatCount ?? 1) ?? planForSeatCount(1);
  const priceLine = plan ? `$${plan.dashboardRate}/month` : "a flat monthly rate";

  async function addDashboard() {
    setBusy(true);
    try {
      await apiRequest("POST", "/api/billing/add-dashboard", { userId: user?.id });
      toast({
        title: "Manager Dashboard added",
        description: "Your team analytics are activating now.",
      });
      window.location.reload();
    } catch (err: any) {
      toast({ title: "Couldn't add the dashboard", description: humanError(err), variant: "destructive" });
      setBusy(false);
    }
  }

  return (
    <Panel testId="panel-dashboard-locked">
      <div className="py-8 text-center space-y-3">
        <p className="text-sm font-semibold text-white" data-testid="text-dashboard-upsell-title">
          See your whole team in one place
        </p>
        <p className="mx-auto max-w-md text-xs text-white/60">
          The Manager Dashboard brings every consultant's progress, scores, streaks, and rankings
          together so you can coach with confidence. Add it to your office for {priceLine}.
        </p>
        {isManager && (
          <Button
            type="button"
            onClick={addDashboard}
            disabled={busy}
            style={{ backgroundColor: BLUE, color: "white" }}
            data-testid="button-add-dashboard"
          >
            {busy ? "Adding…" : "Add Dashboard"}
          </Button>
        )}
      </div>
    </Panel>
  );
}

function InitialsAvatar({ name, highlight, color }: { name: string; highlight?: boolean; color?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
  const accent = color ?? BLUE;
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{
        backgroundColor: highlight ? accent : PANEL,
        color: "white",
        border: `1px solid ${highlight ? accent : "rgba(255,255,255,0.15)"}`,
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

// Small colored delta chip, e.g. "▲ 14%" in green or "▼ 6%" in red. Used
// across the KPI cards to match the reference's trend badges.
function DeltaBadge({ value, testId }: { value: number | null; testId?: string }) {
  if (value === null) {
    return (
      <span className="text-xs font-medium text-white/35" data-testid={testId}>
        No prior data
      </span>
    );
  }
  const up = value >= 0;
  const color = up ? GREEN_LIGHT : RED_LIGHT;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className="inline-flex items-center gap-1 text-base font-bold leading-none whitespace-nowrap"
      style={{ color }}
      data-testid={testId}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {up ? "+" : ""}
      {value}%
    </span>
  );
}

// Turns a raw alert record (id/displayName/reasons) into the human-readable
// sentences a manager actually needs, e.g. "Jordan Reyes hasn't practiced in
// 15+ days." A consultant with multiple reasons gets one line per reason.
function alertMessages(alert: CommandCenterExtras["alerts"][number]): string[] {
  return alert.reasons.map((reason) => {
    if (reason === "inactive") {
      return `${alert.displayName} hasn't practiced in 14+ days.`;
    }
    return `${alert.displayName}'s recent scores have dropped below the qualifying bar.`;
  });
}

// The ALERTS KPI card. Clicking it opens a modal listing what the alerts
// actually are, derived from real consultant data (session recency, score
// trend) already computed server-side in computeAlerts.
function AlertsCard({ alerts }: { alerts: CommandCenterExtras["alerts"] }) {
  const [open, setOpen] = useState(false);
  const rows = alerts.flatMap((a) => alertMessages(a).map((text, i) => ({ key: `${a.id}-${i}`, text })));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border p-4 flex flex-col justify-between lg:col-span-1 text-left w-full transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2"
        style={{ backgroundColor: NAVY, borderColor: `${RED}45` }}
        data-testid="kpi-alerts"
      >
        <div className="flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wide text-white/45 leading-tight">Alerts</p>
          <Bell className="w-3.5 h-3.5" style={{ color: RED_LIGHT }} />
        </div>
        <p className="text-2xl font-bold" style={{ color: RED_LIGHT }}>
          {alerts.length}
        </p>
        <p className="text-[11px] font-medium text-white/50">Needs your attention</p>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="border"
          style={{ backgroundColor: NAVY_DEEP, borderColor: BORDER, color: "white" }}
          data-testid="modal-alerts"
        >
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Bell className="w-4 h-4" style={{ color: RED_LIGHT }} />
              Alerts
            </DialogTitle>
            <DialogDescription className="text-white/55">
              Consultants who need a look, based on session recency and recent scores.
            </DialogDescription>
          </DialogHeader>
          {rows.length === 0 ? (
            <EmptyState message="No alerts right now, your team is on track." testId="empty-alerts-modal" />
          ) : (
            <ul className="space-y-2" data-testid="list-alerts-modal">
              {rows.map((r) => (
                <li
                  key={r.key}
                  className="rounded-lg px-3 py-2.5 text-sm text-white/85"
                  style={{ backgroundColor: PANEL }}
                  data-testid={`alert-row-${r.key}`}
                >
                  {r.text}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length === 0) return null;
  const points = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-8 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.5} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={`url(#spark-${color.replace("#", "")})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Ring gauge for Team Health Score: a 0-100 composite drawn with plain SVG
// (no extra chart library needed) so it exactly matches the reference's
// circular score dial.
function RingGauge({ value, size = 76, color = GREEN_LIGHT }: { value: number | null; size?: number; color?: string }) {
  const radius = (size - 10) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - pct / 100);
  const center = size / 2;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} data-testid="ring-team-health">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={7} />
        {value !== null && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={7}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ filter: `drop-shadow(0 0 6px ${color}80)` }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xl font-bold text-white">{value ?? "—"}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command Center dashboard section: the full 15-widget mission-control view.
// Respects the office's saved widgetConfig (missing keys default visible).
// ---------------------------------------------------------------------------

function CommandCenterSection({
  stats,
  statsLoading,
  locked,
  extras,
  extrasLoading,
  office,
  isManager,
  onGoToScenarios,
  dateRange,
  onDateRangeChange,
  earliestSessionAt,
}: {
  stats?: DashboardStats;
  statsLoading: boolean;
  locked?: boolean;
  extras?: CommandCenterExtras;
  extrasLoading: boolean;
  office?: Office;
  isManager: boolean;
  onGoToScenarios: () => void;
  dateRange: DateRangeValue;
  onDateRangeChange: (next: DateRangeValue) => void;
  earliestSessionAt?: string | null;
}) {
  const rangeControl = (
    <DateRangePicker range={dateRange} onChange={onDateRangeChange} earliestSessionAt={earliestSessionAt} />
  );

  if (locked) return <AddOnLocked office={office} isManager={isManager} />;

  const loading = statsLoading || extrasLoading || !stats || !extras;
  if (loading) {
    return (
      <div className="space-y-6">
        {rangeControl}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-72 rounded-xl lg:col-span-2" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    );
  }

  const cfg = extras.widgetConfig ?? {};
  const show = (key: DashboardWidgetKey) => cfg[key] !== false;
  const label = rangeLabel(dateRange);

  return (
    <div className="space-y-6">
      {rangeControl}
      {isManager && office && officeActive(office) && <InviteCodeCard office={office} />}

      {/* Row 1: KPI cards (Team Health, Conversations, Completion Rate, Certifications, Alerts) */}
      {(show("teamHealth") || show("conversations") || show("completionRate") || show("certifications") || show("alerts") || show("liveFeed")) && (
        <div className="grid gap-4 lg:grid-cols-6" data-testid="row-kpi-cards">
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-4 lg:col-span-5 lg:grid-cols-4">
            {show("teamHealth") && (
              <div className="rounded-xl border p-4" style={{ backgroundColor: NAVY, borderColor: `${GREEN}30` }} data-testid="kpi-team-health">
                <p className="text-[11px] uppercase tracking-wide text-white/45 leading-tight">Team Health Score</p>
                <div className="mt-2 flex items-center gap-3">
                  <RingGauge value={extras.teamHealth.score} color={GREEN_LIGHT} />
                  <div className="min-w-0">
                    <DeltaBadge value={extras.teamHealth.deltaPercent} testId="delta-team-health" />
                  </div>
                </div>
              </div>
            )}
            {show("conversations") && (
              <div className="rounded-xl border p-4" style={{ backgroundColor: NAVY, borderColor: `${BLUE}30` }} data-testid="kpi-conversations">
                <p className="text-[11px] uppercase tracking-wide text-white/45 leading-tight">Conversations</p>
                <p className="mt-2 text-2xl font-bold text-white">{extras.conversations.count}</p>
                <div className="mt-1">
                  <DeltaBadge value={extras.conversations.deltaPercent} testId="delta-conversations" />
                </div>
                <div className="mt-2">
                  <Sparkline data={extras.conversations.sparkline} color={BLUE_LIGHT} />
                </div>
              </div>
            )}
            {show("completionRate") && (
              <div className="rounded-xl border p-4" style={{ backgroundColor: NAVY, borderColor: `${PURPLE}30` }} data-testid="kpi-completion-rate">
                <p className="text-[11px] uppercase tracking-wide text-white/45 leading-tight">Completion Rate</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {extras.completionRate.percent !== null ? `${extras.completionRate.percent}%` : "—"}
                </p>
                <div className="mt-1">
                  <DeltaBadge value={extras.completionRate.deltaPercent} testId="delta-completion-rate" />
                </div>
              </div>
            )}
            {show("certifications") && (
              <div className="rounded-xl border p-4" style={{ backgroundColor: NAVY, borderColor: `${GOLD}30` }} data-testid="kpi-certifications-earned">
                <p className="text-[11px] uppercase tracking-wide text-white/45 leading-tight">Certifications Earned</p>
                <p className="mt-2 text-2xl font-bold text-white">{extras.certifications.count}</p>
                <div className="mt-1">
                  <DeltaBadge value={extras.certifications.deltaPercent} testId="delta-certifications" />
                </div>
              </div>
            )}
          </div>
          {show("alerts") && <AlertsCard alerts={extras.alerts} />}
        </div>
      )}

      {/* Row 2: Team performance over time + Live Feed */}
      {(show("performanceOverTime") || show("liveFeed")) && (
        <div className="grid gap-6 lg:grid-cols-3">
          {show("performanceOverTime") && (
            <Panel
              title="Team performance over time"
              caption={`Team average vs. your office's top 20% (${label})`}
              testId="panel-performance-over-time"
              accent={BLUE}
              className="lg:col-span-2"
            >
              {extras.performanceOverTime.every((d) => d.teamScore === null && d.top20 === null) ? (
                <EmptyState message="No completed sessions yet" testId="empty-performance-over-time" />
              ) : (
                <div className="h-72 min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={extras.performanceOverTime} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
                      <CartesianGrid stroke={GRID} vertical={false} />
                      <XAxis dataKey="date" tickFormatter={fmtShortDate} stroke={AXIS} tick={{ fontSize: 11 }} tickMargin={8} />
                      <YAxis domain={[0, 100]} stroke={AXIS} tick={{ fontSize: 11 }} />
                      <Tooltip {...chartTooltipStyle()} labelFormatter={fmtShortDate} />
                      <Line
                        type="monotone"
                        dataKey="teamScore"
                        name="Team Score"
                        stroke={BLUE_LIGHT}
                        strokeWidth={2.5}
                        dot={{ r: 3, fill: BLUE }}
                        activeDot={{ r: 5 }}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="top20"
                        name="Top 20%"
                        stroke={GREEN_LIGHT}
                        strokeWidth={2}
                        strokeDasharray="4 3"
                        dot={{ r: 2.5, fill: GREEN }}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Panel>
          )}
          {show("liveFeed") && (
            <Panel title="Live Feed" caption="Recent activity across your office" testId="panel-live-feed" accent={GREEN}>
              <LiveFeedList events={extras.liveFeed} />
            </Panel>
          )}
        </div>
      )}

      {/* Row 3: Skill radar + Top performers */}
      {(show("skillRadar") || show("topPerformers")) && (
        <div className="grid gap-6 lg:grid-cols-2">
          {show("skillRadar") && (
            <Panel
              title="Skill Performance Summary"
              caption="Office average across the five SOLVE discovery dimensions"
              testId="panel-discovery-radar"
              accent={BLUE}
            >
              {!stats?.discoveryDimensions ? (
                <EmptyState message="No scored discovery sessions yet" testId="empty-discovery-radar" />
              ) : (
                <div className="h-72 min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart data={stats.discoveryDimensions} outerRadius="72%">
                      <PolarGrid stroke={GRID} />
                      <PolarAngleAxis dataKey="label" tick={{ fill: AXIS, fontSize: 10 }} />
                      <PolarRadiusAxis domain={[0, 100]} tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 9 }} axisLine={false} />
                      <Radar dataKey="average" name="Avg" stroke={BLUE_LIGHT} fill={BLUE} fillOpacity={0.45} />
                      <Tooltip {...chartTooltipStyle()} />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Panel>
          )}
          {show("topPerformers") && (
            <Panel title="Top Performers" caption="Ranked by average discovery score" testId="panel-top-performers" accent={GREEN}>
              <Leaderboard leaderboard={stats?.leaderboard ?? []} limit={5} />
            </Panel>
          )}
        </div>
      )}

      {/* Row 4: Conversation outcomes, Score distribution, Recent achievements */}
      {(show("conversationOutcomes") || show("scoreDistribution") || show("achievements")) && (
        <div className="grid gap-6 lg:grid-cols-3">
          {show("conversationOutcomes") && (
            <Panel title="Conversation Outcomes" caption={`Completed conversations, ${label}`} testId="panel-conversation-outcomes" accent={PURPLE}>
              <ConversationOutcomesDonut data={extras.conversationOutcomes} />
            </Panel>
          )}
          {show("scoreDistribution") && (
            <Panel title="Score Distribution" caption={`Sessions by score band, ${label}`} testId="panel-score-distribution" accent={ORANGE}>
              <ScoreDistributionChart data={extras.scoreDistribution} />
            </Panel>
          )}
          {show("achievements") && (
            <Panel title="Recent Achievements" caption="Earned from real certifications, streaks, and scores" testId="panel-achievements" accent={GOLD}>
              <AchievementsGrid achievements={extras.achievements} />
            </Panel>
          )}
        </div>
      )}

      {/* Row 5: Popular scenarios + CTA panel */}
      {(show("popularScenarios") || show("ctaPanel")) && (
        <div className="grid gap-6 lg:grid-cols-3">
          {show("popularScenarios") && (
            <Panel
              title={`Popular Scenarios (${label})`}
              caption="Most-practiced scenarios and their average score"
              testId="panel-popular-scenarios"
              accent={BLUE}
              className="lg:col-span-2"
            >
              <PopularScenariosGrid scenarios={extras.popularScenarios} />
            </Panel>
          )}
          {show("ctaPanel") && <ElevateTeamCta onGoToScenarios={onGoToScenarios} />}
        </div>
      )}

      {/* Row 6: Bottom summary strip */}
      {show("summaryStrip") && <SummaryStrip data={extras.summaryStrip} label={label} />}
    </div>
  );
}

function LiveFeedList({ events }: { events: CommandCenterExtras["liveFeed"] }) {
  const [openSessionId, setOpenSessionId] = useState<number | null>(null);
  if (events.length === 0) {
    return <EmptyState message="No recent activity yet" testId="empty-live-feed" />;
  }
  const iconFor = (type: CommandCenterExtras["liveFeed"][number]["type"]) => {
    if (type === "certification") return { Icon: Award, color: GOLD_LIGHT };
    if (type === "high_score") return { Icon: Star, color: PURPLE_LIGHT };
    return { Icon: MessageSquareText, color: BLUE_LIGHT };
  };
  return (
    <>
      <ul className="space-y-2 max-h-[22rem] overflow-y-auto pr-1" data-testid="list-live-feed">
        {events.map((e) => {
          const { Icon, color } = iconFor(e.type);
          const clickable = e.sessionId !== null;
          return (
            <li key={e.id}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && setOpenSessionId(e.sessionId)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                  clickable ? "cursor-pointer hover:brightness-110 focus:outline-none focus-visible:ring-2" : "cursor-default"
                }`}
                style={{ backgroundColor: PANEL }}
                data-testid={`live-feed-row-${e.id}`}
              >
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${color}22`, color }}
                  aria-hidden="true"
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-white truncate">{e.displayName}</p>
                  <p className="text-xs text-white/55 truncate">{e.detail}</p>
                </div>
                <span className="shrink-0 text-[10px] text-white/35 whitespace-nowrap">{fmtRelativeTime(e.occurredAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <SessionDetailModal sessionId={openSessionId} onClose={() => setOpenSessionId(null)} />
    </>
  );
}

type ManagerSessionDetail = {
  id: number;
  consultantId: number;
  consultantName: string;
  scenarioTitle: string;
  vertical: string | null;
  status: string;
  score: number | null;
  rubricScores: Record<string, number> | null;
  feedback: string | null;
  createdAt: string;
  completedAt: string | null;
};

const ALL_RUBRIC_LABELS: Record<string, string> = {
  // Consulting/discovery rubric (the five SOLVE dimensions).
  needsDiscovery: "Needs Discovery",
  objectionPrevention: "Objection Prevention",
  trustBuilding: "Trust Building",
  naturalClose: "Natural Close",
  relationshipContinuity: "Relationship Continuity",
  // Leadership / conflict-management rubric.
  activeListening: "Active Listening",
  empathyAcknowledgment: "Empathy Acknowledgment",
  rootCauseDiscovery: "Root Cause Discovery",
  solutionVisualization: "Solution Visualization",
  blamelessResolution: "Blameless Resolution",
};

function fmtFullDate(iso: string | null): string {
  if (!iso) return "Not completed";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not completed";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Session detail modal opened from a Live Feed entry. Fetches the full,
// untruncated session record from the manager-scoped endpoint (own-office
// consultants only, see GET /api/manager/session/:id in server/routes.ts).
function SessionDetailModal({ sessionId, onClose }: { sessionId: number | null; onClose: () => void }) {
  const { user } = useAuth();
  const { data, isLoading, isError } = useQuery<ManagerSessionDetail>({
    queryKey: [`/api/manager/session/${sessionId}`],
    enabled: sessionId !== null && !!user,
  });

  return (
    <Dialog open={sessionId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="border max-h-[85vh] overflow-y-auto"
        style={{ backgroundColor: NAVY_DEEP, borderColor: BORDER, color: "white" }}
        data-testid="modal-session-detail"
      >
        <DialogHeader>
          <DialogTitle className="text-white">Session detail</DialogTitle>
          <DialogDescription className="text-white/55">
            Full scenario, score, and rubric breakdown for this completed session.
          </DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-48 rounded-lg" />}
        {isError && (
          <p className="text-sm text-white/60" data-testid="text-session-detail-error">
            Couldn't load this session. It may belong to a different office.
          </p>
        )}
        {data && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-white" data-testid="text-session-detail-consultant">
                {data.consultantName}
              </p>
              <p className="text-sm text-white/70" data-testid="text-session-detail-scenario">
                {data.scenarioTitle}
              </p>
              <p className="text-xs text-white/40 mt-1" data-testid="text-session-detail-completed-at">
                Completed {fmtFullDate(data.completedAt)}
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-lg px-3 py-2.5" style={{ backgroundColor: PANEL }}>
              <span className="text-xs uppercase tracking-wide text-white/45">Score</span>
              <span className="text-2xl font-bold" style={{ color: GREEN_LIGHT }} data-testid="text-session-detail-score">
                {data.score ?? "—"}
              </span>
            </div>
            {data.rubricScores && (
              <div>
                <p className="text-xs uppercase tracking-wide text-white/45 mb-2">Rubric breakdown</p>
                <ul className="space-y-1.5" data-testid="list-session-detail-rubric">
                  {Object.entries(data.rubricScores).map(([key, value]) => (
                    <li key={key} className="flex items-center justify-between text-sm">
                      <span className="text-white/70">{ALL_RUBRIC_LABELS[key] ?? key}</span>
                      <span className="font-semibold text-white">{value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.feedback && (
              <div>
                <p className="text-xs uppercase tracking-wide text-white/45 mb-1">Feedback</p>
                <p className="text-sm text-white/70 whitespace-pre-wrap">{data.feedback}</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConversationOutcomesDonut({ data }: { data: CommandCenterExtras["conversationOutcomes"] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) {
    return <EmptyState message="No completed conversations yet" testId="empty-conversation-outcomes" />;
  }
  const OUTCOME_COLORS: Record<string, string> = {
    Successful: GREEN_LIGHT,
    Converted: BLUE_LIGHT,
    "In Progress": ORANGE_LIGHT,
    "No Outcome": PURPLE_LIGHT,
  };
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative h-48 w-48">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="outcome"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={3}
              stroke="none"
            >
              {data.map((d) => (
                <Cell key={d.outcome} fill={OUTCOME_COLORS[d.outcome] ?? BLUE} />
              ))}
            </Pie>
            <Tooltip {...chartTooltipStyle()} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-white" data-testid="text-outcomes-total">
            {total}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-white/45">Total</span>
        </div>
      </div>
      <ul className="w-full space-y-1.5" data-testid="list-outcomes-legend">
        {data.map((d) => (
          <li key={d.outcome} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: OUTCOME_COLORS[d.outcome] ?? BLUE }}
                aria-hidden="true"
              />
              <span className="text-white/75">{d.outcome}</span>
            </span>
            <span className="text-white/50 shrink-0">
              {d.count} ({total > 0 ? Math.round((d.count / total) * 100) : 0}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScoreDistributionChart({ data }: { data: CommandCenterExtras["scoreDistribution"] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) {
    return <EmptyState message="No scored sessions yet" testId="empty-score-distribution" />;
  }
  const BAND_COLORS = [RED_LIGHT, ORANGE_LIGHT, GOLD_LIGHT, BLUE_LIGHT, GREEN_LIGHT];
  return (
    <div className="h-72 min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 16, right: 12, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="band" stroke={AXIS} tick={{ fontSize: 11 }} tickMargin={8} />
          <YAxis allowDecimals={false} stroke={AXIS} tick={{ fontSize: 11 }} />
          <Tooltip {...chartTooltipStyle()} cursor={{ fill: "rgba(255,255,255,0.05)" }} formatter={(value: any, name: any, item: any) => [`${value} (${item.payload.percent}%)`, "Sessions"]} />
          <Bar dataKey="count" name="Sessions" radius={[4, 4, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={BAND_COLORS[i % BAND_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const BADGE_ICON: Record<
  CommandCenterExtras["achievements"][number]["badge"],
  { Icon: typeof Award; color: string }
> = {
  gold_achiever: { Icon: Award, color: GOLD_LIGHT },
  silver_achiever: { Icon: Medal, color: "#CBD5E1" },
  top_performer: { Icon: Crown, color: ORANGE_LIGHT },
  role_play_master: { Icon: Sparkles, color: PURPLE_LIGHT },
  streak_master: { Icon: Flame, color: RED_LIGHT },
};

function AchievementsGrid({ achievements }: { achievements: CommandCenterExtras["achievements"] }) {
  if (achievements.length === 0) {
    return <EmptyState message="No achievements earned yet" testId="empty-achievements" />;
  }
  return (
    <div className="grid grid-cols-4 gap-3" data-testid="grid-achievements">
      {achievements.slice(0, 8).map((a) => {
        const { Icon, color } = BADGE_ICON[a.badge];
        return (
          <div key={a.id} className="flex flex-col items-center gap-1.5 text-center" data-testid={`achievement-${a.id}`}>
            <span
              className="flex h-11 w-11 items-center justify-center rounded-full"
              style={{ backgroundColor: `${color}1F`, border: `1.5px solid ${color}66` }}
              aria-hidden="true"
            >
              <Icon className="h-5 w-5" style={{ color }} />
            </span>
            <p className="text-[10px] leading-tight text-white/70 truncate w-full" title={a.displayName}>
              {a.displayName.split(" ")[0]}
            </p>
            <p className="text-[9px] leading-tight text-white/40 truncate w-full" title={a.label}>
              {a.label}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function PopularScenariosGrid({ scenarios }: { scenarios: CommandCenterExtras["popularScenarios"] }) {
  if (scenarios.length === 0) {
    return <EmptyState message="No practice sessions this period yet" testId="empty-popular-scenarios" />;
  }
  const ACCENTS = [PURPLE, BLUE, GREEN, ORANGE, GOLD];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" data-testid="grid-popular-scenarios">
      {scenarios.map((s, i) => (
        <div
          key={s.scenarioId}
          className="rounded-lg border p-3 flex flex-col gap-2"
          style={{ backgroundColor: PANEL, borderColor: `${ACCENTS[i % ACCENTS.length]}40` }}
          data-testid={`scenario-card-${s.scenarioId}`}
        >
          <span
            className="inline-flex w-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: `${ACCENTS[i % ACCENTS.length]}25`, color: ACCENTS[i % ACCENTS.length] }}
          >
            {verticalLabel(s.vertical)}
          </span>
          <p className="text-xs font-medium text-white leading-snug line-clamp-2" title={s.title}>
            {s.title}
          </p>
          <div className="mt-auto flex items-center justify-between text-[11px]">
            <span className="font-semibold text-white">{s.averageScore ?? "—"} avg</span>
            <span className="text-white/45">
              {s.sessionCount} {s.sessionCount === 1 ? "session" : "sessions"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ElevateTeamCta({ onGoToScenarios }: { onGoToScenarios: () => void }) {
  return (
    <div
      className="rounded-xl border p-5 flex flex-col justify-between gap-4 relative overflow-hidden"
      style={{
        background: `radial-gradient(120% 140% at 100% 0%, ${BLUE}33 0%, ${NAVY} 60%)`,
        borderColor: `${BLUE}45`,
      }}
      data-testid="panel-cta-elevate-team"
    >
      <div
        className="pointer-events-none absolute -right-6 -bottom-6 h-32 w-32 rounded-full"
        style={{ background: `radial-gradient(circle, ${BLUE_LIGHT}55, transparent 70%)`, filter: "blur(2px)" }}
        aria-hidden="true"
      />
      <div className="relative">
        <h3 className="text-sm font-bold uppercase tracking-wide text-white">Ready to elevate your team?</h3>
        <p className="mt-1.5 text-xs text-white/60">
          Assign training, track progress, and unlock your team's full potential.
        </p>
      </div>
      <div className="relative flex flex-col gap-2">
        <Button
          type="button"
          onClick={onGoToScenarios}
          className="gap-1.5 justify-start"
          style={{ backgroundColor: BLUE, color: "white" }}
          data-testid="button-go-training-center"
        >
          <GraduationCap className="h-4 w-4" />
          Go to Training Center
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-1.5 justify-start bg-transparent text-white hover:text-white"
          style={{ borderColor: "rgba(255,255,255,0.25)" }}
          data-testid="button-generate-team-report"
        >
          <FileBarChart className="h-4 w-4" />
          Generate Team Report
        </Button>
      </div>
    </div>
  );
}

function SummaryStrip({ data, label }: { data: CommandCenterExtras["summaryStrip"]; label: string }) {
  const items: { label: string; value: string; sub?: string; color: string }[] = [
    { label: "Team Members", value: String(data.teamMembersActive), sub: "Active users", color: BLUE_LIGHT },
    { label: "Total Sessions", value: String(data.totalSessions), sub: "All time", color: GREEN_LIGHT },
    { label: "Avg Score", value: data.avgScore !== null ? String(data.avgScore) : "—", sub: label, color: ORANGE_LIGHT },
    { label: "Goal Progress", value: data.goalProgress !== null ? `${data.goalProgress}%` : "—", sub: "Team health", color: PURPLE_LIGHT },
    { label: "Certifications", value: String(data.certificationsTotal), sub: "Total earned", color: GOLD_LIGHT },
    { label: "Hours Trained", value: String(data.hoursTrainedThisPeriod), sub: label, color: RED_LIGHT },
  ];
  return (
    <div
      className="rounded-xl border grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-y sm:divide-y-0"
      style={{ backgroundColor: NAVY, borderColor: BORDER }}
      data-testid="panel-summary-strip"
    >
      {items.map((it) => (
        <div key={it.label} className="p-4 text-center" style={{ borderColor: BORDER }}>
          <p className="text-lg font-bold" style={{ color: it.color }}>
            {it.value}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-white/45 mt-0.5">{it.label}</p>
          {it.sub && <p className="text-[10px] text-white/30">{it.sub}</p>}
        </div>
      ))}
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
            style={{ color: r.rank === 1 ? GOLD_LIGHT : "rgba(255,255,255,0.5)" }}
          >
            {r.rank != null ? `#${r.rank}` : "-"}
          </span>
          <InitialsAvatar name={r.displayName} highlight={r.rank === 1} color={GOLD} />
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
                <Cell key={i} fill={VIVID_COLORS[i % VIVID_COLORS.length]} />
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
                style={{ backgroundColor: VIVID_COLORS[i % VIVID_COLORS.length] }}
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
  const maxScore = Math.max(...rows.map((r) => r.averageScore ?? 0), 1);
  const RANK_COLORS = [GOLD_LIGHT, "#CBD5E1", "#D97757", GREEN_LIGHT, BLUE_LIGHT];
  return (
    <ol className="space-y-2.5" data-testid="list-leaderboard">
      {rows.map((c, i) => (
        <li key={c.id} className="flex items-center gap-3" data-testid={`leaderboard-row-${c.id}`}>
          <span className="w-5 text-center text-sm font-bold" style={{ color: RANK_COLORS[i] ?? "rgba(255,255,255,0.5)" }}>
            {i + 1}
          </span>
          <InitialsAvatar name={c.displayName} highlight={i === 0} color={GOLD} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-white truncate">{c.displayName}</p>
              <span className="text-sm font-bold text-white shrink-0">{c.averageScore ?? "—"}</span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full" style={{ backgroundColor: "rgba(255,255,255,0.08)" }}>
              <div
                className="h-1.5 rounded-full"
                style={{
                  width: `${Math.max(4, ((c.averageScore ?? 0) / maxScore) * 100)}%`,
                  backgroundColor: GREEN_LIGHT,
                  boxShadow: `0 0 6px ${GREEN_LIGHT}80`,
                }}
              />
            </div>
          </div>
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
      {isManager && office && officeActive(office) && userId != null && (
        <EmailInviteCard officeName={office.name} />
      )}
      {userId != null && officeId != null && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: BORDER }}>
          <div className="[&_*]:!text-inherit">
            <ConsultantRoster officeId={officeId} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenarios section: real practice distribution across verticals.
// ---------------------------------------------------------------------------

function ScenariosSection({ stats, loading, locked, office, isManager }: { stats?: DashboardStats; loading: boolean; locked?: boolean; office?: Office; isManager?: boolean }) {
  const { data: scenarios } = useQuery<Scenario[]>({ queryKey: ["/api/scenarios"] });

  if (locked) return <AddOnLocked office={office} isManager={isManager} />;
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
    <div className="space-y-6">
      <Panel
        title="Scenario coverage"
        caption="Available practice scenarios and completed conversations, by vertical"
        testId="panel-scenarios"
        accent={BLUE}
      >
        {rows.length === 0 ? (
          <EmptyState message="No scenarios available yet" testId="empty-scenarios" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-scenarios">
              <thead>
                <tr className="text-left text-white/45 border-b" style={{ borderColor: BORDER }}>
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
      <Panel title="Conversations by vertical" caption="Completed discovery sessions across verticals" testId="panel-vertical-breakdown" accent={PURPLE}>
        <VerticalBreakdown data={stats.verticalBreakdown} />
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard section: full ranked list + streaks.
// ---------------------------------------------------------------------------

function LeaderboardSection({ stats, loading, locked, office, isManager }: { stats?: DashboardStats; loading: boolean; locked?: boolean; full?: boolean; office?: Office; isManager?: boolean }) {
  if (locked) return <AddOnLocked office={office} isManager={isManager} />;
  if (loading || !stats) {
    return <Skeleton className="h-72 rounded-xl" />;
  }
  return (
    <div className="space-y-6">
      <Panel title="Leaderboard" caption="Every consultant, ranked by average discovery score" testId="panel-leaderboard-full" accent={GOLD}>
        <Leaderboard leaderboard={stats.leaderboard} />
      </Panel>
      <Panel
        title="Streaks & rankings"
        caption="Each consultant's current practice streak and office rank"
        testId="panel-streaks-rankings"
        accent={ORANGE}
      >
        <StreaksAndRankings rows={stats.streaksAndRankings} />
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Settings section: per-office widget on/off toggles, persisted via
// GET/PUT /api/manager/dashboard-widget-config. Basic (not drag/drop)
// customization, per this pass's scope.
// ---------------------------------------------------------------------------

function SettingsSection({
  userId,
  locked,
  office,
  isManager,
}: {
  userId?: number;
  locked?: boolean;
  office?: Office;
  isManager?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ widgetConfig: Record<string, boolean> }>({
    queryKey: ["/api/manager/dashboard-widget-config"],
    enabled: !!userId,
  });

  const updateWidget = useMutation({
    mutationFn: async (patch: Record<string, boolean>) => {
      const res = await apiRequest("PUT", "/api/manager/dashboard-widget-config", {
        widgetConfig: patch,
      });
      return res.json() as Promise<{ widgetConfig: Record<string, boolean> }>;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["/api/manager/dashboard-widget-config"], result);
      // The command-center query key now also carries since/until, so match
      // by prefix (any cached date range) rather than an exact
      // key, otherwise switching date ranges would leave stale widget config
      // cached under the previously active range's key.
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === "string" && key.startsWith("/api/manager/dashboard-command-center?");
        },
      });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't save that change", description: humanError(err), variant: "destructive" });
    },
  });

  if (locked) return <AddOnLocked office={office} isManager={isManager} />;
  if (isLoading || !data) {
    return <Skeleton className="h-96 rounded-xl" />;
  }

  const cfg = data.widgetConfig;

  return (
    <div className="space-y-6">
      <Panel
        title="Dashboard Settings"
        caption="Choose which Command Center widgets your office sees. Changes save immediately and apply to your Dashboard tab."
        testId="panel-dashboard-settings"
        accent={BLUE}
      >
        <ul className="divide-y" style={{ borderColor: BORDER }} data-testid="list-widget-toggles">
          {DASHBOARD_WIDGET_KEYS.map((key) => {
            const visible = cfg[key] !== false;
            return (
              <li key={key} className="flex items-center justify-between gap-4 py-3.5" data-testid={`widget-toggle-row-${key}`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{WIDGET_LABELS[key].label}</p>
                  <p className="text-xs text-white/45 mt-0.5">{WIDGET_LABELS[key].caption}</p>
                </div>
                <Switch
                  checked={visible}
                  onCheckedChange={(checked) => updateWidget.mutate({ [key]: checked })}
                  disabled={!isManager}
                  data-testid={`switch-widget-${key}`}
                  aria-label={`Toggle ${WIDGET_LABELS[key].label}`}
                />
              </li>
            );
          })}
        </ul>
        {!isManager && (
          <p className="mt-4 text-xs text-white/40">Only a manager can change these settings for the office.</p>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite code + billing (billing logic preserved from the prior dashboard).
// ---------------------------------------------------------------------------

function InviteCodeCard({ office }: { office: Office }) {
  return (
    <div
      className="rounded-xl border-2 flex flex-wrap items-center justify-between gap-3 px-5 py-4"
      style={{ borderColor: BLUE, backgroundColor: NAVY }}
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

// Email-invite path (the second consultant enrollment path alongside the invite
// code above). Sends an enrollment email per address via
// POST /api/manager/enroll-consultants, which returns which addresses were sent
// and which failed so we can report both back to the manager.
function EmailInviteCard({ officeName }: { officeName: string }) {
  const { toast } = useToast();
  const [raw, setRaw] = useState("");

  const enroll = useMutation({
    mutationFn: async (emails: string[]) => {
      const res = await apiRequest("POST", "/api/manager/enroll-consultants", { emails });
      return res.json() as Promise<{ sent: string[]; failed: string[] }>;
    },
    onSuccess: ({ sent, failed }) => {
      if (sent.length > 0) {
        toast({
          title: sent.length === 1 ? "Invite sent" : `${sent.length} invites sent`,
          description: sent.join(", "),
        });
        setRaw("");
      }
      if (failed.length > 0) {
        toast({
          title: failed.length === 1 ? "One invite didn't send" : `${failed.length} invites didn't send`,
          description: `${failed.join(", ")}. Check the addresses and try again.`,
          variant: "destructive",
        });
      }
    },
    onError: (err: any) => {
      toast({ title: "Couldn't send invites", description: humanError(err), variant: "destructive" });
    },
  });

  // Managers paste addresses separated by commas or new lines; split on either,
  // trim, and drop blanks before handing the list to the endpoint.
  const emails = raw
    .split(/[\n,]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  return (
    <Panel
      title="Invite consultants by email"
      caption="Send each consultant a link to join your office. They can also join with the code above."
      testId="panel-email-invite"
    >
      <div className="space-y-3">
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="consultant@example.com, another@example.com"
          rows={3}
          className="min-h-20 bg-transparent text-white placeholder:text-white/35"
          style={{ backgroundColor: PANEL, borderColor: "rgba(255,255,255,0.15)" }}
          data-testid="input-consultant-emails"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-white/45">
            Invites will join <span className="font-medium text-white/70">{officeName}</span>. Separate
            addresses with commas or new lines.
          </p>
          <Button
            type="button"
            onClick={() => enroll.mutate(emails)}
            disabled={emails.length === 0 || enroll.isPending}
            className="gap-1.5 shrink-0"
            style={{ backgroundColor: BLUE, color: "white" }}
            data-testid="button-send-invites"
          >
            <Mail className="h-4 w-4" />
            {enroll.isPending ? "Sending…" : "Send Invite"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function PendingBanner() {
  return (
    <div
      className="rounded-xl border-2 px-5 py-4 space-y-2"
      style={{ borderColor: BLUE, backgroundColor: NAVY }}
      data-testid="banner-office-pending"
    >
      <h2 className="text-lg font-semibold text-white">Finish setting up your office</h2>
      <p className="text-sm text-white/60">
        Your office activates as soon as your payment is complete. Once it is, you and your
        consultants can start practicing right away.
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
    <div className="rounded-xl border-2 px-5 py-4 space-y-3" style={{ borderColor: BLUE, backgroundColor: NAVY }}>
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
        style={{ backgroundColor: BLUE, color: "white" }}
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

// Renders an ISO timestamp as a short relative label ("2m ago", "3h ago", "5d
// ago") for the Live Feed, matching the reference design's timestamp style.
function fmtRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
