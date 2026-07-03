import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/app-shell";
import { useViewportHeight } from "@/hooks/use-viewport-height";
import { apiRequest } from "@/lib/queryClient";
import { getAvatarUrl } from "@/lib/avatars";
import { Volume2, Send, Loader2, AlertCircle, RotateCcw, Mic, MicOff, User } from "lucide-react";
import type { Session, Scenario, TranscriptMessage } from "@shared/schema";

// Web Speech API isn't in TS's default lib — declare the minimal shape we use.
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export default function RolePlay() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [pendingAudioIds, setPendingAudioIds] = useState<Set<string>>(new Set());
  const playedAudioIds = useRef<Set<string>>(new Set());
  // Tracks the real usable screen height, shrinking live as the on-screen keyboard
  // opens on mobile, so the chat layout resizes instead of being covered by the keyboard.
  const viewportHeight = useViewportHeight();
  const containerRef = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !viewportHeight) return;
    const top = el.getBoundingClientRect().top;
    // Leave a small buffer so the container never gets clipped by rounding.
    setAvailableHeight(Math.max(240, viewportHeight - top - 8));
  }, [viewportHeight]);

  const { data: session, isLoading } = useQuery<Session>({
    queryKey: ["/api/sessions", id],
    // While a voice reply is still generating in the background, poll so it appears
    // automatically without the consultant waiting or needing to refresh.
    refetchInterval: () => (pendingAudioIds.size > 0 ? 1500 : false),
  });

  const { data: scenario } = useQuery<Scenario>({
    queryKey: ["/api/scenarios", session?.scenarioId],
    enabled: !!session?.scenarioId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/scenarios/${session!.scenarioId}`);
      return res.json();
    },
  });
  const avatarUrl = getAvatarUrl(scenario?.slug);

  // --- Voice input (Web Speech API) ---
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const draftBeforeListening = useRef("");

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setSpeechSupported(false);
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let finalTranscript = "";
      let interimTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }
      const base = draftBeforeListening.current;
      const spoken = (finalTranscript + interimTranscript).trim();
      setDraft(spoken ? `${base}${base ? " " : ""}${spoken}` : base);
      if (finalTranscript) {
        draftBeforeListening.current = `${base}${base ? " " : ""}${finalTranscript}`.trim();
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (isListening) {
      recognition.stop();
      setIsListening(false);
    } else {
      draftBeforeListening.current = draft.trim();
      recognition.start();
      setIsListening(true);
    }
  }, [isListening, draft]);

  const sendMessage = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/sessions/${id}/message`, {
        content,
        withAudio: voiceOn,
      });
      return res.json();
    },
    onSuccess: (updated: Session) => {
      queryClient.setQueryData(["/api/sessions", id], updated);
      const transcript: TranscriptMessage[] = JSON.parse(updated.transcript);
      const last = transcript[transcript.length - 1];
      if (last?.msgId && last.audioStatus === "pending") {
        setPendingAudioIds((prev) => new Set(prev).add(last.msgId!));
      } else if (voiceOn && last?.audioUrl && last.msgId && !playedAudioIds.current.has(last.msgId)) {
        playedAudioIds.current.add(last.msgId);
        const audio = new Audio(`${API_BASE}${last.audioUrl}`);
        audio.play().catch(() => {});
      }
      setLastFailedMessage(null);
    },
    onError: (_err, content) => {
      // Never lose what was typed — surface a retry instead of forcing a restart.
      setLastFailedMessage(content);
    },
  });

  // Once a pending voice reply finishes generating in the background, play it and
  // stop polling for it.
  useEffect(() => {
    if (!session || pendingAudioIds.size === 0) return;
    const liveTranscript: TranscriptMessage[] = JSON.parse(session.transcript);
    let changed = false;
    const next = new Set(pendingAudioIds);
    for (const msg of liveTranscript) {
      if (msg.msgId && next.has(msg.msgId) && msg.audioStatus !== "pending") {
        next.delete(msg.msgId);
        changed = true;
        if (msg.audioStatus === "ready" && msg.audioUrl && !playedAudioIds.current.has(msg.msgId)) {
          playedAudioIds.current.add(msg.msgId);
          const audio = new Audio(`${API_BASE}${msg.audioUrl}`);
          audio.play().catch(() => {});
        }
      }
    }
    if (changed) setPendingAudioIds(next);
  }, [session, pendingAudioIds]);

  const [scoringFailed, setScoringFailed] = useState(false);

  const completeSession = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/sessions/${id}/complete`, {});
      return res.json();
    },
    onSuccess: (updatedSession) => {
      queryClient.setQueryData(["/api/sessions", id], updatedSession);
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", id] });
      setScoringFailed(false);
      navigate(`/results/${id}`);
    },
    onError: () => {
      // Scoring failures shouldn't strand the session — let the consultant retry from here.
      setScoringFailed(true);
    },
  });

  const transcript: TranscriptMessage[] = session ? JSON.parse(session.transcript) : [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript.length]);

  function handleSend() {
    if (!draft.trim() || sendMessage.isPending) return;
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    }
    sendMessage.mutate(draft.trim());
    setDraft("");
    draftBeforeListening.current = "";
  }

  if (isLoading || !session) {
    return (
      <AppShell title="Discovery session" compact>
        <Skeleton className="h-96 rounded-lg" />
      </AppShell>
    );
  }

  return (
    <AppShell title="Discovery session" compact>
      <div
        ref={containerRef}
        className="flex flex-col flex-1 min-h-0 rounded-lg border bg-card overflow-hidden"
        style={availableHeight ? { height: `${availableHeight}px`, maxHeight: `${availableHeight}px` } : undefined}
      >
        <div className="flex items-center justify-between gap-4 px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Customer"
                className="w-10 h-10 rounded-full object-cover border shrink-0"
                data-testid="img-persona-avatar-header"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center border shrink-0" data-testid="img-persona-avatar-header-fallback">
                <User className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
              </div>
            )}
            <p className="text-sm text-muted-foreground truncate" data-testid="text-session-hint">
              Ask open questions before proposing anything. Uncover the real need.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Volume2 className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Label htmlFor="voice-toggle" className="text-xs text-muted-foreground">Voice</Label>
            <Switch id="voice-toggle" checked={voiceOn} onCheckedChange={setVoiceOn} data-testid="switch-voice" />
          </div>
        </div>

        {avatarUrl && (
          <div
            className="relative shrink-0 flex items-center justify-center overflow-hidden border-b bg-muted/30"
            style={{ height: "clamp(96px, 22vh, 220px)" }}
            data-testid="container-persona-hero"
          >
            <img
              src={avatarUrl}
              alt="Customer you're speaking with"
              className="h-full w-auto object-cover object-top mx-auto"
              data-testid="img-persona-avatar-hero"
            />
            <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background/80 to-transparent" aria-hidden="true" />
          </div>
        )}

        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3" data-testid="container-transcript">
          {transcript.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="text-empty-transcript">
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
                data-testid={`message-${m.role}-${i}`}
              >
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <p className="text-xs opacity-70">{m.role === "consultant" ? "You" : "Customer"}</p>
                  {m.role === "customer" && m.audioStatus === "pending" && (
                    <Loader2 className="w-3 h-3 opacity-50 animate-spin" data-testid={`icon-voice-loading-${i}`} aria-label="Voice loading" />
                  )}
                  {m.role === "customer" && m.audioStatus === "ready" && m.audioUrl && (
                    <button
                      onClick={() => new Audio(`${API_BASE}${m.audioUrl}`).play().catch(() => {})}
                      className="opacity-60 hover:opacity-100 transition-opacity"
                      aria-label="Replay voice"
                      data-testid={`button-replay-voice-${i}`}
                    >
                      <Volume2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <p>{m.content}</p>
              </div>
            </div>
          ))}
          {sendMessage.isPending && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-muted text-muted-foreground flex items-center gap-2" data-testid="indicator-thinking">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Customer is responding...
              </div>
            </div>
          )}
          {lastFailedMessage && !sendMessage.isPending && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-destructive/10 text-destructive flex items-center gap-2 flex-wrap" data-testid="indicator-send-error">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>That message didn't go through.</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1"
                  onClick={() => sendMessage.mutate(lastFailedMessage)}
                  data-testid="button-retry-message"
                >
                  <RotateCcw className="w-3 h-3" /> Retry
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="border-t p-3 space-y-3 shrink-0">
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
              placeholder={isListening ? "Listening..." : speechSupported ? "Type or tap the mic to speak..." : "Type what you'd say to the customer..."}
              className="min-h-[44px] max-h-32 resize-none"
              data-testid="input-message"
            />
            {speechSupported && (
              <Button
                onClick={toggleListening}
                disabled={sendMessage.isPending}
                size="icon"
                variant={isListening ? "default" : "outline"}
                aria-label={isListening ? "Stop voice input" : "Start voice input"}
                aria-pressed={isListening}
                className={isListening ? "animate-pulse" : undefined}
                data-testid="button-mic"
              >
                {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </Button>
            )}
            <Button
              onClick={handleSend}
              disabled={!draft.trim() || sendMessage.isPending}
              size="icon"
              aria-label="Send message"
              data-testid="button-send"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex justify-end items-center gap-3">
            {scoringFailed && (
              <p className="text-xs text-destructive" data-testid="text-scoring-error">
                Scoring failed — your transcript is saved, try again.
              </p>
            )}
            <Button
              variant="secondary"
              onClick={() => completeSession.mutate()}
              disabled={transcript.length === 0 || completeSession.isPending}
              data-testid="button-complete-session"
            >
              {completeSession.isPending ? "Scoring..." : scoringFailed ? "Retry scoring" : "End & score this session"}
            </Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
