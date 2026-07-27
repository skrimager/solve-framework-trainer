// Demo v2 page. Same structural components and styling as the original demo page
// but a different shape of flow: the visitor picks an industry, runs their one
// free conversation, and then lands on the membership / pay-per-session fork.
// Copied and adapted from client/src/pages/demo.tsx rather than importing from
// it, so the original demo cannot be broken by changes here.
import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
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
  demoV2Api,
  parseTranscript,
  type DemoV2Industry,
  type DemoV2Scenario,
  type DemoV2Session,
} from "@/lib/demoV2Api";
import { getDeviceFingerprint } from "@/lib/fingerprint";
import {
  MEMBER_OPTION,
  MEMBER_SIGNUP_PATH,
  PAY_PER_SESSION_INTEREST,
  PAY_PER_SESSION_OPTION,
} from "@/lib/demoPaywall";
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
  X,
} from "lucide-react";
import type {
  RubricScores,
  LeadershipRubricScores,
  TranscriptMessage,
} from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// The same rubric labels the trainee results page uses, so the demo reads against
// the identical rubric it is scored on.
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

type Step = "landing" | "email" | "code" | "industry" | "roleplay" | "results";

// Brand palette (shared with the rest of the app).
const ORANGE = "#E06D00";

export default function DemoV2() {
  const [step, setStep] = useState<Step>("landing");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [industry, setIndustry] = useState<string | null>(null);
  const [finalSession, setFinalSession] = useState<DemoV2Session | null>(null);
  const [stalledStep, setStalledStep] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        {step === "landing" && <Landing onStart={() => setStep("email")} />}

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
              setStep("industry");
            }}
            onLimitReached={() => {
              setLimitReached(true);
              setStep("results");
            }}
            onBack={() => setStep("email")}
          />
        )}

        {step === "industry" && (
          <IndustryStep
            onChoose={(key) => {
              setIndustry(key);
              setStep("roleplay");
            }}
          />
        )}

        {step === "roleplay" && token && industry && (
          <StartAndPlay
            token={token}
            industry={industry}
            onCompleted={(s, stalled) => {
              setFinalSession(s);
              setStalledStep(stalled);
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
            stalledStep={stalledStep}
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
        <Phone className="h-3.5 w-3.5" /> Free AI practice conversation
      </div>
      <h1 className="text-3xl font-bold tracking-tight" data-testid="text-demo-v2-heading">
        One free practice conversation. No credit card.
      </h1>
      <p className="mx-auto max-w-xl text-muted-foreground">
        Pick Auto or Real Estate, and our AI plays a customer whose real motivation
        sits underneath what they first ask for. Talk to them like a real call, dig
        for what they actually need, and get scored on your discovery.
      </p>

      <ul className="mx-auto max-w-md space-y-2 text-left text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          Choose the industry you actually sell in.
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          A customer whose real motivation is not what they open with.
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          Scored on the same rubric and the same standard as the full platform.
        </li>
      </ul>
      <Button size="lg" onClick={onStart} data-testid="button-demo-v2-start">
        Start my free practice
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
    mutationFn: () => demoV2Api.requestCode(email),
    onSuccess: (data) => {
      setError(null);
      if (data.limitReached) onLimitReached();
      else onSent();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h2 className="text-2xl font-semibold" data-testid="text-demo-v2-email-heading">
        Where should we send your access code?
      </h2>
      <p className="text-sm text-muted-foreground">
        Enter your email and we'll send a 6-digit code to start your free
        conversation.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) requestCode.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="demo-v2-email">Email</Label>
          <Input
            id="demo-v2-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            data-testid="input-demo-v2-email"
          />
        </div>
        {error && (
          <p className="text-sm text-destructive" data-testid="text-demo-v2-email-error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={!email.trim() || requestCode.isPending}
          data-testid="button-demo-v2-send-code"
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
    mutationFn: () => demoV2Api.verify(email, code),
    onSuccess: (data) => {
      setError(null);
      if (data.limitReached || !data.token) onLimitReached();
      else onVerified(data.token);
    },
    onError: (e: Error) => setError(e.message),
  });

  const resend = useMutation({
    mutationFn: () => demoV2Api.requestCode(email),
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
      <h2 className="text-2xl font-semibold" data-testid="text-demo-v2-code-heading">
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
          <Label htmlFor="demo-v2-code">Access code</Label>
          <Input
            id="demo-v2-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Enter your 6-digit code"
            maxLength={6}
            data-testid="input-demo-v2-code"
          />
          <p className="text-sm text-muted-foreground">
            Check your email for your verification code. If it's not in your inbox,
            look in your spam or junk folder.
          </p>
        </div>
        {error && (
          <p className="text-sm text-destructive" data-testid="text-demo-v2-code-error">
            {error}
          </p>
        )}
        {resent && !error && (
          <p className="text-sm text-muted-foreground">A new code is on its way.</p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={!code.trim() || verify.isPending}
          data-testid="button-demo-v2-verify-code"
        >
          {verify.isPending ? "Verifying..." : "Verify & start"}
        </Button>
      </form>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={onBack}
          data-testid="button-demo-v2-code-back"
        >
          Use a different email
        </button>
        <button
          type="button"
          className="text-primary hover:underline disabled:opacity-50"
          onClick={() => resend.mutate()}
          disabled={resend.isPending}
          data-testid="button-demo-v2-resend-code"
        >
          {resend.isPending ? "Resending..." : "Resend code"}
        </button>
      </div>
    </div>
  );
}

// The industry picker. Options come from the server so this list and the
// server's scenario pools cannot drift apart. The server hands over a customer
// the visitor has not met yet, which still matters for allowlisted emails and
// for any future paid session.
function IndustryStep({ onChoose }: { onChoose: (key: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const { data: options, isLoading, isError } = useQuery<DemoV2Industry[]>({
    queryKey: ["/api/demo/options"],
    queryFn: () => demoV2Api.options(),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading your choices...
      </div>
    );
  }
  if (isError || !options) {
    return (
      <p className="py-24 text-center text-destructive" data-testid="text-demo-v2-options-error">
        We couldn't load the industry list. Please refresh and try again.
      </p>
    );
  }

  return (
    <div className="space-y-6 text-center">
      <p className="text-sm font-medium text-muted-foreground" data-testid="text-demo-v2-session-counter">
        Your free practice conversation
      </p>
      <h2 className="text-2xl font-semibold">Which industry do you want?</h2>
      <p className="mx-auto max-w-xl text-sm text-muted-foreground">
        Pick either one. You will meet a customer whose real motivation sits
        underneath the request they open with.
      </p>

      <div
        className="grid gap-3 sm:grid-cols-2"
        role="radiogroup"
        aria-label="Choose your industry"
        data-testid="demo-v2-industry-picker"
      >
        {options.map((option) => {
          const isSelected = selected === option.key;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(option.key)}
              className="relative flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition-colors hover-elevate"
              style={
                isSelected
                  ? { borderColor: ORANGE, backgroundColor: "rgba(224,109,0,0.08)" }
                  : { borderColor: "var(--border)" }
              }
              data-testid={`demo-v2-industry-option-${option.key}`}
            >
              {isSelected && (
                <span
                  className="absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full"
                  style={{ backgroundColor: ORANGE }}
                  aria-hidden="true"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                </span>
              )}
              <span className="text-base font-semibold" style={isSelected ? { color: ORANGE } : undefined}>
                {option.label}
              </span>
              <span className="text-xs text-muted-foreground">{option.blurb}</span>
            </button>
          );
        })}
      </div>

      <Button
        size="lg"
        disabled={!selected}
        onClick={() => selected && onChoose(selected)}
        data-testid="button-demo-v2-industry-continue"
      >
        Meet my customer
      </Button>
    </div>
  );
}

// Starts the session (which increments usage server-side) then renders the live
// roleplay. Its own component so the start mutation runs exactly once on mount.
function StartAndPlay({
  token,
  industry,
  onCompleted,
  onLimitReached,
}: {
  token: string;
  industry: string;
  onCompleted: (s: DemoV2Session, stalledStep: string | null) => void;
  onLimitReached: () => void;
}) {
  const [started, setStarted] = useState<{
    session: DemoV2Session;
    scenario: DemoV2Scenario;
    voiceEnabled: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const start = useMutation({
    mutationFn: async () => {
      const fingerprint = await getDeviceFingerprint();
      return demoV2Api.startSession(token, industry, fingerprint);
    },
    onSuccess: (data) =>
      setStarted({ session: data.session, scenario: data.scenario, voiceEnabled: data.voiceEnabled }),
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
        <p className="text-destructive" data-testid="text-demo-v2-start-error">{error}</p>
        <Button
          onClick={() => {
            setError(null);
            start.mutate();
          }}
          data-testid="button-demo-v2-start-retry"
        >
          Try again
        </Button>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Connecting you to the customer...
      </div>
    );
  }

  return (
    <Roleplay
      token={token}
      initialSession={started.session}
      scenario={started.scenario}
      voiceEnabled={started.voiceEnabled}
      onCompleted={onCompleted}
    />
  );
}

function Roleplay({
  token,
  initialSession,
  scenario,
  voiceEnabled,
  onCompleted,
}: {
  token: string;
  initialSession: DemoV2Session;
  scenario: DemoV2Scenario;
  voiceEnabled: boolean;
  onCompleted: (s: DemoV2Session, stalledStep: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const voiceRef = useRef<ReturnType<typeof useVoiceConversation> | null>(null);
  const avatarUrl = getAvatarUrl(scenario.slug);
  const sessionId = initialSession.id;

  const sendMessage = useMutation({
    mutationFn: ({ content, withAudio }: { content: string; withAudio: boolean }) =>
      demoV2Api.sendMessage(token, sessionId, content, withAudio),
    onSuccess: ({ session: updated, replyStreamUrl }) => {
      queryClient.setQueryData(["/api/demo/session", sessionId], updated);
      // When the backend opened a streamed turn, consume it over SSE and play the
      // reply sentence by sentence. Otherwise fall back to the single-clip path.
      if (replyStreamUrl) {
        voiceRef.current?.handleReplyStream(replyStreamUrl);
      } else {
        voiceRef.current?.handleReply(parseTranscript(updated.transcript));
      }
      setLastFailedMessage(null);
    },
    onError: (_err, variables) => setLastFailedMessage(variables.content),
  });

  const voice = useVoiceConversation({
    send: (content, withAudio) => sendMessage.mutate({ content, withAudio }),
    isSending: sendMessage.isPending,
    onReplyAudioSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/demo/session", sessionId] }),
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
    handleMicTap,
    handleVoiceModeToggle,
    handleSend,
  } = voice;

  const { data: session } = useQuery<DemoV2Session>({
    queryKey: ["/api/demo/session", sessionId],
    queryFn: () => demoV2Api.getSession(token, sessionId),
    initialData: initialSession,
  });

  // The completeness gate mirrors real sessions: a conversation with no
  // recommendation in it comes back 409 and the visitor is told why before they
  // can insist on a score.
  const complete = useMutation({
    mutationFn: (force: boolean) => demoV2Api.complete(token, sessionId, force),
    onSuccess: (data) => onCompleted(data.session, data.stalledStep),
    onError: (e: Error & { incomplete?: boolean }) => {
      if (e.incomplete) setIncomplete(true);
    },
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
              alt="Customer"
              className="h-10 w-10 shrink-0 rounded-full border object-cover"
              data-testid="img-demo-v2-avatar"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-muted">
              <User className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </div>
          )}
          <p className="truncate text-sm text-muted-foreground">
            Ask open questions and uncover what the customer really needs.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Volume2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {voiceEnabled ? (
            <>
              <Label htmlFor="demo-v2-voice-toggle" className="text-xs text-muted-foreground">
                Voice mode
              </Label>
              <Switch
                id="demo-v2-voice-toggle"
                checked={voiceMode}
                onCheckedChange={handleVoiceModeToggle}
                data-testid="switch-demo-v2-voice"
              />
            </>
          ) : (
            <span className="text-xs text-muted-foreground" data-testid="text-demo-v2-voice-locked">
              Voice unlocks on paid sessions
            </span>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
        data-testid="container-demo-v2-transcript"
      >
        {transcript.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Greet the customer to begin the conversation.
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
              data-testid={`demo-v2-message-${m.role}-${i}`}
            >
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <p className="text-xs opacity-70">{m.role === "consultant" ? "You" : "Customer"}</p>
                {m.role === "customer" && m.audioStatus === "pending" && (
                  <Loader2 className="h-3 w-3 animate-spin opacity-50" aria-label="Voice loading" />
                )}
                {m.role === "customer" && m.audioStatus === "ready" && m.audioUrl && (
                  <button
                    onClick={() => new Audio(`${API_BASE}${m.audioUrl}`).play().catch(() => {})}
                    className="opacity-60 transition-opacity hover:opacity-100"
                    aria-label="Replay voice"
                    data-testid={`button-demo-v2-replay-${i}`}
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
              Customer is responding...
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
                data-testid="button-demo-v2-retry"
              >
                <RotateCcw className="h-3 w-3" /> Retry
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-3 border-t p-3">
        {voiceStatus && (
          <p className="text-xs text-muted-foreground" data-testid="text-demo-v2-voice-status">
            {voiceStatus}
          </p>
        )}
        {incomplete && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
            data-testid="text-demo-v2-incomplete"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              You haven't recommended anything yet. Real conversations are scored on
              where they land, so finish with a recommendation if you can.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => {
                voice.stopAudio();
                complete.mutate(true);
              }}
              disabled={complete.isPending}
              data-testid="button-demo-v2-force-complete"
            >
              Score it anyway
            </Button>
          </div>
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
            placeholder={micActive ? "Listening..." : speechSupported ? "Type or tap the mic to speak..." : "Type what you'd say to the customer..."}
            className="max-h-32 min-h-[44px] resize-none"
            data-testid="input-demo-v2-message"
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
              data-testid="button-demo-v2-mic"
            >
              {micActive ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          )}
          <Button
            onClick={handleSend}
            disabled={!draft.trim() || sendMessage.isPending}
            size="icon"
            aria-label="Send message"
            data-testid="button-demo-v2-send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              voice.stopAudio();
              complete.mutate(false);
            }}
            disabled={transcript.length === 0 || complete.isPending}
            data-testid="button-demo-v2-complete"
          >
            {complete.isPending ? "Scoring..." : "End & score this conversation"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// The free session's results, then the fork. There is no next free session to
// start, so the only forward paths are membership or a purchased session.
function ResultsAndCta({
  session,
  stalledStep,
  email,
  limitReached,
}: {
  session: DemoV2Session | null;
  stalledStep: string | null;
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
            <CardTitle className="text-lg">You've used your free practice conversation</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p data-testid="text-demo-v2-limit-reached">
              Ready to keep practicing? Choose one of the options below.
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
                  <span className="text-2xl font-semibold" data-testid="text-demo-v2-score">
                    {session.score ?? "-"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground" data-testid="text-demo-v2-feedback">
                  {session.feedback}
                </p>
                {stalledStep && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">Where it stalled: </span>
                    <span className="font-medium" style={{ color: ORANGE }} data-testid="text-demo-v2-stalled-step">
                      {stalledStep}
                    </span>
                  </p>
                )}
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
                        <span className="text-muted-foreground" data-testid={`text-demo-v2-rubric-${key}`}>
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

      <NextStepFork email={email} />

      <CtaForm email={email} />
    </div>
  );
}

// The post-free-session fork. Two options, membership visually dominant, with
// no lime green anywhere: emphasis comes from size, border, tint and weight,
// since lime is reserved for admin/vault.
function NextStepFork({ email }: { email: string }) {
  const [showInterest, setShowInterest] = useState(false);

  return (
    <div className="grid gap-4 md:grid-cols-5" data-testid="demo-v2-next-step-fork">
      <Card
        className="border-2 shadow-lg md:col-span-3"
        style={{ borderColor: ORANGE, backgroundColor: "rgba(224,109,0,0.05)" }}
        data-testid="demo-v2-fork-member"
      >
        <CardHeader className="space-y-2">
          <span
            className="w-fit rounded-full px-2.5 py-1 text-xs font-semibold text-white"
            style={{ backgroundColor: ORANGE }}
            data-testid="text-demo-v2-fork-member-badge"
          >
            {MEMBER_OPTION.badge}
          </span>
          <CardTitle className="text-2xl" data-testid="text-demo-v2-fork-member-headline">
            {MEMBER_OPTION.headline}
          </CardTitle>
          <p className="text-sm font-medium text-foreground">{MEMBER_OPTION.subhead}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <ul className="space-y-2 text-sm">
            {MEMBER_OPTION.features.map((feature) => (
              <li key={feature} className="flex items-start gap-2.5">
                <span
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: ORANGE }}
                  aria-hidden="true"
                />
                {feature}
              </li>
            ))}
          </ul>
          <Button
            asChild
            size="lg"
            className="w-full text-base"
            style={{ backgroundColor: ORANGE, color: "white" }}
            data-testid="button-demo-v2-become-member"
          >
            <Link href={MEMBER_SIGNUP_PATH}>{MEMBER_OPTION.buttonLabel}</Link>
          </Button>
        </CardContent>
      </Card>

      <Card className="md:col-span-2" data-testid="demo-v2-fork-pay-per-session">
        <CardHeader className="space-y-1">
          <CardTitle className="text-lg" data-testid="text-demo-v2-fork-pps-headline">
            {PAY_PER_SESSION_OPTION.headline}
          </CardTitle>
          <p className="text-base font-semibold" style={{ color: ORANGE }} data-testid="text-demo-v2-fork-pps-price">
            {PAY_PER_SESSION_OPTION.priceLine}
          </p>
          <p className="text-sm text-muted-foreground">{PAY_PER_SESSION_OPTION.subhead}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {PAY_PER_SESSION_OPTION.includesLabel}
              </p>
              <ul className="space-y-1.5 text-sm">
                {PAY_PER_SESSION_OPTION.includes.map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: ORANGE }} aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {PAY_PER_SESSION_OPTION.excludesLabel}
              </p>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {PAY_PER_SESSION_OPTION.excludes.map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <X className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="text-demo-v2-fork-pps-disclaimer">
            {PAY_PER_SESSION_OPTION.disclaimer}
          </p>
          {showInterest ? (
            <PayPerSessionInterestForm email={email} />
          ) : (
            <Button
              variant="outline"
              className="w-full whitespace-normal"
              style={{ borderColor: ORANGE, color: ORANGE }}
              // Live $4.99 one-time Stripe charge intentionally deferred to a follow-up PR per product decision (see demo_paywall_redesign_spec.md). This currently captures interest only.
              onClick={() => setShowInterest(true)}
              data-testid="button-demo-v2-pay-per-session"
            >
              {PAY_PER_SESSION_OPTION.buttonLabel}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Interest capture for pay-per-session. Reuses the existing demo lead endpoint
// (/api/demo/lead, the same one CtaForm posts to) rather than adding a new
// mechanism, and touches no payment code.
function PayPerSessionInterestForm({ email }: { email: string }) {
  const [leadEmail, setLeadEmail] = useState(email);
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      demoV2Api.submitLead({
        name: leadEmail,
        email: leadEmail,
        message: PAY_PER_SESSION_INTEREST.leadMessage,
      }),
    onError: (e: Error) => setError(e.message),
  });

  if (submit.isSuccess) {
    return (
      <div className="space-y-1 rounded-lg border p-3 text-sm" data-testid="text-demo-v2-pps-success">
        <p className="font-medium">{PAY_PER_SESSION_INTEREST.successHeadline}</p>
        <p className="text-muted-foreground">{PAY_PER_SESSION_INTEREST.successBody}</p>
      </div>
    );
  }

  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (leadEmail.trim()) submit.mutate();
      }}
      data-testid="form-demo-v2-pps-interest"
    >
      <p className="text-sm font-medium" data-testid="text-demo-v2-pps-interest-headline">
        {PAY_PER_SESSION_INTEREST.headline}
      </p>
      <p className="text-sm text-muted-foreground">{PAY_PER_SESSION_INTEREST.body}</p>
      <Label htmlFor="demo-v2-pps-email" className="sr-only">
        Email
      </Label>
      <Input
        id="demo-v2-pps-email"
        type="email"
        value={leadEmail}
        onChange={(e) => setLeadEmail(e.target.value)}
        placeholder="you@company.com"
        data-testid="input-demo-v2-pps-email"
      />
      {error && (
        <p className="text-sm text-destructive" data-testid="text-demo-v2-pps-error">
          {error}
        </p>
      )}
      <Button
        type="submit"
        className="w-full"
        style={{ backgroundColor: ORANGE, color: "white" }}
        disabled={!leadEmail.trim() || submit.isPending}
        data-testid="button-demo-v2-pps-notify"
      >
        {submit.isPending ? "Saving..." : PAY_PER_SESSION_INTEREST.buttonLabel}
      </Button>
    </form>
  );
}

function CtaForm({ email }: { email: string }) {
  const [name, setName] = useState("");
  const [leadEmail, setLeadEmail] = useState(email);
  const [company, setCompany] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Mirrors the server-side wording so the on-screen question matches what gets
  // recorded on the lead. The server computes the authoritative copy on save.
  const seatQuestion = "How many users or consultants do you want on your team?";

  const submit = useMutation({
    mutationFn: () =>
      demoV2Api.submitLead({
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
          <p className="font-medium" data-testid="text-demo-v2-cta-success">
            Thanks, we'll be in touch shortly.
          </p>
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
        <CardTitle className="text-lg" data-testid="text-demo-v2-cta-heading">
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
            <Label htmlFor="demo-v2-cta-name">Name</Label>
            <Input id="demo-v2-cta-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-demo-v2-cta-name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-v2-cta-email">Email</Label>
            <Input id="demo-v2-cta-email" type="email" value={leadEmail} onChange={(e) => setLeadEmail(e.target.value)} data-testid="input-demo-v2-cta-email" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-v2-cta-company">Company (optional)</Label>
            <Input id="demo-v2-cta-company" value={company} onChange={(e) => setCompany(e.target.value)} data-testid="input-demo-v2-cta-company" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-v2-cta-team">{seatQuestion}</Label>
            <Input id="demo-v2-cta-team" value={teamSize} onChange={(e) => setTeamSize(e.target.value)} placeholder="e.g. 5" data-testid="input-demo-v2-cta-team" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="demo-v2-cta-message">Anything else? (optional)</Label>
            <Textarea id="demo-v2-cta-message" value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[72px]" data-testid="input-demo-v2-cta-message" />
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="text-demo-v2-cta-error">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={!name.trim() || !leadEmail.trim() || submit.isPending}
            data-testid="button-demo-v2-cta-submit"
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
