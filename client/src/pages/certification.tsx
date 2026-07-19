import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { AppShell } from "@/components/app-shell";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { Level } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { buildProgressionPath } from "@/lib/progression";
import { Award, Lock, CheckCircle2, XCircle, Check } from "lucide-react";

type Track = "consulting" | "leadership";

const TRACK_LABELS: Record<Track, string> = {
  consulting: "Consulting",
  leadership: "Leadership / Conflict Management",
};

type PublicQuestion =
  | { id: string; type: "multiple_choice"; prompt: string; options: string[] }
  | { id: string; type: "fill_blank"; prompt: string }
  | { id: string; type: "written"; prompt: string };

type IndustryStatus = {
  vertical: string;
  level: string;
  certified: boolean;
  certifiedAt: string | null;
  qualifyingAdvancedSessions: number;
  requiredSessions: number;
  eligible: boolean;
};

type TrackStatus = {
  track: Track;
  credential: string;
  level: string;
  certified: boolean;
  certifiedAt: string | null;
  qualifyingAdvancedSessions: number;
  requiredSessions: number;
  eligible: boolean;
  industries: IndustryStatus[];
  latestAttempt: {
    id: number;
    writtenScore: number | null;
    writtenPassed: boolean;
    scenarioSessionId: number | null;
    scenarioScore: number | null;
    overallPassed: boolean;
    completedAt: string | null;
  } | null;
};

function prettyVertical(vertical: string): string {
  return vertical
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type StartResponse = {
  attemptId: number;
  track: Track;
  credential: string;
  passMark: number;
  total: number;
  questions: PublicQuestion[];
};

type WrittenResult = {
  writtenPassed: boolean;
  writtenScore: number;
  correct: number;
  total: number;
  passMark: number;
  passPercent: number;
  scenarioSessionId: number | null;
};

// apiRequest throws Error(`${status}: ${bodyText}`) where bodyText is usually
// a JSON object like {"message": "..."}. Best-effort extraction of that
// message for a friendlier toast; falls back to undefined if it doesn't parse.
function parseServerMessage(errMessage: unknown): string | undefined {
  if (typeof errMessage !== "string") return undefined;
  const jsonPart = errMessage.slice(errMessage.indexOf(":") + 1).trim();
  try {
    const parsed = JSON.parse(jsonPart);
    return typeof parsed?.message === "string" ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

function initialTrack(): Track {
  if (typeof window === "undefined") return "consulting";
  const t = new URLSearchParams(window.location.search).get("track");
  return t === "leadership" ? "leadership" : "consulting";
}

export default function Certification() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [track, setTrack] = useState<Track>(initialTrack);

  // Local exam state: the drawn question set + the candidate's answers + the
  // graded written result. Held in component state for the duration of the attempt.
  const [exam, setExam] = useState<StartResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [writtenResult, setWrittenResult] = useState<WrittenResult | null>(null);

  const { data: statuses, isLoading } = useQuery<Record<Track, TrackStatus>>({
    queryKey: ["/api/users", user?.id, "certification"],
    enabled: !!user,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/users/${user!.id}/certification`);
      return res.json();
    },
  });

  const status = statuses?.[track];

  const startExam = useMutation({
    mutationFn: async (vertical?: string) => {
      const res = await apiRequest("POST", "/api/certification/start", { userId: user!.id, track, vertical });
      return res.json() as Promise<StartResponse>;
    },
    onSuccess: (data) => {
      setExam(data);
      setAnswers({});
      setWrittenResult(null);
    },
    onError: (err: any) => {
      // Surface the server's message when present so a monthly-limit block reads
      // as a clear explanation (with its reset date) rather than a generic error.
      const serverMessage = parseServerMessage(err?.message);
      toast({
        title: "Couldn't start the exam",
        description: serverMessage ?? "Something went wrong preparing your exam. Please try again.",
        variant: "destructive",
      });
    },
  });

  const submitWritten = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/certification/attempts/${exam!.attemptId}/written`, { answers });
      return res.json() as Promise<WrittenResult>;
    },
    onSuccess: (data) => {
      setWrittenResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/users", user?.id, "certification"] });
    },
    onError: (err: any) => {
      // Your answers are preserved in local state, so it's always safe to retry —
      // the attempt isn't marked submitted on the server until grading succeeds.
      const serverMessage = parseServerMessage(err?.message);
      toast({
        title: "Couldn't grade your exam",
        description:
          serverMessage ??
          "We hit a problem grading your answers. Your answers are still here, please try submitting again.",
        variant: "destructive",
      });
    },
  });

  const setAnswer = (id: string, value: string) => setAnswers((prev) => ({ ...prev, [id]: value }));

  return (
    <AppShell title="Certification exam">
      <div className="space-y-4 max-w-2xl">
        <p className="text-sm text-muted-foreground" data-testid="text-academy-byline">
          Certification administered by <span className="font-semibold" style={{ color: "#E06D00" }}>SOLVE Academy™</span>.
        </p>
        <div
          className="inline-flex rounded-lg border-2 p-1"
          style={{ borderColor: "#E06D00" }}
          role="tablist"
          aria-label="Certification track"
          data-testid="cert-track-picker"
        >
          {(["consulting", "leadership"] as Track[]).map((t) => {
            const selected = track === t;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  setTrack(t);
                  setExam(null);
                  setWrittenResult(null);
                }}
                className="text-sm font-semibold rounded-md px-3 py-1.5 transition-colors"
                style={selected ? { backgroundColor: "#E06D00", color: "white" } : { color: "#E06D00" }}
                data-testid={`cert-track-option-${t}`}
              >
                {TRACK_LABELS[t]}
              </button>
            );
          })}
        </div>

        {isLoading && <Skeleton className="h-40 rounded-lg" />}

        {/* Active written exam takes over the view once started. */}
        {exam && !writtenResult && (
          <WrittenExam
            exam={exam}
            answers={answers}
            setAnswer={setAnswer}
            onSubmit={() => submitWritten.mutate()}
            submitting={submitWritten.isPending}
          />
        )}

        {/* Written result screen. */}
        {writtenResult && (
          <WrittenResultCard
            result={writtenResult}
            credential={exam?.credential ?? status?.credential ?? ""}
            onStartScenario={(sessionId) => navigate(`/roleplay/${sessionId}`)}
            onRetake={() => {
              setExam(null);
              setWrittenResult(null);
            }}
          />
        )}

        {/* Overview / gating when no exam is in progress. */}
        {!exam && !writtenResult && status && (
          <>
            <ProgressionPath level={status.level as Level} certified={status.certified} />
            <OverviewCard
              status={status}
              starting={startExam.isPending}
              onStart={() => startExam.mutate(undefined)}
              onGoToScenario={(sessionId) => navigate(`/roleplay/${sessionId}`)}
            />
            <IndustriesCard
              status={status}
              starting={startExam.isPending}
              onStartVertical={(vertical) => startExam.mutate(vertical)}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}

// The full Beginner -> Intermediate -> Advanced -> Certified path, always shown
// in its entirety. The consultant's current stage is highlighted in orange;
// stages they have passed show a check; locked stages are greyed out but stay
// visible and state exactly what unlocks them (real thresholds from the practice
// dashboard). This only surfaces the surrounding context. It does not change any
// unlock or exam-gating rules.
function ProgressionPath({ level, certified }: { level: Level; certified: boolean }) {
  const stages = buildProgressionPath(level, certified);
  return (
    <Card style={{ borderColor: "#0A1A30" }} data-testid="path-progression">
      <CardHeader>
        <CardTitle className="text-lg">Your certification path</CardTitle>
        <CardDescription>
          Beginner → Intermediate → Advanced → Certified. Certification requires completing 5 Advanced
          sessions scoring 85 or higher, then passing the certification exam.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {stages.map((stage) => {
          const isCurrent = stage.state === "current";
          const isLocked = stage.state === "locked";
          const isComplete = stage.state === "complete";
          return (
            <div
              key={stage.key}
              className="flex items-start gap-3 rounded-md border p-3"
              style={
                isCurrent
                  ? { borderColor: "#E06D00", backgroundColor: "rgba(224,109,0,0.08)" }
                  : { borderColor: "var(--border)" }
              }
              data-testid={`path-stage-${stage.key}`}
              data-state={stage.state}
            >
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                {isComplete ? (
                  <Check className="h-4 w-4" style={{ color: "#E06D00" }} />
                ) : isCurrent ? (
                  <Award className="h-4 w-4" style={{ color: "#E06D00" }} />
                ) : (
                  <Lock className="h-4 w-4 text-muted-foreground" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p
                    className="text-sm font-semibold"
                    style={isCurrent ? { color: "#E06D00" } : isLocked ? undefined : { color: "#0A1A30" }}
                    data-testid={`path-stage-label-${stage.key}`}
                  >
                    {stage.label}
                  </p>
                  {isCurrent && (
                    <Badge style={{ backgroundColor: "#E06D00", color: "white" }} data-testid="path-current-badge">
                      You are here
                    </Badge>
                  )}
                </div>
                {isLocked && stage.unlockCriteria && (
                  <p className="text-xs text-muted-foreground" data-testid={`path-unlock-${stage.key}`}>
                    {stage.unlockCriteria}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function OverviewCard({
  status,
  starting,
  onStart,
  onGoToScenario,
}: {
  status: TrackStatus;
  starting: boolean;
  onStart: () => void;
  onGoToScenario: (sessionId: number) => void;
}) {
  const { credential, certified, eligible, qualifyingAdvancedSessions, requiredSessions, latestAttempt } = status;

  if (certified) {
    return (
      <Card className="border-2" style={{ borderColor: "#E06D00" }} data-testid="card-certified">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Award className="w-5 h-5" style={{ color: "#E06D00" }} /> {credential}
          </CardTitle>
          <CardDescription>
            Certified through SOLVE Academy. Both the written test and the final expert conversation were passed.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Written already passed and a final scenario is waiting to be completed.
  if (latestAttempt && !latestAttempt.completedAt && latestAttempt.writtenPassed && latestAttempt.scenarioSessionId) {
    return (
      <Card className="border-2" style={{ borderColor: "#E06D00" }} data-testid="card-final-scenario-pending">
        <CardHeader>
          <CardTitle className="text-lg">Final expert conversation</CardTitle>
          <CardDescription>
            You passed the written test. One step remains: complete the final expert-level roleplay and score 85+ to earn {credential}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => onGoToScenario(latestAttempt.scenarioSessionId!)}
            style={{ backgroundColor: "#E06D00", color: "white" }}
            data-testid="button-go-final-scenario"
          >
            Go to final conversation
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!eligible) {
    return (
      <Card data-testid="card-locked">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Lock className="w-5 h-5 text-muted-foreground" /> {credential}
          </CardTitle>
          <CardDescription>
            The certification exam unlocks after you reach Advanced and complete {requiredSessions} Advanced
            sessions that each score 85 or higher on this track.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Progress value={(Math.min(qualifyingAdvancedSessions, requiredSessions) / requiredSessions) * 100} />
          <p className="text-sm text-muted-foreground" data-testid="text-eligibility-progress">
            {Math.min(qualifyingAdvancedSessions, requiredSessions)} of {requiredSessions} qualifying Advanced sessions
            {status.level !== "advanced" ? " (reach Advanced first)" : ""}
          </p>
        </CardContent>
      </Card>
    );
  }

  // Eligible: show any prior failed attempt context, then the start button.
  const priorFailed = latestAttempt && latestAttempt.completedAt && !latestAttempt.overallPassed;
  const writtenFailed = latestAttempt && !latestAttempt.completedAt && latestAttempt.writtenScore !== null && !latestAttempt.writtenPassed;
  return (
    <Card className="border-2" style={{ borderColor: "#E06D00" }} data-testid="card-eligible">
      <CardHeader>
        <CardTitle className="text-lg">{credential} exam</CardTitle>
        <CardDescription>
          Two parts, both required: a 30-question written test (pass at 85%, ≥26/30) and a final expert-level
          roleplay conversation (score 85+). The written test unlocks the conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(priorFailed || writtenFailed) && (
          <Badge variant="secondary" data-testid="badge-prior-attempt">
            Previous attempt didn't pass. Questions are re-drawn each attempt.
          </Badge>
        )}
        <div>
          <Button
            onClick={onStart}
            disabled={starting}
            style={{ backgroundColor: "#E06D00", color: "white" }}
            data-testid="button-start-exam"
          >
            {starting ? "Preparing exam…" : "Start written test"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Per-industry certification breakdown: one row per vertical the consultant has
// practiced in on this track, showing progress and letting them start the exam
// for any industry whose Advanced bar they've cleared. Certifying in three
// distinct industries is what earns the Cross-Industry Academy credits.
function IndustriesCard({
  status,
  starting,
  onStartVertical,
}: {
  status: TrackStatus;
  starting: boolean;
  onStartVertical: (vertical: string) => void;
}) {
  if (!status.industries || status.industries.length === 0) return null;
  return (
    <Card data-testid="card-industries">
      <CardHeader>
        <CardTitle className="text-lg">Industries</CardTitle>
        <CardDescription>
          Your certification progress by industry. Certify in three distinct industries to earn
          Cross-Industry recognition.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.industries.map((ind) => (
          <div
            key={ind.vertical}
            className="flex items-center justify-between gap-3 rounded-md border p-3"
            data-testid={`industry-row-${ind.vertical}`}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{prettyVertical(ind.vertical)}</p>
              <p className="text-xs text-muted-foreground">
                {ind.certified
                  ? "Certified"
                  : `${Math.min(ind.qualifyingAdvancedSessions, ind.requiredSessions)} of ${ind.requiredSessions} qualifying Advanced sessions`}
              </p>
            </div>
            {ind.certified ? (
              <Badge style={{ backgroundColor: "#E06D00", color: "white" }} data-testid={`industry-certified-${ind.vertical}`}>
                <Award className="mr-1 h-3.5 w-3.5" /> Certified
              </Badge>
            ) : ind.eligible ? (
              <Button
                size="sm"
                onClick={() => onStartVertical(ind.vertical)}
                disabled={starting}
                style={{ backgroundColor: "#E06D00", color: "white" }}
                data-testid={`button-start-industry-${ind.vertical}`}
              >
                {starting ? "Preparing…" : "Start exam"}
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid={`industry-locked-${ind.vertical}`}>
                <Lock className="h-3.5 w-3.5" /> Locked
              </span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function WrittenExam({
  exam,
  answers,
  setAnswer,
  onSubmit,
  submitting,
}: {
  exam: StartResponse;
  answers: Record<string, string>;
  setAnswer: (id: string, value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const answeredCount = exam.questions.filter((q) => (answers[q.id] ?? "").trim() !== "").length;
  return (
    <div className="space-y-4" data-testid="written-exam">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{exam.credential} - written test</CardTitle>
          <CardDescription>
            {exam.total} questions. You need {exam.passMark} correct to pass. Answered {answeredCount} of {exam.total}.
          </CardDescription>
        </CardHeader>
      </Card>
      {exam.questions.map((q, i) => (
        <Card key={q.id} data-testid={`question-${q.id}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex gap-2">
              <span className="text-muted-foreground">{i + 1}.</span>
              <span>{q.prompt}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {q.type === "multiple_choice" && (
              <RadioGroup
                value={answers[q.id] ?? ""}
                onValueChange={(v) => setAnswer(q.id, v)}
                data-testid={`options-${q.id}`}
              >
                {q.options.map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <RadioGroupItem value={String(idx)} id={`${q.id}-${idx}`} data-testid={`option-${q.id}-${idx}`} />
                    <Label htmlFor={`${q.id}-${idx}`} className="text-sm font-normal">{opt}</Label>
                  </div>
                ))}
              </RadioGroup>
            )}
            {q.type === "fill_blank" && (
              <Input
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswer(q.id, e.target.value)}
                placeholder="Your answer"
                data-testid={`input-${q.id}`}
              />
            )}
            {q.type === "written" && (
              <Textarea
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswer(q.id, e.target.value)}
                placeholder="Write your answer"
                className="min-h-[80px]"
                data-testid={`textarea-${q.id}`}
              />
            )}
          </CardContent>
        </Card>
      ))}
      <div className="flex justify-end">
        <Button
          onClick={onSubmit}
          disabled={submitting}
          style={{ backgroundColor: "#E06D00", color: "white" }}
          data-testid="button-submit-written"
        >
          {submitting ? "Grading…" : "Submit written test"}
        </Button>
      </div>
    </div>
  );
}

function WrittenResultCard({
  result,
  credential,
  onStartScenario,
  onRetake,
}: {
  result: WrittenResult;
  credential: string;
  onStartScenario: (sessionId: number) => void;
  onRetake: () => void;
}) {
  return (
    <Card className="border-2" style={{ borderColor: result.writtenPassed ? "#E06D00" : undefined }} data-testid="card-written-result">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {result.writtenPassed ? (
            <CheckCircle2 className="w-5 h-5" style={{ color: "#E06D00" }} />
          ) : (
            <XCircle className="w-5 h-5 text-destructive" />
          )}
          {result.writtenPassed ? "Written test passed" : "Written test not passed"}
        </CardTitle>
        <CardDescription data-testid="text-written-score">
          You scored {result.correct} of {result.total} ({result.writtenScore}%). Passing is {result.passMark}/{result.total} ({result.passPercent}%).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {result.writtenPassed && result.scenarioSessionId ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Final step: complete the expert-level roleplay and score 85+ to earn {credential}.
            </p>
            <Button
              onClick={() => onStartScenario(result.scenarioSessionId!)}
              style={{ backgroundColor: "#E06D00", color: "white" }}
              data-testid="button-start-final-scenario"
            >
              Start final conversation
            </Button>
          </div>
        ) : (
          <Button variant="outline" onClick={onRetake} data-testid="button-retake-written">
            Retake written test
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
