import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/app-shell";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { averageScore } from "@shared/scoreStats";
import type { RealConversation, RubricScores, Session } from "@shared/schema";

// Same practice rubric labels used on the practice results screen, so a scored
// real conversation reads identically to a scored practice session.
const RUBRIC_LABELS: Record<keyof RubricScores, string> = {
  needsDiscovery: "Needs discovery (drill vs. the hole)",
  objectionPrevention: "Objection prevention via early discovery",
  trustBuilding: "Trust building",
  naturalClose: "Natural, decision-focused close",
  relationshipContinuity: "Relationship continuity / follow-up",
};

// The exact consent language the rep must agree to. Must match the server
// constant (REAL_CONVERSATION_CONSENT_TEXT) byte-for-byte.
const CONSENT_TEXT =
  "I have the legal right to submit this conversation, including any required consent to its recording.";

// The server decorates each returned row with attribution: who submitted it and
// whether that was a manager acting on the rep's behalf. Plain rows (the POST
// response) omit these, which reads as a self-submission.
type DecoratedRealConversation = RealConversation & {
  submittedByName?: string | null;
  managerSubmitted?: boolean;
};

type SubmissionType = "text_chat" | "email" | "audio";

// A manager/QA can open this page pre-targeted at one of their reps via query
// params set by the roster's "Submit real conversation for ..." button.
function initialTargetRep(): { id: number; name: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get("repId"));
  const name = params.get("repName");
  if (!Number.isInteger(id) || id <= 0) return null;
  return { id, name: name ?? `rep #${id}` };
}

const SUBMISSION_LABELS: Record<SubmissionType, string> = {
  text_chat: "Text / SMS / chat",
  email: "Email thread",
  audio: "Upload audio",
};

// Audio upload limits, kept in sync with the server (MAX_AUDIO_BYTES,
// MAX_AUDIO_DURATION_SECONDS, ALLOWED_AUDIO_EXTENSIONS in server/realConversations.ts).
// Client-side checks are a courtesy fast-fail; the server re-enforces all of them.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 30 * 60;
const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav"];

function hasAllowedAudioExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Best-effort duration read via the browser Audio API. Resolves to null when the
// browser can't determine it, in which case we defer to the server's check.
function readAudioDurationSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    audio.src = url;
  });
}

function parseServerMessage(raw?: string): string | undefined {
  if (!raw) return undefined;
  // apiRequest throws "<status>: <body>"; strip the status prefix for display.
  const match = raw.match(/^\d+:\s*([\s\S]*)$/);
  return (match ? match[1] : raw).trim() || undefined;
}

// Read-only rubric breakdown, mirroring the practice results layout.
function ScoreBreakdown({ conversation }: { conversation: DecoratedRealConversation }) {
  const rubric: Record<string, number> | null = conversation.rubricScores
    ? JSON.parse(conversation.rubricScores)
    : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center justify-between">
            Overall discovery score
            <span className="text-2xl font-semibold" data-testid="text-real-overall-score">
              {conversation.overallScore ?? "-"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground" data-testid="text-real-feedback">
            {conversation.feedback}
          </p>
          {conversation.stalledStep && (
            <p className="text-sm flex items-center gap-2">
              <span className="font-medium">Where it stalled: </span>
              <span
                className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
                style={{ backgroundColor: "#E06D00" }}
                data-testid="text-real-stalled-step"
              >
                {conversation.stalledStep}
              </span>
            </p>
          )}
          {conversation.managerSubmitted && (
            <p className="text-sm" data-testid="text-real-attribution">
              <span className="font-medium">Submitted by your manager</span>
              {conversation.submittedByName ? ` (${conversation.submittedByName})` : ""}
            </p>
          )}
          <p className="text-xs font-medium" style={{ color: "#E06D00" }}>
            Scored by SOLVE Coach™
          </p>
        </CardContent>
      </Card>

      {rubric && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(Object.keys(RUBRIC_LABELS) as (keyof RubricScores)[]).map((key) => (
              <div key={key} className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span>{RUBRIC_LABELS[key]}</span>
                  <span className="text-muted-foreground" data-testid={`text-real-rubric-${key}`}>
                    {rubric[key]}
                  </span>
                </div>
                <Progress value={rubric[key]} data-testid={`progress-real-${key}`} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function RealConversations() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [submissionType, setSubmissionType] = useState<SubmissionType>("text_chat");
  const [rawTranscript, setRawTranscript] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [result, setResult] = useState<DecoratedRealConversation | null>(null);

  // Manager/QA acting on behalf of a rep. Null means the rep is submitting their
  // own conversation (the default). Managers reach the pre-targeted flow from the
  // roster's Field view.
  const isManager = user?.role === "manager" || user?.role === "qa";
  const [targetRep] = useState(() => (isManager ? initialTargetRep() : null));

  const historyKey = ["/api/real-conversations", user?.id];
  const { data: history, isLoading: historyLoading } = useQuery<DecoratedRealConversation[]>({
    queryKey: historyKey,
    enabled: !!user?.id,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/real-conversations?userId=${user!.id}`);
      return res.json();
    },
  });

  // The rep's practice-session history, shown as its own section alongside (but
  // visually separate from) Real Conversations. Read-only; nothing here touches
  // practice scoring or pricing.
  const { data: sessions, isLoading: sessionsLoading } = useQuery<Session[]>({
    queryKey: ["/api/users", user?.id, "sessions"],
    enabled: !!user?.id,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/users/${user!.id}/sessions`);
      return res.json();
    },
  });
  const completedSessions = (sessions ?? []).filter((s) => s.status === "completed");

  // All-time running averages for each section, computed client-side from the
  // list responses (null when there is nothing scored yet, so we can show a clear
  // empty state rather than a misleading 0).
  const realConversationAverage = averageScore((history ?? []).map((rc) => rc.overallScore));
  const practiceAverage = averageScore(completedSessions.map((s) => s.score));

  const submit = useMutation({
    mutationFn: async () => {
      if (submissionType === "audio") {
        // Audio is a multipart upload to a dedicated route, so it can't go
        // through apiRequest (which sends JSON). Whisper transcription then the
        // same scoring pipeline runs server-side.
        const form = new FormData();
        form.append("userId", String(user!.id));
        if (targetRep) form.append("subjectRepUserId", String(targetRep.id));
        form.append("consentAccepted", String(consentAccepted));
        form.append("audio", audioFile!, audioFile!.name);
        const res = await fetch("/api/real-conversations/audio", {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const text = (await res.text()) || res.statusText;
          throw new Error(`${res.status}: ${text}`);
        }
        return res.json() as Promise<RealConversation>;
      }
      const res = await apiRequest("POST", "/api/real-conversations", {
        userId: user!.id,
        ...(targetRep ? { subjectRepUserId: targetRep.id } : {}),
        submissionType,
        rawTranscript,
        consentAccepted,
      });
      return res.json() as Promise<RealConversation>;
    },
    onSuccess: (data) => {
      setResult(data);
      setRawTranscript("");
      setAudioFile(null);
      setConsentAccepted(false);
      queryClient.invalidateQueries({ queryKey: historyKey });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't score that conversation",
        description:
          parseServerMessage(err?.message) ??
          "Something went wrong scoring your conversation. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Validate a chosen audio file client-side (type, size, best-effort duration)
  // before storing it, surfacing a clear toast on rejection. The server enforces
  // all of these again regardless.
  const handleAudioSelected = async (file: File | null) => {
    if (!file) {
      setAudioFile(null);
      return;
    }
    if (!hasAllowedAudioExtension(file.name)) {
      toast({
        title: "Unsupported file type",
        description: "Upload an mp3, m4a, or wav file.",
        variant: "destructive",
      });
      setAudioFile(null);
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      toast({
        title: "File is too large",
        description: "The maximum audio size is 25MB.",
        variant: "destructive",
      });
      setAudioFile(null);
      return;
    }
    const duration = await readAudioDurationSeconds(file);
    if (duration !== null && duration > MAX_AUDIO_DURATION_SECONDS) {
      toast({
        title: "Recording is too long",
        description: "Audio must be 30 minutes or shorter.",
        variant: "destructive",
      });
      setAudioFile(null);
      return;
    }
    setAudioFile(file);
  };

  const hasContent =
    submissionType === "audio" ? audioFile !== null : rawTranscript.trim().length > 0;
  const canSubmit = consentAccepted && hasContent && !submit.isPending;

  return (
    <AppShell title="Score a Real Conversation">
      <div className="space-y-6 max-w-2xl">
        <p className="text-sm text-muted-foreground" data-testid="text-real-intro">
          Paste or upload a real discovery conversation and get it scored against the same
          SOLVE rubric used in discovery practice.
        </p>

        {targetRep && (
          <div
            className="rounded-lg border p-3 text-sm"
            style={{ borderColor: "#E06D00" }}
            data-testid="banner-on-behalf"
          >
            You are submitting this conversation on behalf of{" "}
            <span className="font-semibold">{targetRep.name}</span>. The score will appear in
            their Real Conversations history, attributed to you.
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Submit a conversation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>How was this conversation captured?</Label>
              <RadioGroup
                value={submissionType}
                onValueChange={(v) => setSubmissionType(v as SubmissionType)}
                className="flex flex-col gap-2"
              >
                {(Object.keys(SUBMISSION_LABELS) as SubmissionType[]).map((t) => (
                  <div key={t} className="flex items-center gap-2">
                    <RadioGroupItem value={t} id={`submission-${t}`} data-testid={`radio-${t}`} />
                    <Label htmlFor={`submission-${t}`} className="font-normal cursor-pointer">
                      {SUBMISSION_LABELS[t]}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            {submissionType === "audio" ? (
              <div className="space-y-2">
                <Label htmlFor="audio-file">Upload the recording</Label>
                <input
                  id="audio-file"
                  type="file"
                  accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav"
                  onChange={(e) => handleAudioSelected(e.target.files?.[0] ?? null)}
                  disabled={submit.isPending}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white file:cursor-pointer"
                  data-testid="input-audio-file"
                />
                <style>{`#audio-file::file-selector-button{background-color:#E06D00}`}</style>
                <p className="text-xs text-muted-foreground">
                  mp3, m4a, or wav. Up to 25MB, about 30 minutes. Transcription can take a
                  minute for longer recordings.
                </p>
                {audioFile && (
                  <p className="text-sm font-medium" data-testid="text-audio-filename">
                    Selected: {audioFile.name}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="raw-transcript">Paste the conversation</Label>
                <Textarea
                  id="raw-transcript"
                  value={rawTranscript}
                  onChange={(e) => setRawTranscript(e.target.value)}
                  rows={12}
                  placeholder={
                    submissionType === "email"
                      ? "Paste the full email thread here."
                      : "Paste the text/SMS/chat conversation here. Prefix lines with a speaker label (e.g. 'Me:' / 'Customer:') for the most accurate scoring."
                  }
                  data-testid="input-raw-transcript"
                />
              </div>
            )}

            <div className="flex items-start gap-3">
              <Checkbox
                id="consent"
                checked={consentAccepted}
                onCheckedChange={(v) => setConsentAccepted(v === true)}
                data-testid="checkbox-consent"
              />
              <Label htmlFor="consent" className="text-sm font-normal leading-snug cursor-pointer">
                {CONSENT_TEXT}
              </Label>
            </div>

            <Button
              onClick={() => submit.mutate()}
              disabled={!canSubmit}
              data-testid="button-submit-real-conversation"
            >
              {submit.isPending
                ? submissionType === "audio"
                  ? "Transcribing and scoring…"
                  : "Scoring…"
                : "Score conversation"}
            </Button>
          </CardContent>
        </Card>

        {result && <ScoreBreakdown conversation={result} />}

        {/* The rep's history, split into two clearly separate sections: their
            practice sessions and their Real Conversations. The Real Conversations
            section is deliberately given a distinct orange-accented card so it
            never reads as just more rows in the practice list. */}
        <Card data-testid="section-practice-sessions">
          <CardHeader>
            <CardTitle className="text-lg flex items-center justify-between gap-3">
              Practice Sessions
              {practiceAverage !== null && (
                <span className="text-sm font-normal text-muted-foreground" data-testid="text-practice-average">
                  Average: {practiceAverage}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sessionsLoading ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : completedSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-practice-empty">
                No completed practice sessions yet.
              </p>
            ) : (
              <ul className="divide-y" data-testid="list-practice-sessions">
                {completedSessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 py-3"
                    data-testid={`row-practice-session-${s.id}`}
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium">Practice session</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(s.completedAt ?? s.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="text-lg font-semibold shrink-0">{s.score ?? "-"}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card
          className="border-2 overflow-hidden"
          style={{ borderColor: "#E06D00" }}
          data-testid="section-real-conversations"
        >
          <div className="px-6 py-4" style={{ backgroundColor: "#0A1A30" }}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-white">Real Conversations</h2>
              {realConversationAverage !== null && (
                <div className="flex items-baseline gap-2 shrink-0">
                  <span className="text-xs uppercase tracking-wide text-white/60">
                    Real Conversation Average
                  </span>
                  <span
                    className="text-3xl font-bold leading-none"
                    style={{ color: "#F1830D" }}
                    data-testid="text-real-average"
                  >
                    {realConversationAverage}
                  </span>
                </div>
              )}
            </div>
          </div>
          <CardContent className="pt-6">
            {historyLoading ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : !history || history.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-real-empty">
                No real conversations scored yet.
              </p>
            ) : (
              <ul className="divide-y" data-testid="list-real-conversations">
                {history.map((rc) => (
                  <li
                    key={rc.id}
                    className="flex items-center justify-between gap-3 py-3 cursor-pointer hover-elevate"
                    onClick={() => setResult(rc)}
                    data-testid={`row-real-conversation-${rc.id}`}
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium">
                        {SUBMISSION_LABELS[rc.submissionType as SubmissionType] ?? rc.submissionType}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(rc.createdAt).toLocaleString()}
                      </p>
                      {rc.stalledStep && (
                        <p className="text-xs flex items-center gap-2" data-testid={`text-row-stalled-${rc.id}`}>
                          <span className="text-muted-foreground">Stalled at: </span>
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                            style={{ backgroundColor: "#E06D00" }}
                          >
                            {rc.stalledStep}
                          </span>
                        </p>
                      )}
                      {rc.managerSubmitted && (
                        <p
                          className="text-xs font-medium"
                          style={{ color: "#E06D00" }}
                          data-testid={`text-row-attribution-${rc.id}`}
                        >
                          Submitted by your manager{rc.submittedByName ? ` (${rc.submittedByName})` : ""}
                        </p>
                      )}
                    </div>
                    <span className="text-lg font-semibold shrink-0">{rc.overallScore ?? "-"}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
