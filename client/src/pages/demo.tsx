import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { getAvatarUrl } from "@/lib/avatars";
import { useVoiceConversation } from "@/hooks/use-voice-conversation";
import {
  demoApi,
  parseTranscript,
  type DemoScenario,
  type DemoSession,
} from "@/lib/demoApi";
import {
  Volume2,
  Send,
  Loader2,
  AlertCircle,
  RotateCcw,
  Mic,
  MicOff,
  User,
  Phone,
  CheckCircle2,
} from "lucide-react";
import type {
  RubricScores,
  LeadershipRubricScores,
  TranscriptMessage,
} from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Same rubric labels the trainee results page uses, so the demo scores against
// the identical rubric.
const RUBRIC_LABELS: Record<keyof RubricScores, string> = {
  needsDiscovery: "Needs discovery (drill vs. the hole)",
  objectionPrevention: "Objection prevention via early discovery",
  trustBuilding: "Trust building",
  naturalClose: "Natural, decision-focused close",
  relationshipContinuity: "Relationship continuity / follow-up",
};
const LEADERSHIP_RUBRIC_LABELS: Record<keyof LeadershipRubricScores, string> = {
  activeListening: "Active listening (let them fully vent)",
  empathyAcknowledgment: "Empathy / acknowledged the feeling",
  rootCauseDiscovery: "Root-cause discovery",
  solutionVisualization: "Co-created the solution",
  blamelessResolution: "Blameless resolution",
};
function isLeadershipRubric(r: Record<string, number>): r is LeadershipRubricScores {
  return "activeListening" in r;
}

type Step = "landing" | "email" | "code" | "roleplay" | "results";

export default function Demo() {
  const [step, setStep] = useState<Step>("landing");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [finalSession, setFinalSession] = useState<DemoSession | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        {step === "landing" && (
          <Landing onStart={() => setStep("email")} />
        )}
        {step === "email" && (
          <EmailStep
            email={email}
            setEmail={setEmail}
            onSent={() => setStep("code")}
            onLimitReached={() => {
              setLimitReached(true);
              setStep("results");
            }}
          />
        )}
        {step === "code" && (
          <CodeStep
            email={email}
            onVerified={(tok) => {
              setToken(tok);
              setStep("roleplay");
            }}
            onLimitReached={() => {
              setLimitReached(true);
              setStep("results");
            }}
            onBack={() => setStep("email")}
          />
        )}
        {step === "roleplay" && token && (
          <StartAndPlay
            token={token}
            onCompleted={(s) => {
              setFinalSession(s);
              setStep("results");
            }}
            onLimitReached={() => {
              setLimitReached(true);
              setStep("results");
            }}
          />
        )}
        {step === "results" && (
          <ResultsAndCta
            session={finalSession}
            email={email}
            limitReached={limitReached}
          />
        )}
      </div>
    </div>
  );
}

function Landing({ onStart }: { onStart: () => void }) {
  return (
    <div className="space-y-6 text-center">
      <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
        <Phone className="h-3.5 w-3.5" /> Free live voice roleplay
      </div>
      <h1 className="text-3xl font-bold tracking-tight" data-testid="text-demo-heading">
        Practice a real estate discovery call — out loud, right now.
      </h1>
      <p className="mx-auto max-w-xl text-muted-foreground">
        Step into the role of the real estate agent. Our AI plays a motivated
        buyer who needs to purchase a home within the next 30 days. Talk to them
        like a real call, uncover what they actually need, and get scored on your
        discovery. It's a beginner-friendly conversation, and it's completely free —
        no signup required.
      </p>
      <ul className="mx-auto max-w-md space-y-2 text-left text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          Speak naturally — the buyer talks back with a real voice.
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          End the call whenever you like and get instant scored feedback.
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          3 free sessions per email — no credit card, no obligation.
        </li>
      </ul>
      <Button size="lg" onClick={onStart} data-testid="button-demo-start">
        Start my free voice roleplay
      </Button>
    </div>
  );
}

function EmailStep({
  email,
  setEmail,
  onSent,
  onLimitReached,
}: {
  email: string;
  setEmail: (v: string) => void;
  onSent: () => void;
  onLimitReached: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const requestCode = useMutation({
    mutationFn: () => demoApi.requestCode(email),
    onSuccess: (data) => {
      setError(null);
      if (data.limitReached) {
        onLimitReached();
      } else {
        onSent();
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h2 className="text-2xl font-semibold" data-testid="text-email-heading">
        Where should we send your access code?
      </h2>
      <p className="text-sm text-muted-foreground">
        Enter your email and we'll send a 6-digit code to start your free demo.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) requestCode.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="demo-email">Email</Label>
          <Input
            id="demo-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            data-testid="input-demo-email"
          />
        </div>
        {error && (
          <p className="text-sm text-destructive" data-testid="text-email-error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={!email.trim() || requestCode.isPending}
          data-testid="button-send-code"
        >
          {requestCode.isPending ? "Sending code..." : "Send my code"}
        </Button>
      </form>
    </div>
  );
}

function CodeStep({
  email,
  onVerified,
  onLimitReached,
  onBack,
}: {
  email: string;
  onVerified: (token: string) => void;
  onLimitReached: () => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const verify = useMutation({
    mutationFn: () => demoApi.verify(email, code),
    onSuccess: (data) => {
      setError(null);
      if (data.limitReached || !data.token) {
        onLimitReached();
      } else {
        onVerified(data.token);
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  const resend = useMutation({
    mutationFn: () => demoApi.requestCode(email),
    onSuccess: (data) => {
      if (data.limitReached) onLimitReached();
      else {
        setResent(true);
        setError(null);
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h2 className="text-2xl font-semibold" data-testid="text-code-heading">
        Enter your 6-digit code
      </h2>
      <p className="text-sm text-muted-foreground">
        We sent a code to <span className="font-medium text-foreground">{email}</span>. It
        expires in 10 minutes.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) verify.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="demo-code">Access code</Label>
          <Input
            id="demo-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Enter your 6-digit code"
            maxLength={6}
            data-testid="input-demo-code"
          />
          <p className="text-sm text-muted-foreground" data-testid="text-code-help">
            Check your email for your verification code. If it's not in your
            inbox, look in your spam or junk folder.
          </p>
        </div>
        {error && (
          <p className="text-sm text-destructive" data-testid="text-code-error">
            {error}
          </p>
        )}
        {resent && !error && (
          <p className="text-sm text-muted-foreground" data-testid="text-code-resent">
            A new code is on its way.
          </p>
        )}
        <Button
          type="submit"
          className={`w-full transition-shadow ${
            code.trim().length === 6 ? "shadow-md" : ""
          }`}
          disabled={!code.trim() || verify.isPending}
          data-testid="button-verify-code"
        >
          {verify.isPending ? "Verifying..." : "Verify & start"}
        </Button>
      </form>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={onBack}
          data-testid="button-code-back"
        >
          Use a different email
        </button>
        <button
          type="button"
          className="text-primary hover:underline disabled:opacity-50"
          onClick={() => resend.mutate()}
          disabled={resend.isPending}
          data-testid="button-resend-code"
        >
          {resend.isPending ? "Resending..." : "Resend code"}
        </button>
      </div>
    </div>
  );
}

// Starts the session (increments usage server-side) then renders the live
// roleplay. Kept as its own component so the start mutation runs exactly once on
// mount.
function StartAndPlay({
  token,
  onCompleted,
  onLimitReached,
}: {
  token: string;
  onCompleted: (s: DemoSession) => void;
  onLimitReached: () => void;
}) {
  const [started, setStarted] = useState<{
    session: DemoSession;
    scenario: DemoScenario;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const start = useMutation({
    mutationFn: () => demoApi.startSession(token),
    onSuccess: (data) => setStarted({ session: data.session, scenario: data.scenario }),
    onError: (e: Error & { limitReached?: boolean }) => {
      if (e.limitReached) onLimitReached();
      else setError(e.message);
    },
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-md space-y-4 text-center">
        <p className="text-destructive" data-testid="text-start-error">{error}</p>
        <Button
          onClick={() => {
            setError(null);
            start.mutate();
          }}
          data-testid="button-start-retry"
        >
          Try again
        </Button>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Connecting you to the buyer...
      </div>
    );
  }

  return (
    <Roleplay
      token={token}
      initialSession={started.session}
      scenario={started.scenario}
      onCompleted={onCompleted}
    />
  );
}

function Roleplay({
  token,
  initialSession,
  scenario,
  onCompleted,
}: {
  token: string;
  initialSession: DemoSession;
  scenario: DemoScenario;
  onCompleted: (s: DemoSession) => void;
}) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const voiceRef = useRef<ReturnType<typeof useVoiceConversation> | null>(null);
  const avatarUrl = getAvatarUrl(scenario.slug);
  const sessionId = initialSession.id;

  const sendMessage = useMutation({
    mutationFn: ({ content, withAudio }: { content: string; withAudio: boolean }) =>
      demoApi.sendMessage(token, sessionId, content, withAudio),
    onSuccess: (updated: DemoSession) => {
      queryClient.setQueryData(["/api/demo/session", sessionId], updated);
      voiceRef.current?.handleReply(parseTranscript(updated.transcript));
      setLastFailedMessage(null);
    },
    onError: (_err, variables) => setLastFailedMessage(variables.content),
  });

  const voice = useVoiceConversation({
    send: (content, withAudio) => sendMessage.mutate({ content, withAudio }),
    isSending: sendMessage.isPending,
  });
  voiceRef.current = voice;

  const {
    draft,
    setDraft,
    voiceMode,
    speechSupported,
    micActive,
    voiceStatus,
    micLabel,
    pendingCount,
    handleMicTap,
    handleVoiceModeToggle,
    handleSend,
    syncPendingAudio,
  } = voice;

  const { data: session } = useQuery<DemoSession>({
    queryKey: ["/api/demo/session", sessionId],
    queryFn: () => demoApi.getSession(token, sessionId),
    initialData: initialSession,
    refetchInterval: () => (pendingCount > 0 ? 700 : false),
  });

  useEffect(() => {
    if (session) syncPendingAudio(parseTranscript(session.transcript));
  }, [session, syncPendingAudio]);

  const complete = useMutation({
    mutationFn: () => demoApi.complete(token, sessionId),
    onSuccess: (s) => onCompleted(s),
  });

  const transcript: TranscriptMessage[] = parseTranscript(session?.transcript);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript.length]);

  return (
    <div className="flex h-[80vh] flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Buyer"
              className="h-10 w-10 shrink-0 rounded-full border object-cover"
              data-testid="img-demo-avatar"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-muted">
              <User className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </div>
          )}
          <p className="truncate text-sm text-muted-foreground">
            Ask open questions and uncover what the buyer really needs.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Volume2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Label htmlFor="demo-voice-toggle" className="text-xs text-muted-foreground">
            Voice mode
          </Label>
          <Switch
            id="demo-voice-toggle"
            checked={voiceMode}
            onCheckedChange={handleVoiceModeToggle}
            data-testid="switch-demo-voice"
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
        data-testid="container-demo-transcript"
      >
        {transcript.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Greet the buyer to begin the conversation.
          </p>
        )}
        {transcript.map((m, i) => (
          <div key={i} className={`flex ${m.role === "consultant" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.role === "consultant"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
              }`}
              data-testid={`demo-message-${m.role}-${i}`}
            >
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <p className="text-xs opacity-70">{m.role === "consultant" ? "You" : "Buyer"}</p>
                {m.role === "customer" && m.audioStatus === "pending" && (
                  <Loader2 className="h-3 w-3 animate-spin opacity-50" aria-label="Voice loading" />
                )}
                {m.role === "customer" && m.audioStatus === "ready" && m.audioUrl && (
                  <button
                    onClick={() => new Audio(`${API_BASE}${m.audioUrl}`).play().catch(() => {})}
                    className="opacity-60 transition-opacity hover:opacity-100"
                    aria-label="Replay voice"
                    data-testid={`button-demo-replay-${i}`}
                  >
                    <Volume2 className="h-3 w-3" />
                  </button>
                )}
              </div>
              <p>{m.content}</p>
            </div>
          </div>
        ))}
        {sendMessage.isPending && (
          <div className="flex justify-start">
            <div className="flex max-w-[80%] items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Buyer is responding...
            </div>
          </div>
        )}
        {lastFailedMessage && !sendMessage.isPending && (
          <div className="flex justify-start">
            <div className="flex max-w-[80%] flex-wrap items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>That message didn't go through.</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1"
                onClick={() => sendMessage.mutate({ content: lastFailedMessage, withAudio: voiceMode })}
                data-testid="button-demo-retry"
              >
                <RotateCcw className="h-3 w-3" /> Retry
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-3 border-t p-3">
        {voiceStatus && (
          <p className="text-xs text-muted-foreground" data-testid="text-demo-voice-status">
            {voiceStatus}
          </p>
        )}
        <div className="flex gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={micActive ? "Listening..." : speechSupported ? "Type or tap the mic to speak..." : "Type what you'd say to the buyer..."}
            className="max-h-32 min-h-[44px] resize-none"
            data-testid="input-demo-message"
          />
          {speechSupported && (
            <Button
              onClick={handleMicTap}
              disabled={sendMessage.isPending}
              size="icon"
              variant={micActive ? "default" : "outline"}
              aria-label={micLabel}
              aria-pressed={micActive}
              className={micActive ? "animate-pulse" : undefined}
              data-testid="button-demo-mic"
            >
              {micActive ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          )}
          <Button
            onClick={handleSend}
            disabled={!draft.trim() || sendMessage.isPending}
            size="icon"
            aria-label="Send message"
            data-testid="button-demo-send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              voice.stopAudio();
              complete.mutate();
            }}
            disabled={transcript.length === 0 || complete.isPending}
            data-testid="button-demo-complete"
          >
            {complete.isPending ? "Scoring..." : "End & score this call"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ResultsAndCta({
  session,
  email,
  limitReached,
}: {
  session: DemoSession | null;
  email: string;
  limitReached: boolean;
}) {
  const rubric: Record<string, number> | null = session?.rubricScores
    ? parseRubric(session.rubricScores)
    : null;
  const rubricLabels: Record<string, string> =
    rubric && isLeadershipRubric(rubric) ? LEADERSHIP_RUBRIC_LABELS : RUBRIC_LABELS;

  return (
    <div className="space-y-6">
      {limitReached ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">You've used all 3 free sessions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p data-testid="text-limit-reached">
              Thanks for practicing with the free demo! You've completed all 3 free
              voice roleplay sessions for <span className="font-medium text-foreground">{email}</span>.
              To keep training with unlimited conversations and your whole team, grab
              full access below.
            </p>
          </CardContent>
        </Card>
      ) : (
        session && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-lg">
                  Your discovery score
                  <span className="text-2xl font-semibold" data-testid="text-demo-score">
                    {session.score ?? "-"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground" data-testid="text-demo-feedback">
                  {session.feedback}
                </p>
              </CardContent>
            </Card>
            {rubric && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {Object.keys(rubricLabels).map((key) => (
                    <div key={key} className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span>{rubricLabels[key]}</span>
                        <span className="text-muted-foreground" data-testid={`text-demo-rubric-${key}`}>
                          {rubric[key]}
                        </span>
                      </div>
                      <Progress value={rubric[key]} />
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )
      )}

      <CtaForm email={email} />
    </div>
  );
}

function CtaForm({ email }: { email: string }) {
  const [name, setName] = useState("");
  const [leadEmail, setLeadEmail] = useState(email);
  const [company, setCompany] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Mirror the server-side wording so the on-screen question matches what gets
  // recorded on the lead. "seats" stays internal; the visitor sees users/roles.
  // The demo scenario is always real-estate (consulting track), so the wording is
  // "users or consultants" — the server computes the authoritative copy on save.
  const seatQuestion = "How many users or consultants do you want on your team?";

  const submit = useMutation({
    mutationFn: () =>
      demoApi.submitLead({
        name,
        email: leadEmail,
        company: company || undefined,
        teamSize: teamSize || undefined,
        message: message || undefined,
      }),
    onError: (e: Error) => setError(e.message),
  });

  if (submit.isSuccess) {
    return (
      <Card>
        <CardContent className="space-y-2 py-6 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-primary" />
          <p className="font-medium" data-testid="text-cta-success">Thanks — we'll be in touch shortly.</p>
          <p className="text-sm text-muted-foreground">
            A member of our team will reach out about full access for your team.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" data-testid="text-cta-heading">
          Get full access for your team
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">
          Unlimited conversations, every difficulty level, and progress tracking come
          with a paid plan. Tell us about your team and we'll set you up.
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && leadEmail.trim()) submit.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cta-name">Name</Label>
            <Input id="cta-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-cta-name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cta-email">Email</Label>
            <Input id="cta-email" type="email" value={leadEmail} onChange={(e) => setLeadEmail(e.target.value)} data-testid="input-cta-email" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cta-company">Company (optional)</Label>
            <Input id="cta-company" value={company} onChange={(e) => setCompany(e.target.value)} data-testid="input-cta-company" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cta-team">{seatQuestion}</Label>
            <Input id="cta-team" value={teamSize} onChange={(e) => setTeamSize(e.target.value)} placeholder="e.g. 5" data-testid="input-cta-team" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cta-message">Anything else? (optional)</Label>
            <Textarea id="cta-message" value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[72px]" data-testid="input-cta-message" />
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="text-cta-error">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={!name.trim() || !leadEmail.trim() || submit.isPending}
            data-testid="button-cta-submit"
          >
            {submit.isPending ? "Submitting..." : "Get full access"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function parseRubric(json: string): Record<string, number> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
