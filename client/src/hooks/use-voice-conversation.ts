import { useState, useRef, useEffect, useCallback } from "react";
import { voiceTransition, type VoiceState, type VoiceEvent, type VoiceEffect } from "@/lib/voiceMachine";
import type { TranscriptMessage } from "@shared/schema";

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

// After the speaker stops talking for this long in voice mode, auto-send. Tight
// enough to feel responsive, long enough to ride over natural mid-sentence pauses.
const SILENCE_AUTOSEND_MS = 1100;

export interface UseVoiceConversationOptions {
  // Send one turn. `withAudio` reflects whether voice mode is on so the caller's
  // request can ask the backend to synthesize the reply's speech.
  send: (content: string, withAudio: boolean) => void;
  // Whether a send is currently in flight (disables the mic / re-entrancy).
  isSending: boolean;
}

// The complete, self-contained voice roleplay engine (Web Speech API + the
// deterministic voiceMachine + audio playback + auto-send). This is the SINGLE
// implementation shared by the trainee roleplay page and the public demo page —
// there is no parallel/forked voice system. The caller owns transport (which
// endpoint to POST to and how to store the session) and feeds replies back in
// via handleReply()/syncPendingAudio().
export function useVoiceConversation({ send, isSending }: UseVoiceConversationOptions) {
  const [draft, setDraft] = useState("");
  // A single "Voice mode" toggle governs the whole experience. ON = fully
  // automatic phone-call-style conversation (auto TTS + auto listen). OFF =
  // text-only, with the mic available only for optional one-shot dictation.
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(voiceMode);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  const [pendingAudioIds, setPendingAudioIds] = useState<Set<string>>(new Set());
  const playedAudioIds = useRef<Set<string>>(new Set());

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
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // handleSend and dispatch are defined below; keep refs so the recognition
  // callbacks (created once on mount) always call the latest versions.
  const handleSendRef = useRef<() => void>(() => {});
  const dispatchRef = useRef<(event: VoiceEvent, audioUrl?: string) => void>(() => {});
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

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
  const startRecognition = useCallback((fresh = true) => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    // Voice loop keeps the mic open continuously; text dictation captures a
    // single utterance then stops on its own.
    recognition.continuous = voiceModeRef.current;
    if (fresh) {
      draftBeforeListening.current = "";
      setDraft("");
    } else {
      draftBeforeListening.current = draftRef.current.trim();
    }
    try {
      recognition.start();
    } catch {
      // Ignore "already started" errors from rapid restarts.
    }
  }, []);

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

      // Voice loop only: after a silent gap, auto-send so the speaker can just
      // keep talking. Text-mode dictation never auto-sends.
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

  const handleSend = useCallback(() => {
    const content = draftRef.current.trim();
    if (!content || isSending) return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (voiceModeRef.current) {
      // Moves the machine to processing and stops the mic deterministically.
      dispatch({ type: "SEND" });
    } else if (isDictatingRef.current) {
      stopRecognition();
      setIsDictating(false);
    }
    send(content, voiceModeRef.current);
    setDraft("");
    draftBeforeListening.current = "";
  }, [dispatch, stopRecognition, send, isSending]);
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  // Called by the caller after a send resolves, with the new full transcript.
  // Drives the voice loop's reply-audio handling exactly as the roleplay page did.
  const handleReply = useCallback((transcript: TranscriptMessage[]) => {
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
  }, []);

  // Called by the caller whenever fresh session data arrives (polling). Once a
  // pending voice reply finishes generating in the background, play it and stop
  // polling for it.
  const syncPendingAudio = useCallback(
    (transcript: TranscriptMessage[]) => {
      setPendingAudioIds((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set(prev);
        for (const msg of transcript) {
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
        return changed ? next : prev;
      });
    },
    []
  );

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

  return {
    draft,
    setDraft,
    voiceMode,
    phase,
    isDictating,
    speechSupported,
    micActive,
    isListening,
    voiceStatus,
    micLabel,
    pendingCount: pendingAudioIds.size,
    handleMicTap,
    handleVoiceModeToggle,
    handleSend,
    handleReply,
    syncPendingAudio,
    stopAudio,
  };
}
