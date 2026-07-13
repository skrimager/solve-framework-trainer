import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
};

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

export function ConsultantRoster({ officeId, requesterId }: { officeId: number; requesterId: number }) {
  const [sortKey, setSortKey] = useState<SortKey>("lastActive");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: consultants, isLoading } = useQuery<ConsultantSummary[]>({
    queryKey: [`/api/offices/${officeId}/consultants?requesterId=${requesterId}`],
  });

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
            requesterId={requesterId}
            userId={selectedId}
            onClose={() => setSelectedId(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ConsultantDetailPanel({
  officeId,
  requesterId,
  userId,
  onClose,
}: {
  officeId: number;
  requesterId: number;
  userId: number;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<ConsultantDetail>({
    queryKey: [`/api/offices/${officeId}/consultants/${userId}?requesterId=${requesterId}`],
  });

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
              {data.sessions.map((s) => (
                <TableRow key={s.id} data-testid={`row-detail-session-${s.id}`}>
                  <TableCell className="font-medium">{s.scenarioTitle}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">{s.track}</TableCell>
                  <TableCell className="text-right">{s.score ?? "—"}</TableCell>
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
    </div>
  );
}
