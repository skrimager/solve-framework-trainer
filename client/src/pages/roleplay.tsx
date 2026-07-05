import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { AppShell } from "@/components/app-shell";
import { useViewportHeight } from "@/hooks/use-viewport-height";
import { apiRequest } from "@/lib/queryClient";
import { getAvatarUrl } from "@/lib/avatars";
import { voiceTransition, type VoiceState, type VoiceEvent, type VoiceEffect } from "@/lib/voiceMachine";
import { Volume2, Send, Loader2, AlertCircle, RotateCcw, Mic, MicOff, User, Save, XCircle } from "lucide-react";
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

// A near-empty silent clip used to "unlock" audio playback on the first user
// gesture. Mobile browsers (notably iOS Safari) only allow programmatic
// audio.play() after a user has interacted with a given media element, so we
// prime one reusable element the moment voice mode is switched on.
const SILENT_AUDIO =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export default function RolePlay() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  // A single "Voice mode" toggle governs the whole experience. ON = fully
  // automatic phone-call-style conversation (auto TTS + auto listen). OFF =
  // text-only, with the mic available only for optional one-shot dictation.
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(voiceMode);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);
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
    // automatically without the consultant waiting or needing to refresh. Kept
    // tight so the customer's voice starts playing as soon as the audio is ready.
    refetchInterval: () => (pendingAudioIds.size > 0 ? 700 : false),
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

  // --- Voice conversation loop (Web Speech API + a deterministic state machine) ---
  // `phase` is driven exclusively by voiceMachine. voiceMode ON keeps it cycling
  // idle -> listening -> processing -> ai_speaking -> listening; voiceMode OFF
  // holds it at idle. Text-mode mic dictation is tracked separately by
  // isDictating and never touches the machine.
  const [phase, setPhase] = useState<VoiceState>("idle");
  const phaseRef = useRef<VoiceState>("idle");
  const [isDictating, setIsDictating] = useState(false);
  const isDictatingRef = useRef(false);
  useEffect(() => {
    isDictatingRef.current = isDictating;
  }, [isDictating]);
  const [speechSupported, setSpeechSupported] = useState(true);
  const speechSupportedRef = useRef(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const draftBeforeListening = useRef("");
  // After the consultant stops talking for this long in voice mode, auto-send.
  // Tight enough to feel responsive, but long enough to ride over natural
  // mid-sentence pauses so it doesn't cut the consultant off.
  const SILENCE_AUTOSEND_MS = 1100;
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // handleSend and dispatch are defined below; keep refs so the recognition
  // callbacks (created once on mount) always call the latest versions.
  const handleSendRef = useRef<() => void>(() => {});
  const dispatchRef = useRef<(event: VoiceEvent, audioUrl?: string) => void>(() => {});

  const getAudioEl = useCallback(() => {
    if (!audioElRef.current) audioElRef.current = new Audio();
    return audioElRef.current;
  }, []);

  // Prime the reusable audio element on a user gesture so later programmatic
  // playback is allowed on mobile. Safe to call repeatedly.
  const unlockAudio = useCallback(() => {
    const el = getAudioEl();
    try {
      el.muted = true;
      el.src = SILENT_AUDIO;
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          el.pause();
          el.muted = false;
        }).catch(() => {
          el.muted = false;
        });
      } else {
        el.muted = false;
      }
    } catch {
      el.muted = false;
    }
  }, [getAudioEl]);

  const stopAudio = useCallback(() => {
    const el = audioElRef.current;
    if (!el) return;
    el.onended = null;
    el.pause();
    try {
      el.currentTime = 0;
    } catch {
      // Some browsers throw on currentTime before metadata loads; ignore.
    }
  }, []);

  const playAudio = useCallback(
    (url: string) => {
      const el = getAudioEl();
      el.onended = () => dispatchRef.current({ type: "AUDIO_ENDED" });
      el.src = `${API_BASE}${url}`;
      el.muted = false;
      el.play().catch(() => dispatchRef.current({ type: "AUDIO_FAILED" }));
    },
    [getAudioEl]
  );

  const stopRecognition = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    try {
      recognitionRef.current?.stop();
    } catch {
      // Ignore stop() before start().
    }
  }, []);

  // fresh=true starts a brand-new utterance (voice loop, previous reply already
  // sent); fresh=false keeps whatever is already drafted (text-mode dictation).
  const startRecognition = useCallback(
    (fresh = true) => {
      const recognition = recognitionRef.current;
      if (!recognition) return;
      // Voice loop keeps the mic open continuously; text dictation captures a
      // single utterance then stops on its own.
      recognition.continuous = voiceModeRef.current;
      if (fresh) {
        draftBeforeListening.current = "";
        setDraft("");
      } else {
        draftBeforeListening.current = draft.trim();
      }
      try {
        recognition.start();
      } catch {
        // Ignore "already started" errors from rapid restarts.
      }
    },
    [draft]
  );

  const runEffect = useCallback(
    (effect: VoiceEffect, audioUrl?: string) => {
      switch (effect) {
        case "START_LISTENING":
          startRecognition(true);
          break;
        case "STOP_LISTENING":
          stopRecognition();
          break;
        case "PLAY_AUDIO":
          if (audioUrl) playAudio(audioUrl);
          break;
        case "STOP_AUDIO":
          stopAudio();
          break;
      }
    },
    [startRecognition, stopRecognition, playAudio, stopAudio]
  );

  const dispatch = useCallback(
    (event: VoiceEvent, audioUrl?: string) => {
      const result = voiceTransition(phaseRef.current, event, {
        speechSupported: speechSupportedRef.current,
      });
      phaseRef.current = result.state;
      setPhase(result.state);
      for (const effect of result.effects) runEffect(effect, audioUrl);
    },
    [runEffect]
  );
  useEffect(() => {
    dispatchRef.current = dispatch;
  });

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setSpeechSupported(false);
      speechSupportedRef.current = false;
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

      // Voice loop only: after a silent gap, auto-send so the consultant can
      // just keep talking. Text-mode dictation never auto-sends.
      if (phaseRef.current === "listening") {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          if (draftBeforeListening.current.trim()) {
            handleSendRef.current();
          }
        }, SILENCE_AUTOSEND_MS);
      }
    };
    recognition.onerror = () => {
      if (voiceModeRef.current) {
        dispatchRef.current({ type: "RECOGNITION_ERROR" });
      } else {
        setIsDictating(false);
      }
    };
    recognition.onend = () => {
      if (voiceModeRef.current) {
        // In listening state this restarts the mic (mobile ends it
        // spontaneously); in any other state the machine ignores it.
        dispatchRef.current({ type: "RECOGNITION_ENDED" });
      } else {
        setIsDictating(false);
      }
    };
    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tap the mic. In voice mode this feeds the machine (interrupt / resume /
  // barge-in). In text mode it's a one-shot dictation toggle.
  const handleMicTap = useCallback(() => {
    if (voiceModeRef.current) {
      dispatch({ type: "MIC_TAP" });
      return;
    }
    if (isDictatingRef.current) {
      stopRecognition();
      setIsDictating(false);
    } else {
      startRecognition(false);
      setIsDictating(true);
    }
  }, [dispatch, startRecognition, stopRecognition]);

  const handleVoiceModeToggle = useCallback(
    (checked: boolean) => {
      setVoiceMode(checked);
      voiceModeRef.current = checked;
      if (checked) {
        // Any in-flight text dictation is superseded by the voice loop.
        if (isDictatingRef.current) {
          stopRecognition();
          setIsDictating(false);
        }
        // Unlock audio inside this user gesture so later replies can auto-play
        // on mobile.
        unlockAudio();
        dispatch({ type: "TOGGLE_VOICE_MODE", on: true });
      } else {
        stopAudio();
        dispatch({ type: "TOGGLE_VOICE_MODE", on: false });
      }
    },
    [dispatch, stopAudio, stopRecognition, unlockAudio]
  );

  const sendMessage = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/sessions/${id}/message`, {
        content,
        withAudio: voiceMode,
      });
      return res.json();
    },
    onSuccess: (updated: Session) => {
      queryClient.setQueryData(["/api/sessions", id], updated);
      const transcript: TranscriptMessage[] = JSON.parse(updated.transcript);
      const last = transcript[transcript.length - 1];
      if (last?.msgId && last.audioStatus === "pending") {
        setPendingAudioIds((prev) => new Set(prev).add(last.msgId!));
        if (voiceModeRef.current) dispatchRef.current({ type: "REPLY_AUDIO_PENDING" });
      } else if (
        voiceModeRef.current &&
        last?.audioUrl &&
        last.audioStatus === "ready" &&
        last.msgId &&
        !playedAudioIds.current.has(last.msgId)
      ) {
        playedAudioIds.current.add(last.msgId);
        dispatchRef.current({ type: "REPLY_AUDIO_READY" }, last.audioUrl);
      } else if (voiceModeRef.current) {
        // Reply arrived with no audio to play — keep the loop moving.
        dispatchRef.current({ type: "REPLY_NO_AUDIO" });
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
        if (!voiceModeRef.current) continue;
        if (msg.audioStatus === "ready" && msg.audioUrl && !playedAudioIds.current.has(msg.msgId)) {
          playedAudioIds.current.add(msg.msgId);
          dispatchRef.current({ type: "REPLY_AUDIO_READY" }, msg.audioUrl);
        } else if (msg.audioStatus === "failed") {
          // TTS generation failed — keep the loop moving instead of stranding it.
          dispatchRef.current({ type: "REPLY_NO_AUDIO" });
        }
      }
    }
    if (changed) setPendingAudioIds(next);
  }, [session, pendingAudioIds]);

  const isListening = phase === "listening";
  const micActive = isListening || isDictating;
  const voiceStatus = !voiceMode
    ? null
    : phase === "listening"
      ? "Listening — just keep talking."
      : phase === "processing"
        ? "Customer is thinking..."
        : phase === "ai_speaking"
          ? "Customer is speaking — tap the mic to jump in."
          : phase === "awaiting_user"
            ? speechSupported
              ? "Tap the mic to continue the conversation."
              : "Type your reply to continue."
            : null;
  const micLabel = voiceMode
    ? phase === "ai_speaking"
      ? "Interrupt and speak"
      : isListening
        ? "Stop listening"
        : "Start listening"
    : isDictating
      ? "Stop voice input"
      : "Start voice input";

  const [scoringFailed, setScoringFailed] = useState(false);
  const [showIncompleteModal, setShowIncompleteModal] = useState(false);

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
    onError: (err: any) => {
      // A 409 means no recommendation/solution has been proposed yet — show the
      // "incomplete consultation" choice instead of treating it as a real failure.
      if (String(err?.message ?? "").startsWith("409")) {
        setShowIncompleteModal(true);
        return;
      }
      // Real scoring failures shouldn't strand the session — let the consultant retry from here.
      setScoringFailed(true);
    },
  });

  const saveForLater = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/sessions/${id}/save-for-later`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[0] === "/api/users" &&
          query.queryKey[2] === "sessions",
      });
      setShowIncompleteModal(false);
      navigate("/scenarios");
    },
  });

  const transcript: TranscriptMessage[] = session ? JSON.parse(session.transcript) : [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript.length]);

  function handleSend() {
    if (!draft.trim() || sendMessage.isPending) return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (voiceModeRef.current) {
      // Moves the machine to processing and stops the mic deterministically.
      dispatch({ type: "SEND" });
    } else if (isDictatingRef.current) {
      stopRecognition();
      setIsDictating(false);
    }
    sendMessage.mutate(draft.trim());
    setDraft("");
    draftBeforeListening.current = "";
  }

  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  const isLeadership = scenario?.track === "leadership";
  const sessionTitle = isLeadership ? "Conflict scenario" : "Discovery session";
  const sessionHint = isLeadership
    ? "Listen with empathy, uncover the root cause, and work toward a resolution that doesn't lay blame."
    : "Ask open questions before proposing anything. Uncover the real need.";

  if (isLoading || !session) {
    return (
      <AppShell title={sessionTitle} compact>
        <Skeleton className="h-96 rounded-lg" />
      </AppShell>
    );
  }

  return (
    <AppShell title={sessionTitle} compact>
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
              {sessionHint}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
              <Label htmlFor="voice-toggle" className="text-xs text-muted-foreground">Voice mode</Label>
              <Switch
                id="voice-toggle"
                checked={voiceMode}
                onCheckedChange={handleVoiceModeToggle}
                data-testid="switch-voice"
              />
            </div>
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
          {voiceStatus && (
            <p className="text-xs text-muted-foreground" data-testid="text-voice-status">
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
              placeholder={micActive ? "Listening..." : speechSupported ? "Type or tap the mic to speak..." : "Type what you'd say to the customer..."}
              className="min-h-[44px] max-h-32 resize-none"
              data-testid="input-message"
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
                data-testid="button-mic"
              >
                {micActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
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
                Scoring failed, your transcript is saved, try again.
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

      <Dialog open={showIncompleteModal} onOpenChange={setShowIncompleteModal}>
        <DialogContent data-testid="dialog-incomplete-consultation">
          <DialogHeader>
            <DialogTitle>Consultation is incomplete</DialogTitle>
            <DialogDescription data-testid="text-incomplete-message">
              This consultation is incomplete without a solution. You haven't proposed a
              recommendation or close to the customer yet. Save it for later and pick up where
              you left off, or cancel and start over.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowIncompleteModal(false);
                navigate("/scenarios");
              }}
              data-testid="button-cancel-consultation"
            >
              <XCircle className="w-4 h-4 mr-1.5" /> Cancel and start over
            </Button>
            <Button
              onClick={() => saveForLater.mutate()}
              disabled={saveForLater.isPending}
              style={{ backgroundColor: "#E06D00", color: "white" }}
              data-testid="button-save-for-later"
            >
              <Save className="w-4 h-4 mr-1.5" /> {saveForLater.isPending ? "Saving..." : "Save for Later"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
