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
import type { RealConversation, RubricScores } from "@shared/schema";

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

type SubmissionType = "text_chat" | "email";

const SUBMISSION_LABELS: Record<SubmissionType, string> = {
  text_chat: "Text / SMS / chat",
  email: "Email thread",
};

function parseServerMessage(raw?: string): string | undefined {
  if (!raw) return undefined;
  // apiRequest throws "<status>: <body>"; strip the status prefix for display.
  const match = raw.match(/^\d+:\s*([\s\S]*)$/);
  return (match ? match[1] : raw).trim() || undefined;
}

// Read-only rubric breakdown, mirroring the practice results layout.
function ScoreBreakdown({ conversation }: { conversation: RealConversation }) {
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
            <p className="text-sm">
              <span className="font-medium">Where it stalled: </span>
              <span data-testid="text-real-stalled-step">{conversation.stalledStep}</span>
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
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [result, setResult] = useState<RealConversation | null>(null);

  const historyKey = ["/api/real-conversations", user?.id];
  const { data: history, isLoading: historyLoading } = useQuery<RealConversation[]>({
    queryKey: historyKey,
    enabled: !!user?.id,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/real-conversations?userId=${user!.id}`);
      return res.json();
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/real-conversations", {
        userId: user!.id,
        submissionType,
        rawTranscript,
        consentAccepted,
      });
      return res.json() as Promise<RealConversation>;
    },
    onSuccess: (data) => {
      setResult(data);
      setRawTranscript("");
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

  const canSubmit = consentAccepted && rawTranscript.trim().length > 0 && !submit.isPending;

  return (
    <AppShell title="Score a Real Conversation">
      <div className="space-y-6 max-w-2xl">
        <p className="text-sm text-muted-foreground" data-testid="text-real-intro">
          Paste a real discovery conversation and get it scored against the same SOLVE
          rubric used in discovery practice. Reps submit their own conversations only.
        </p>

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
              {submit.isPending ? "Scoring…" : "Score conversation"}
            </Button>
          </CardContent>
        </Card>

        {result && <ScoreBreakdown conversation={result} />}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Your Real Conversations</CardTitle>
          </CardHeader>
          <CardContent>
            {historyLoading ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : !history || history.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-real-empty">
                You haven't scored any real conversations yet.
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
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {SUBMISSION_LABELS[rc.submissionType as SubmissionType] ?? rc.submissionType}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(rc.createdAt).toLocaleString()}
                      </p>
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
