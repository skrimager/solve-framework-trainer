import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { Level } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { PracticeStatsPanel } from "@/components/practice-stats-panel";
import { getAvatarUrl } from "@/lib/avatars";
import { PlayCircle, Award, Handshake, ShieldAlert, Check, Clock, Lock, Sparkles, FlaskConical, MessageSquare, MessageCircleQuestion } from "lucide-react";
import type { Scenario, Session } from "@shared/schema";
import { isInternalTestScenario } from "@shared/internalTestScenarios";
import { REQUIRED_QUALIFYING, QUALIFYING_SCORE } from "@/lib/progression";

// Monthly fair-use practice standing returned by GET /api/users/:id/practice-usage.
type PracticeCap = {
  bypassed: boolean;
  minutesUsed: number;
  limitMinutes: number;
  warnMinutes: number;
  minutesRemaining: number;
  warning: boolean;
  blocked: boolean;
  resetDate: string;
};

// Render remaining minutes as a friendly "X hr Y min" (or "Y min") string.
function formatRemaining(minutes: number): string {
  const safe = Math.max(0, minutes);
  const hrs = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} min`;
  if (hrs > 0) return `${hrs} hr`;
  return `${mins} min`;
}

// Format the ISO reset timestamp in the user's local time (first of next month).
function formatResetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the first of next month";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const LEVEL_LABELS: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

// Fixed display order for difficulty badges — always Beginner → Intermediate →
// Advanced, regardless of the order scenarios come back from the API/DB.
const DIFFICULTY_ORDER: Level[] = ["beginner", "intermediate", "advanced"];

type Track = "consulting" | "leadership";
type PracticeModule = Track | "stall";

const TRACK_LABELS: Record<Track, string> = {
  consulting: "Consulting",
  leadership: "Leadership / Conflict Management",
};

// One-line description shown on each track's picker card.
const TRACK_DESCRIPTIONS: Record<Track, string> = {
  consulting: "Discovery consultation practice across every vertical: uncover the real need behind what the customer opens with.",
  leadership: "De-escalation and resolution practice for upset customers, employee grievances, and peer conflict.",
};

const TRACK_ICONS: Record<Track, typeof Handshake> = {
  consulting: Handshake,
  leadership: ShieldAlert,
};

const STALL_MODULE_TITLE = "Stall & Excuse Handling";
const STALL_MODULE_DESCRIPTION = "Recognize when a customer is stalling instead of objecting, and diagnose what got missed instead of arguing back.";

// Named credential earned per track at the "advanced" ceiling. Distinct name
// per track (same 3-level structure and auto-advance mechanism underneath).
const TRACK_CREDENTIAL: Record<Track, string> = {
  consulting: "SOLVE Framework Certified",
  leadership: "SOLVE Conflict Management Certified",
};

const VERTICAL_LABELS: Record<string, string> = {
  // Leadership / Conflict-Management verticals
  upset_customer_service: "Upset customer service",
  employee_grievance: "Employee grievance",
  peer_conflict: "Peer conflict",
  manufactured_housing_community: "Manufactured housing community",
  manufactured_housing: "Manufactured housing dealer",
  real_estate: "Real estate purchase / listing",
  apartment_rental: "Apartment rental",
  auto_sales: "Auto sales",
  hvac_service: "HVAC service call",
  hvac_sales: "HVAC new system sales call",
  plumbing: "Plumbing service call",
  home_improvement: "Home improvement projects",
  pool_landscaping: "Pool & landscaping",
  financial_advisor: "Financial advisor",
  insurance_auto: "Insurance",
  solar: "Solar",
  pest_control: "Pest control",
  roofing: "Roofing",
  saas: "SaaS",
};

const verticalLabel = (vertical: string) => VERTICAL_LABELS[vertical] ?? vertical;

function initialPracticeModule(): PracticeModule {
  if (typeof window === "undefined") return "consulting";
  const params = new URLSearchParams(window.location.search);
  if (params.get("module") === "stall") return "stall";
  return params.get("track") === "leadership" ? "leadership" : "consulting";
}

export default function Scenarios() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  // The selected practice module is persisted in the URL. "stall" is a picker
  // module only, not a new scenario track: its rows remain in the consulting
  // track and use the existing consulting rubric.
  const [module, setModuleState] = useState<PracticeModule>(initialPracticeModule);
  const setModule = (next: PracticeModule) => {
    setModuleState(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next === "stall") {
        url.searchParams.set("module", "stall");
        url.searchParams.delete("track");
      } else {
        url.searchParams.set("track", next);
        url.searchParams.delete("module");
      }
      window.history.replaceState({}, "", url);
    }
  };
  const selectedTrack: Track | null = module === "stall" ? null : module;

  // Identify the requester so the listing can be user-scoped (same convention as
  // the roster/dashboard queries). For every real consultant the response is
  // identical to the anonymous one; only the internal test account sees more.
  const { data: scenarios, isLoading } = useQuery<Scenario[]>({
    queryKey: [`/api/scenarios?requesterId=${user?.id}`],
    enabled: !!user,
  });

  const { data: mySessions } = useQuery<Session[]>({
    queryKey: ["/api/users", user?.id, "sessions"],
    enabled: !!user,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/users/${user!.id}/sessions`);
      return res.json();
    },
  });
  const savedSessions = (mySessions ?? []).filter((s) => s.status === "saved");

  // Monthly fair-use practice standing. Drives the approaching-limit banner and,
  // at the cap, the limit-reached message that replaces the scenario picker.
  const { data: practiceCap } = useQuery<PracticeCap>({
    queryKey: ["/api/users", user?.id, "practice-usage"],
    enabled: !!user,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/users/${user!.id}/practice-usage`);
      return res.json();
    },
  });
  const capBlocked = !!practiceCap?.blocked;
  const capWarning = !!practiceCap?.warning;

  const startSession = useMutation({
    mutationFn: async (scenarioId: number) => {
      const res = await apiRequest("POST", "/api/sessions", { userId: user!.id, scenarioId });
      return res.json();
    },
    onSuccess: (session) => {
      navigate(`/roleplay/${session.id}`);
    },
    onError: () => {
      // A start can still be refused at the server (e.g. the cap was reached in
      // another tab). Refresh the usage query so the limit-reached message shows.
      queryClient.invalidateQueries({ queryKey: ["/api/users", user?.id, "practice-usage"] });
    },
  });

  const resumeSession = useMutation({
    mutationFn: async (sessionId: number) => {
      const res = await apiRequest("POST", `/api/sessions/${sessionId}/resume`, {});
      return res.json();
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users", user?.id, "sessions"] });
      navigate(`/roleplay/${session.id}`);
    },
  });

  // Group scenarios by vertical so the picker shows one card per scenario type
  // (e.g. "HVAC service call") rather than per persona. The specific customer
  // persona is chosen at random when the consultant starts — revealing the title
  // or persona ahead of time would give away exactly what discovery is supposed
  // to uncover.
  // Rows with no track (created before the track column existed) count as consulting.
  const scenarioTrack = (s: Scenario): Track => (s.track === "leadership" ? "leadership" : "consulting");
  const verticalGroups = new Map<string, Scenario[]>();
  for (const s of scenarios ?? []) {
    if (!selectedTrack || scenarioTrack(s) !== selectedTrack || s.stallType) continue;
    const list = verticalGroups.get(s.vertical) ?? [];
    list.push(s);
    verticalGroups.set(s.vertical, list);
  }
  // Stall scenarios have their own module rather than appearing in the ordinary
  // consulting vertical pools. Deliberately do not filter by the user's level:
  // all four diagnostic patterns are immediately available for practice.
  const stallScenarios = (scenarios ?? [])
    .filter((s) => !!s.stallType)
    .sort((a, b) => a.title.localeCompare(b.title));
  // Sort scenarios within each vertical alphabetically by title, and the
  // verticals themselves alphabetically (A→Z) by their human-readable display
  // name — no manual pinning of any vertical.
  for (const list of Array.from(verticalGroups.values())) {
    list.sort((a: Scenario, b: Scenario) => a.title.localeCompare(b.title));
  }
  const orderedVerticals = Array.from(verticalGroups.keys()).sort((a, b) =>
    verticalLabel(a).localeCompare(verticalLabel(b)),
  );

  // The server only ever returns an internal test scenario to the internal test
  // account, so its presence in the response IS the permission check and the
  // client never learns which username is internal.
  const internalTestScenarios = (scenarios ?? []).filter(
    (s) => !!selectedTrack && isInternalTestScenario(s.slug) && scenarioTrack(s) === selectedTrack,
  );

  // The level shown/highlighted is the one for the selected track — the two are
  // tracked independently per user. The stall module intentionally has no level
  // gate or progression state of its own.
  const activeLevel = user && selectedTrack
    ? (selectedTrack === "leadership" ? user.leadershipLevel : user.currentLevel)
    : undefined;
  const certified = user && selectedTrack
    ? (selectedTrack === "leadership" ? user.leadershipCertified : user.consultingCertified)
    : false;

  // Advancement is no longer instant off one great session: a user needs
  // REQUIRED_QUALIFYING sessions that EACH individually score QUALIFYING_SCORE+
  // at their current level. Mirror that count here so the banner can show
  // progress toward the next level (and, at Advanced, toward exam eligibility).
  const qualifyingCount = (mySessions ?? []).filter((s) => {
    if (s.status !== "completed" || s.score == null || s.score < QUALIFYING_SCORE) return false;
    const sc = (scenarios ?? []).find((x) => x.id === s.scenarioId);
    if (!sc) return false;
    return !!selectedTrack && scenarioTrack(sc) === selectedTrack && sc.difficulty === activeLevel;
  }).length;
  const examEligible = activeLevel === "advanced" && qualifyingCount >= REQUIRED_QUALIFYING;

  const handleStart = (vertical: string) => {
    if (capBlocked) return;
    const pool = verticalGroups.get(vertical) ?? [];
    if (pool.length === 0) return;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    startSession.mutate(picked.id);
  };

  return (
    <AppShell title="Training conversations">
      <div className="space-y-4">
        {/* Gamified practice stats: streak, office rank, and certification
            progress. Self-hides unless the office holds the paid dashboard add-on. */}
        <PracticeStatsPanel />
        {/* Monthly fair-use practice cap. At the limit the picker is replaced by
            a friendly limit-reached card with the reset date; approaching the
            limit shows a heads-up banner but still lets the consultant practice. */}
        {capBlocked && practiceCap && (
          <Card
            className="border-2"
            style={{ borderColor: "#E06D00", backgroundColor: "#05162D" }}
            data-testid="card-practice-limit-reached"
          >
            <CardContent className="flex items-start gap-3 py-5">
              <Lock className="w-6 h-6 shrink-0 mt-0.5" style={{ color: "#F1830D" }} aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-base font-semibold text-white">
                  You've reached your monthly practice time
                </p>
                <p className="text-sm" style={{ color: "#E5EAF1" }}>
                  You've used all {practiceCap.limitMinutes / 60} hours of practice time for this
                  month. Your practice time resets on{" "}
                  <span className="font-semibold" style={{ color: "#F1830D" }}>
                    {formatResetDate(practiceCap.resetDate)}
                  </span>
                  . Thanks for putting in the reps.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
        {!capBlocked && capWarning && practiceCap && (
          <div
            className="flex items-center gap-3 rounded-lg border-2 px-4 py-3"
            style={{ borderColor: "#E06D00", backgroundColor: "rgba(224,109,0,0.08)" }}
            data-testid="banner-practice-warning"
          >
            <Clock className="w-5 h-5 shrink-0" style={{ color: "#E06D00" }} aria-hidden="true" />
            <p className="text-sm">
              <span className="font-semibold" style={{ color: "#E06D00" }}>
                You're approaching your monthly practice limit.
              </span>{" "}
              You have about {formatRemaining(practiceCap.minutesRemaining)} of practice time left
              this month. It resets on {formatResetDate(practiceCap.resetDate)}.
            </p>
          </div>
        )}
        {/* Three distinct, separately-selectable practice modules. The stall
            module is intentionally a module, not a third persisted track. */}
        <div
          className="grid gap-3 sm:grid-cols-3"
          role="tablist"
          aria-label="Practice module"
          data-testid="track-picker"
        >
          {(["consulting", "leadership", "stall"] as PracticeModule[]).map((option) => {
            const selected = module === option;
            const Icon = option === "stall" ? MessageCircleQuestion : TRACK_ICONS[option];
            const title = option === "stall" ? STALL_MODULE_TITLE : TRACK_LABELS[option];
            const description = option === "stall" ? STALL_MODULE_DESCRIPTION : TRACK_DESCRIPTIONS[option];
            return (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setModule(option)}
                className="relative flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-colors hover-elevate"
                style={
                  selected
                    ? { borderColor: "#E06D00", backgroundColor: "rgba(224,109,0,0.08)" }
                    : { borderColor: "var(--border)" }
                }
                data-testid={`track-option-${option}`}
              >
                {selected && (
                  <span
                    className="absolute top-3 right-3 flex items-center justify-center w-5 h-5 rounded-full"
                    style={{ backgroundColor: "#E06D00" }}
                    aria-hidden="true"
                  >
                    <Check className="w-3.5 h-3.5 text-white" />
                  </span>
                )}
                <Icon className="w-6 h-6" style={{ color: "#E06D00" }} aria-hidden="true" />
                <span className="text-base font-semibold" style={selected ? { color: "#E06D00" } : undefined}>
                  {title}
                </span>
                <span className="text-xs text-muted-foreground">{description}</span>
              </button>
            );
          })}
        </div>
        {user && module !== "stall" && selectedTrack && (
          <div
            className="flex items-center gap-3 rounded-lg border-2 px-4 py-3"
            style={{ borderColor: "#E06D00", backgroundColor: "rgba(224,109,0,0.06)" }}
            data-testid="banner-current-level"
          >
            <Award className="w-5 h-5 shrink-0" style={{ color: "#E06D00" }} aria-hidden="true" />
            <div className="flex-1">
              <p className="text-xs text-muted-foreground">Your current level, {TRACK_LABELS[selectedTrack]}</p>
              <p className="text-sm font-semibold" style={{ color: "#E06D00" }} data-testid="text-current-level">
                {(activeLevel && LEVEL_LABELS[activeLevel]) ?? activeLevel}
              </p>
              {/* Advancement is gated behind 5 individually-qualifying (85+)
                  sessions at this level, so show progress rather than implying a
                  single session advances the user. */}
              {activeLevel && activeLevel !== "advanced" && (
                <p className="text-xs font-medium text-muted-foreground" data-testid="text-level-progress">
                  {Math.min(qualifyingCount, REQUIRED_QUALIFYING)} of {REQUIRED_QUALIFYING} qualifying sessions passed at {LEVEL_LABELS[activeLevel]}
                </p>
              )}
              {activeLevel === "advanced" && !certified && !examEligible && (
                <p className="text-xs font-medium text-muted-foreground" data-testid="text-level-progress">
                  {Math.min(qualifyingCount, REQUIRED_QUALIFYING)} of {REQUIRED_QUALIFYING} qualifying Advanced sessions toward exam eligibility
                </p>
              )}
              {activeLevel === "advanced" && !certified && examEligible && (
                <p className="text-xs font-medium" style={{ color: "#E06D00" }} data-testid="text-exam-eligible">
                  Eligible for the {TRACK_CREDENTIAL[selectedTrack]} exam
                </p>
              )}
              {/* The credential is shown ONLY once actually certified — reaching
                  Advanced is no longer sufficient (that only unlocks the exam). */}
              {certified && (
                <p className="text-xs font-semibold" style={{ color: "#E06D00" }} data-testid="text-credential">
                  ✓ {TRACK_CREDENTIAL[selectedTrack]} · SOLVE Academy™
                </p>
              )}
            </div>
            {activeLevel === "advanced" && !certified && (
              <Button
                size="sm"
                onClick={() => navigate("/academy")}
                disabled={capBlocked}
                style={examEligible && !capBlocked ? { backgroundColor: "#E06D00", color: "white" } : undefined}
                variant={examEligible ? "default" : "outline"}
                data-testid="button-certification-exam"
              >
                {examEligible ? "Start certification exam" : "Certification exam"}
              </Button>
            )}
          </div>
        )}
        <p className="text-sm text-muted-foreground max-w-prose" data-testid="text-scenarios-intro">
          {module === "stall"
            ? "Pick a stall pattern and start it cold. Your goal is to diagnose what is actually behind the excuse instead of arguing with the surface line."
            : module === "leadership"
              ? "Pick a conversation and start it cold, no preview. Your goal is to de-escalate, understand the real issue behind the complaint, and reach a resolution nobody gets blamed for."
              : "Pick a conversation and start it cold, no preview. Your goal isn't to close fast, it's to uncover the real need behind whatever the customer opens with."}
        </p>
        {savedSessions.length > 0 && (
          <div className="space-y-2" data-testid="container-saved-sessions">
            <h2 className="text-sm font-semibold text-foreground">Saved for later</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {savedSessions.map((s) => (
                <Card key={s.id} data-testid={`card-saved-session-${s.id}`}>
                  <CardContent className="flex items-center justify-between gap-3 py-3">
                    <p className="text-sm text-muted-foreground">Session #{s.id}, paused, no recommendation yet</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resumeSession.mutate(s.id)}
                      disabled={resumeSession.isPending}
                      data-testid={`button-resume-session-${s.id}`}
                    >
                      <PlayCircle className="w-3.5 h-3.5 mr-1" /> Resume
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-40 rounded-lg" />
            <Skeleton className="h-40 rounded-lg" />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Beginner-only entry point to Real Conversation Scoring, sized and
              weighted like a scenario card so it sits naturally in the grid.
              Reachable from any level via the persistent top-nav button. */}
          {module !== "stall" && activeLevel === "beginner" && (
            <Card
              className="border-2 shadow-[0_0_20px_rgba(224,109,0,0.25)]"
              style={{ borderColor: "#E06D00" }}
              data-testid="card-upload-real-conversation"
            >
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 shrink-0" style={{ color: "#E06D00" }} aria-hidden="true" />
                  <CardTitle className="text-lg" style={{ color: "#FBF9F5" }}>
                    Upload Real Conversation
                  </CardTitle>
                </div>
                <CardDescription className="pt-1">
                  Already had this conversation for real? Paste it in or upload the audio and
                  score it against the same SOLVE rubric.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => navigate("/real-conversations")}
                  style={{ backgroundColor: "#E06D00", color: "white" }}
                  data-testid="button-open-real-conversation"
                >
                  Score a Real Conversation
                </Button>
              </CardContent>
            </Card>
          )}
          {/* Members with an active seat get unlimited access to Message Coach
              (score an outbound text or email) right from the practice
              screen, at every level. Gated on seatActive rather than just
              being logged in, because a pending/inactive seat would fall
              through to the anonymous paid path server-side and "Unlimited
              with your membership" would be inaccurate for that user.
              Routes to the same /message-coach page; the backend's member
              path (an active seat) already skips the email-verification
              gate and the $4.99 paywall entirely, so this is truly
              unlimited for a logged-in member with an active seat. */}
          {user?.seatActive && (
            module !== "stall" && (
            <Card
              className="border-2 shadow-[0_0_20px_rgba(224,109,0,0.25)]"
              style={{ borderColor: "#E06D00" }}
              data-testid="card-score-outbound-message"
            >
              <CardHeader>
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 shrink-0" style={{ color: "#E06D00" }} aria-hidden="true" />
                  <CardTitle className="text-lg" style={{ color: "#FBF9F5" }}>
                    Score an Outbound Text or Email
                  </CardTitle>
                </div>
                <CardDescription className="pt-1">
                  Paste in a text or email before you send it and get an instant score,
                  coaching, and a rewrite against the same SOLVE rubric. Unlimited with
                  your membership.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => navigate("/message-coach")}
                  style={{ backgroundColor: "#E06D00", color: "white" }}
                  data-testid="button-open-message-coach"
                >
                  Score a Message
                </Button>
              </CardContent>
            </Card>
            )
          )}
          {/* Internal test scenarios. Only ever present in the response for the
              internal account, so this renders for nobody else. Deliberately
              neutral/gray (lime is reserved for admin/vault) and explicitly
              labelled, so it can never be mistaken for customer-facing content
              in an accidental screenshot. Starting it is a direct call rather
              than a random draw, which is the whole point: a pilot needs the
              same persona every run, not whatever the picker lands on. */}
          {module !== "stall" && internalTestScenarios.map((s) => (
            <Card
              key={s.id}
              className="border border-dashed"
              style={{ borderColor: "rgba(255,255,255,0.25)", backgroundColor: "rgba(255,255,255,0.03)" }}
              data-testid={`card-internal-test-${s.slug}`}
            >
              <CardHeader>
                <div className="flex items-center gap-2">
                  <FlaskConical className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <CardTitle className="text-lg text-muted-foreground">{s.title}</CardTitle>
                  <Badge variant="secondary" className="ml-auto shrink-0">
                    Internal test
                  </Badge>
                </div>
                <CardDescription className="pt-1">
                  Not customer-facing. A fixed copy of a real {verticalLabel(s.vertical)} conversation,
                  visible only to this account, for piloting pipeline changes against a persona that
                  never varies between runs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  variant="outline"
                  onClick={() => startSession.mutate(s.id)}
                  disabled={startSession.isPending || capBlocked}
                  data-testid={`button-start-internal-test-${s.slug}`}
                >
                  {capBlocked ? "Monthly limit reached" : "Start internal test conversation"}
                </Button>
              </CardContent>
            </Card>
          ))}
          {module === "stall" && stallScenarios.map((scenario) => (
            <Card key={scenario.id} data-testid={`card-stall-scenario-${scenario.slug}`}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">{scenario.title}</CardTitle>
                    <CardDescription className="pt-1">{verticalLabel(scenario.vertical)}</CardDescription>
                  </div>
                  <button
                    type="button"
                    onClick={() => startSession.mutate(scenario.id)}
                    disabled={startSession.isPending || capBlocked}
                    className="shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Start ${LEVEL_LABELS[scenario.difficulty as Level] ?? scenario.difficulty} stall practice: ${scenario.title}`}
                    data-testid={`badge-difficulty-stall-${scenario.slug}`}
                  >
                    <Badge variant="secondary">{LEVEL_LABELS[scenario.difficulty as Level] ?? scenario.difficulty}</Badge>
                  </button>
                </div>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => startSession.mutate(scenario.id)}
                  disabled={startSession.isPending || capBlocked}
                  data-testid={`button-start-stall-${scenario.slug}`}
                >
                  {capBlocked ? "Monthly limit reached" : startSession.isPending ? "Starting..." : "Start stall practice"}
                </Button>
              </CardContent>
            </Card>
          ))}
          {module !== "stall" && orderedVerticals.map((vertical) => {
            const pool = verticalGroups.get(vertical) ?? [];
            const presentDifficulties = new Set(pool.map((s) => s.difficulty));
            const difficulties = DIFFICULTY_ORDER.filter((d) => presentDifficulties.has(d));
            const avatarUrls = pool
              .map((s) => getAvatarUrl(s.slug))
              .filter((url): url is string => !!url)
              .slice(0, 4);
            return (
              <Card key={vertical} data-testid={`card-vertical-${vertical}`}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-lg">{verticalLabel(vertical)}</CardTitle>
                    {avatarUrls.length > 0 && (
                      <div className="flex -space-x-3 shrink-0" data-testid={`avatars-preview-${vertical}`}>
                        {avatarUrls.map((url, i) => (
                          <img
                            key={url}
                            src={url}
                            alt=""
                            aria-hidden="true"
                            className="w-8 h-8 rounded-full object-cover border-2 border-card"
                            style={{ zIndex: avatarUrls.length - i }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <CardDescription className="flex flex-wrap gap-1.5 pt-1">
                    {difficulties.map((d) => {
                      const isCurrent = activeLevel === d;
                      return (
                        <Badge
                          key={d}
                          variant={isCurrent ? "default" : "secondary"}
                          style={isCurrent ? { backgroundColor: "#E06D00", color: "white" } : undefined}
                          data-testid={`badge-difficulty-${vertical}-${d}`}
                        >
                          {LEVEL_LABELS[d] ?? d}
                        </Badge>
                      );
                    })}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={() => handleStart(vertical)}
                    disabled={startSession.isPending || capBlocked}
                    data-testid={`button-start-${vertical}`}
                  >
                    {capBlocked
                      ? "Monthly limit reached"
                      : startSession.isPending
                        ? "Starting..."
                        : selectedTrack === "leadership"
                          ? "Start conflict conversation"
                          : "Start discovery session"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
        {!isLoading && module !== "stall" && orderedVerticals.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-scenarios">
            No conversations available in this track yet.
          </p>
        )}
        {!isLoading && module === "stall" && stallScenarios.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-stall-scenarios">
            No stall practices available yet.
          </p>
        )}
      </div>
    </AppShell>
  );
}
