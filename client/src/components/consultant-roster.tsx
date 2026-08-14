import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronUp, ChevronDown, ChevronsUpDown, X } from "lucide-react";
import badgeBeginner from "@assets/badge_beginner_v2.png";
import badgeIntermediate from "@assets/badge_intermediate_v2.png";
import badgeAdvanced from "@assets/badge_advanced_v2.png";

// Visual mapping of a consulting tier to its shield artwork + label. Badges are a
// pure UI concept: they map 1:1 to currentLevel (beginner=bronze, intermediate=
// silver, advanced=gold) — there is no badges table.
const TIER_META: Record<string, { label: string; img: string; medal: string }> = {
  beginner: { label: "Bronze", img: badgeBeginner, medal: "Beginner" },
  intermediate: { label: "Silver", img: badgeIntermediate, medal: "Intermediate" },
  advanced: { label: "Gold", img: badgeAdvanced, medal: "Advanced" },
};
const TIER_RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };

const ORANGE = "#E06D00";

type ConsultantSummary = {
  id: number;
  username: string;
  displayName: string;
  currentLevel: string;
  leadershipLevel: string;
  consultingCertified: boolean;
  consultingCertifiedAt: string | null;
  leadershipCertified: boolean;
  leadershipCertifiedAt: string | null;
  totalSessionsCompleted: number;
  averageScore: number | null;
  qualifyingSessionsAtCurrentTier: number;
  requiredQualifyingSessions: number;
  lastSessionDate: string | null;
  realConversationsThisMonth?: number;
  realConversationCap?: number;
  industries?: {
    consulting: IndustryTrackBreakdown;
    leadership: IndustryTrackBreakdown;
  };
  academyLevel?: number;
  academyRankLabel?: string | null;
  academyCreditCents?: number;
};

type IndustryTrackBreakdown = {
  started: { vertical: string; level: string; certified: boolean }[];
  certifiedCount: number;
};

function prettyVertical(vertical: string): string {
  return vertical
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type DetailSession = {
  id: number;
  scenarioTitle: string;
  scenarioVertical: string | null;
  track: string;
  status: string;
  score: number | null;
  rubricScores: Record<string, number> | null;
  createdAt: string;
  completedAt: string | null;
};

type ConsultantDetail = {
  consultant: ConsultantSummary;
  sessions: DetailSession[];
};

type IntelligenceDimension = { key: string; label: string; average: number } | null;
type TrackIntelligence = {
  strength: IntelligenceDimension;
  weakness: IntelligenceDimension;
  sampleSize: number;
};
type CoinAward = { tier: "bronze" | "silver" | "gold"; earnedAt: string };
type ConsultantIntelligence = {
  rank: { position: number | null; outOf: number; averageScore: number | null; sampleSize: number };
  strengths: { consulting: TrackIntelligence; leadership: TrackIntelligence };
  coins: { consulting: CoinAward[]; leadership: CoinAward[] };
  certifications: {
    consulting: { certified: boolean; earnedAt: string | null };
    leadership: { certified: boolean; earnedAt: string | null };
  };
  academyCredits: { level: number; amountCents: number; earnedAt: string }[];
};
type SessionIntelligence = {
  session: {
    id: number;
    scenarioTitle: string;
    scenarioVertical: string | null;
    track: string;
    status: string;
    score: number | null;
    createdAt: string;
    completedAt: string | null;
    transcript: { role?: string; content?: string }[];
    rubricScores: Record<string, number> | null;
    feedback: string | null;
  };
  coachingMessages: { id: number; role: string; content: string; createdAt: string }[];
};

const RUBRIC_LABELS: Record<string, string> = {
  needsDiscovery: "Needs discovery (drill vs. the hole)",
  objectionPrevention: "Objection prevention via early discovery",
  trustBuilding: "Trust building",
  naturalClose: "Natural, decision-focused close",
  relationshipContinuity: "Relationship continuity / follow-up",
  activeListening: "Active listening (let them fully vent)",
  empathyAcknowledgment: "Empathy / acknowledged the feeling",
  rootCauseDiscovery: "Root-cause discovery",
  solutionVisualization: "Co-created the solution",
  blamelessResolution: "Blameless resolution",
};

// A scored real (field) conversation as returned by the manager Field endpoint,
// decorated server-side with attribution.
type FieldConversation = {
  id: number;
  submissionType: string;
  overallScore: number | null;
  stalledStep: string | null;
  feedback: string | null;
  createdAt: string;
  managerSubmitted: boolean;
  submittedByName: string | null;
};

const SUBMISSION_LABELS: Record<string, string> = {
  text_chat: "Text / SMS / chat",
  email: "Email thread",
  audio: "Uploaded audio",
};

type SortKey = "name" | "tier" | "score" | "lastActive";
type SortDir = "asc" | "desc";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

function TierBadge({ level }: { level: string }) {
  const meta = TIER_META[level] ?? TIER_META.beginner;
  return (
    <div className="flex items-center gap-2">
      <img
        src={meta.img}
        alt={`${meta.medal} tier badge`}
        className="h-9 w-9 shrink-0 object-contain"
        data-testid={`badge-tier-${level}`}
      />
      <span className="font-medium text-foreground">{meta.medal}</span>
    </div>
  );
}

function CertPill({ certified }: { certified: boolean }) {
  if (certified) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
        style={{ backgroundColor: ORANGE }}
        data-testid="pill-certified"
      >
        Certified
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
      data-testid="pill-in-progress"
    >
      In Progress
    </span>
  );
}

function SortHeader({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === column;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
        data-testid={`sort-${column}`}
      >
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

// Read-only data source for the public demo dashboard: the full roster plus
// each consultant's detail history, so the component renders entirely from this
// payload and never issues an authenticated (session-scoped) request.
export type RosterReadOnlyData = {
  consultants: ConsultantSummary[];
  details: Record<number, ConsultantDetail>;
};

export function ConsultantRoster({
  officeId,
  readOnlyData,
}: {
  officeId: number;
  // When provided, the roster is fully read-only: it uses this data and makes
  // no network calls at all (the authenticated queries below are disabled).
  readOnlyData?: RosterReadOnlyData;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("lastActive");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: fetched, isLoading: fetchedLoading } = useQuery<ConsultantSummary[]>({
    queryKey: [`/api/offices/${officeId}/consultants`],
    enabled: !readOnlyData,
  });
  const consultants = readOnlyData ? readOnlyData.consultants : fetched;
  const isLoading = readOnlyData ? false : fetchedLoading;

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Names read best ascending; numeric/recency columns read best descending.
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  const sorted = useMemo(() => {
    const rows = [...(consultants ?? [])];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return dir * a.displayName.localeCompare(b.displayName);
        case "tier":
          return dir * (TIER_RANK[a.currentLevel] - TIER_RANK[b.currentLevel]);
        case "score":
          return dir * ((a.averageScore ?? -1) - (b.averageScore ?? -1));
        case "lastActive":
          return dir * (a.lastSessionDate ?? "").localeCompare(b.lastSessionDate ?? "");
        default:
          return 0;
      }
    });
    return rows;
  }, [consultants, sortKey, sortDir]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Consultant roster</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-48 rounded-lg" />}
        {!isLoading && sorted.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-consultants">
            No consultants have joined this office yet.
          </p>
        )}
        {!isLoading && sorted.length > 0 && (
          <Table data-testid="table-roster">
            <TableHeader>
              <TableRow>
                <SortHeader label="Name" column="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortHeader label="Tier" column="tier" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <TableHead>Certification</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="text-right">Conversations</TableHead>
                <TableHead className="text-right whitespace-nowrap">Field this month</TableHead>
                <SortHeader label="Avg score" column="score" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="text-right" />
                <SortHeader label="Last active" column="lastActive" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((c) => (
                <TableRow
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className="cursor-pointer hover-elevate"
                  data-testid={`row-consultant-${c.id}`}
                >
                  <TableCell className="font-medium">{c.displayName}</TableCell>
                  <TableCell>
                    <TierBadge level={c.currentLevel} />
                  </TableCell>
                  <TableCell>
                    <CertPill certified={c.consultingCertified} />
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {c.qualifyingSessionsAtCurrentTier} of {c.requiredQualifyingSessions} at 85%+
                  </TableCell>
                  <TableCell className="text-right">{c.totalSessionsCompleted}</TableCell>
                  <TableCell className="text-right whitespace-nowrap" data-testid={`text-field-usage-${c.id}`}>
                    {c.realConversationCap != null
                      ? `${c.realConversationsThisMonth ?? 0} / ${c.realConversationCap}`
                      : "-"}
                  </TableCell>
                  <TableCell className="text-right font-medium">{c.averageScore ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(c.lastSessionDate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {selectedId !== null && (
          <ConsultantDetailPanel
            officeId={officeId}
            userId={selectedId}
            readOnlyDetail={readOnlyData?.details[selectedId]}
            onClose={() => setSelectedId(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

// Per-track industry breakdown: one chip per vertical the consultant has started,
// marked certified vs in progress. Powers the manager's "started vs certified"
// per-industry view.
function IndustryTrackCard({ title, breakdown }: { title: string; breakdown: IndustryTrackBreakdown }) {
  return (
    <div className="rounded-lg border p-3" data-testid={`industry-card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">{breakdown.certifiedCount} certified</p>
      </div>
      {breakdown.started.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No industries started yet.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {breakdown.started.map((ind) => (
            <span
              key={ind.vertical}
              className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs"
              style={ind.certified ? { backgroundColor: ORANGE, color: "white", borderColor: ORANGE } : undefined}
              data-testid={`industry-chip-${ind.vertical}`}
            >
              {prettyVertical(ind.vertical)}
              {ind.certified ? " · Certified" : ` · ${TIER_META[ind.level]?.medal ?? ind.level}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TrackIntelligenceCard({
  title,
  data,
  coins,
  certification,
}: {
  title: string;
  data: TrackIntelligence;
  coins: CoinAward[];
  certification: { certified: boolean; earnedAt: string | null };
}) {
  const coinsByTier = new Map(coins.map((coin) => [coin.tier, coin]));
  return (
    <div className="rounded-lg border p-3 space-y-3" data-testid={`card-track-intelligence-${title.toLowerCase()}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">
          based on last {data.sampleSize} {data.sampleSize === 1 ? "scenario" : "scenarios"}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Strength</p>
          <p className="font-medium">{data.strength ? `${data.strength.label} (${Math.round(data.strength.average)})` : "Not enough scored rubric data"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Coaching focus</p>
          <p className="font-medium">{data.weakness ? `${data.weakness.label} (${Math.round(data.weakness.average)})` : "Not enough scored rubric data"}</p>
        </div>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Coins earned</p>
        <div className="mt-1 grid grid-cols-3 gap-1.5 text-xs">
          {(["bronze", "silver", "gold"] as const).map((tier) => {
            const coin = coinsByTier.get(tier);
            return (
              <div className="rounded border px-2 py-1.5 capitalize" key={tier} data-testid={`coin-${title.toLowerCase()}-${tier}`}>
                <p className="font-medium">{tier}</p>
                <p className="text-muted-foreground">{coin ? fmtDate(coin.earnedAt) : "Not earned"}</p>
              </div>
            );
          })}
        </div>
      </div>
      <div className="text-sm">
        <p className="text-xs text-muted-foreground">Certification</p>
        <p className="font-medium">{certification.certified ? `Certified ${fmtDate(certification.earnedAt)}` : "In progress"}</p>
      </div>
    </div>
  );
}

function SessionDetailModal({
  detail,
  isLoading,
  open,
  onOpenChange,
}: {
  detail: SessionIntelligence | undefined;
  isLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = detail?.session;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{session?.scenarioTitle ?? "Session detail"}</DialogTitle>
          <DialogDescription>
            {session ? `${session.track} · ${session.scenarioVertical ?? "No vertical"} · ${fmtDate(session.completedAt ?? session.createdAt)} · score ${session.score ?? "—"}` : "Loading the selected session"}
          </DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-64 rounded-lg" />}
        {session && (
          <div className="space-y-5" data-testid={`session-detail-${session.id}`}>
            <section>
              <h3 className="text-sm font-semibold">Rubric breakdown</h3>
              {session.rubricScores ? (
                <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                  {Object.entries(session.rubricScores).map(([key, score]) => (
                    <div key={key} className="rounded border px-3 py-2 text-sm">
                      <dt className="text-muted-foreground">{RUBRIC_LABELS[key] ?? key}</dt>
                      <dd className="font-semibold">{score}</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="mt-1 text-sm text-muted-foreground">No rubric was recorded.</p>}
            </section>
            <section>
              <h3 className="text-sm font-semibold">Narrative feedback</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{session.feedback ?? "No narrative feedback was recorded."}</p>
            </section>
            <section>
              <h3 className="text-sm font-semibold">Transcript</h3>
              {session.transcript.length ? (
                <div className="mt-2 space-y-2">
                  {session.transcript.map((message, index) => (
                    <div key={`${message.role ?? "message"}-${index}`} className="rounded border px-3 py-2 text-sm">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">{message.role ?? "Conversation"}</p>
                      <p className="mt-1 whitespace-pre-wrap">{message.content ?? ""}</p>
                    </div>
                  ))}
                </div>
              ) : <p className="mt-1 text-sm text-muted-foreground">No transcript was recorded.</p>}
            </section>
            <section>
              <h3 className="text-sm font-semibold">SOLVE Coach thread</h3>
              {detail?.coachingMessages.length ? (
                <div className="mt-2 space-y-2">
                  {detail.coachingMessages.map((message) => (
                    <div key={message.id} className="rounded border px-3 py-2 text-sm">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">{message.role === "coach" ? "SOLVE Coach" : "Trainee"} · {fmtDate(message.createdAt)}</p>
                      <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
                    </div>
                  ))}
                </div>
              ) : <p className="mt-1 text-sm text-muted-foreground">No active coaching messages for this session.</p>}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConsultantDetailPanel({
  officeId,
  userId,
  readOnlyDetail,
  onClose,
}: {
  officeId: number;
  userId: number;
  // When provided (public demo), render from this and make no network call.
  readOnlyDetail?: ConsultantDetail;
  onClose: () => void;
}) {
  const [, navigate] = useLocation();
  // Practice = existing discovery-practice sessions; Field = scored real
  // conversations. Practice is the default so the panel opens unchanged.
  const [view, setView] = useState<"practice" | "field">("practice");
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  const { data: fetched, isLoading: fetchedLoading } = useQuery<ConsultantDetail>({
    queryKey: [`/api/offices/${officeId}/consultants/${userId}`],
    enabled: !readOnlyDetail,
  });
  const data = readOnlyDetail ?? fetched;
  const isLoading = readOnlyDetail ? false : fetchedLoading;

  // Field submissions load lazily the first time the manager opens that tab, and
  // never in the read-only public demo.
  const { data: fieldRows, isLoading: fieldLoading } = useQuery<FieldConversation[]>({
    queryKey: [`/api/offices/${officeId}/consultants/${userId}/real-conversations`],
    enabled: !readOnlyDetail && view === "field",
  });

  const { data: intelligence, isLoading: intelligenceLoading } = useQuery<ConsultantIntelligence>({
    queryKey: ["consultant-intelligence", officeId, userId],
    enabled: !readOnlyDetail,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/offices/${officeId}/consultants/${userId}/intelligence`,
      );
      return res.json();
    },
  });
  const { data: sessionDetail, isLoading: sessionDetailLoading } = useQuery<SessionIntelligence>({
    queryKey: ["consultant-session-intelligence", officeId, userId, selectedSessionId],
    enabled: !readOnlyDetail && selectedSessionId !== null,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/offices/${officeId}/consultants/${userId}/sessions/${selectedSessionId}`,
      );
      return res.json();
    },
  });

  function submitForRep() {
    if (!data) return;
    const url = new URL(window.location.href);
    url.searchParams.set("repId", String(userId));
    url.searchParams.set("repName", data.consultant.displayName);
    window.history.replaceState({}, "", url);
    navigate("/real-conversations");
  }

  return (
    <div className="mt-6 rounded-lg border p-4" style={{ borderColor: ORANGE }} data-testid="panel-consultant-detail">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-semibold">
            {data?.consultant.displayName ?? "Loading…"}
          </p>
          {data && (
            <p className="text-sm text-muted-foreground">
              {TIER_META[data.consultant.currentLevel]?.medal ?? data.consultant.currentLevel} · {data.consultant.totalSessionsCompleted} conversations completed · avg {data.consultant.averageScore ?? "—"}
            </p>
          )}
          {data?.consultant.academyRankLabel && (
            <p className="mt-1 text-sm font-semibold" style={{ color: ORANGE }} data-testid="text-academy-rank">
              {data.consultant.academyRankLabel}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover-elevate"
          aria-label="Close consultant detail"
          data-testid="button-close-detail"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {data?.consultant.industries && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="industry-breakdown">
          <IndustryTrackCard title="Consulting" breakdown={data.consultant.industries.consulting} />
          <IndustryTrackCard title="Conflict Management" breakdown={data.consultant.industries.leadership} />
        </div>
      )}

      {!readOnlyDetail && (
        <div className="mt-4 space-y-3" data-testid="consultant-intelligence">
          {intelligenceLoading && <Skeleton className="h-48 rounded-lg" />}
          {intelligence && (
            <>
              <div className="rounded-lg border px-3 py-2">
                <p className="text-xs text-muted-foreground">Rolling last-20 rank</p>
                <p className="text-sm font-semibold" data-testid="text-rolling-rank">
                  {intelligence.rank.position ? `#${intelligence.rank.position} of ${intelligence.rank.outOf}` : "Unranked"} · avg {intelligence.rank.averageScore === null ? "—" : Math.round(intelligence.rank.averageScore)} · {intelligence.rank.sampleSize} scored
                </p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <TrackIntelligenceCard
                  title="Consulting"
                  data={intelligence.strengths.consulting}
                  coins={intelligence.coins.consulting}
                  certification={intelligence.certifications.consulting}
                />
                <TrackIntelligenceCard
                  title="Leadership"
                  data={intelligence.strengths.leadership}
                  coins={intelligence.coins.leadership}
                  certification={intelligence.certifications.leadership}
                />
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-sm font-semibold">Academy credits</p>
                {intelligence.academyCredits.length ? (
                  <ul className="mt-1 space-y-1 text-sm">
                    {intelligence.academyCredits.map((credit) => (
                      <li key={`${credit.level}-${credit.earnedAt}`}>
                        Level {credit.level} · ${(credit.amountCents / 100).toFixed(0)} · {fmtDate(credit.earnedAt)}
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-1 text-sm text-muted-foreground">No academy credits earned yet.</p>}
              </div>
            </>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border p-0.5" role="tablist" data-testid="toggle-practice-field">
          {(["practice", "field"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className="rounded px-3 py-1 text-sm font-medium"
              style={view === v ? { backgroundColor: ORANGE, color: "white" } : undefined}
              data-testid={`tab-${v}`}
            >
              {v === "practice" ? "Practice" : "Field"}
            </button>
          ))}
        </div>
        {!readOnlyDetail && (
          <Button
            size="sm"
            style={{ backgroundColor: ORANGE, color: "white" }}
            onClick={submitForRep}
            data-testid="button-submit-for-rep"
          >
            Submit real conversation for {data?.consultant.displayName ?? "this rep"}
          </Button>
        )}
      </div>

      {view === "practice" && (
        <div className="mt-4">
          {isLoading && <Skeleton className="h-32 rounded-lg" />}
          {!isLoading && data && data.sessions.length === 0 && (
            <p className="text-sm text-muted-foreground">No conversations recorded yet.</p>
          )}
          {!isLoading && data && data.sessions.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Conversation</TableHead>
                  <TableHead>Track</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sessions.slice(0, 20).map((s) => (
                  <TableRow
                    key={s.id}
                    onClick={() => !readOnlyDetail && setSelectedSessionId(s.id)}
                    className={readOnlyDetail ? undefined : "cursor-pointer hover-elevate"}
                    data-testid={`row-detail-session-${s.id}`}
                  >
                    <TableCell className="font-medium">{s.scenarioTitle}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{s.track}</TableCell>
                    <TableCell className="text-right">{s.score ?? "-"}</TableCell>
                    <TableCell>
                      <Badge variant={s.status === "completed" ? "secondary" : "outline"}>{s.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {fmtDate(s.completedAt ?? s.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {view === "field" && (
        <div className="mt-4" data-testid="field-conversations">
          {fieldLoading && <Skeleton className="h-32 rounded-lg" />}
          {!fieldLoading && (!fieldRows || fieldRows.length === 0) && (
            <p className="text-sm text-muted-foreground" data-testid="text-no-field">
              No real conversations submitted yet.
            </p>
          )}
          {!fieldLoading && fieldRows && fieldRows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Stalled at</TableHead>
                  <TableHead>Submitted by</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fieldRows.map((r) => (
                  <TableRow key={r.id} data-testid={`row-field-conversation-${r.id}`}>
                    <TableCell className="font-medium">
                      {SUBMISSION_LABELS[r.submissionType] ?? r.submissionType}
                    </TableCell>
                    <TableCell className="text-right">{r.overallScore ?? "-"}</TableCell>
                    <TableCell>
                      {r.stalledStep ? (
                        <span
                          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
                          style={{ backgroundColor: ORANGE }}
                          data-testid={`pill-field-stalled-${r.id}`}
                        >
                          {r.stalledStep}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.managerSubmitted
                        ? `Manager${r.submittedByName ? ` (${r.submittedByName})` : ""}`
                        : "Rep"}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {fmtDate(r.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
      {!readOnlyDetail && (
        <SessionDetailModal
          detail={sessionDetail}
          isLoading={sessionDetailLoading}
          open={selectedSessionId !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedSessionId(null);
          }}
        />
      )}
    </div>
  );
}
