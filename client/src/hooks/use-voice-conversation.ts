import { useState, useRef, useEffect, useCallback } from "react";
import { voiceTransition, type VoiceState, type VoiceEvent, type VoiceEffect } from "@/lib/voiceMachine";
import { recommendSilenceMs } from "@/lib/turnDetection";
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
// The error event carries an `error` code (e.g. "no-speech", "aborted",
// "not-allowed") that lets us tell transient hiccups apart from fatal ones.
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    webkitAudioContext?: typeof AudioContext;
  }
}

// Speech-recognition error codes that genuinely require the user to intervene
// (the browser blocked the mic). Everything else — most importantly "no-speech"
// and "aborted", which fire routinely during hands-free listening whenever the
// speaker pauses before replying — is transient and must NOT strand the loop in
// a tap-to-continue fallback, or the conversation stops being hands-free.
const FATAL_RECOGNITION_ERRORS = new Set(["not-allowed", "service-not-allowed"]);

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// A near-empty silent clip used to "unlock" audio playback on the first user
// gesture. Mobile browsers (notably iOS Safari) only allow programmatic
// audio.play() after a user has interacted with a given media element, so we
// prime one reusable element the moment voice mode is switched on.
const SILENT_AUDIO =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

// gpt-4o-mini-tts renders the customer's voice at a conservative loudness, so
// even at the element's maximum (element.volume caps at 1.0) she comes through
// faint on phones at normal system volume. We route playback through a Web Audio
// gain stage to lift it to a clearly audible level; a value >1 amplifies BEYOND
// the source, which element.volume alone cannot do. If Web Audio is unavailable
// or blocked we fall back to plain element playback at volume 1.0 — never louder,
// but never silent either.
const TTS_GAIN = 2.0;

// iOS Safari (and, less consistently, Android Chrome) will not reliably
// re-`.start()` a SpeechRecognition instance that has already been used and
// stopped: the call throws nothing, fires no `onresult`/`onend`/`onerror`, and
// silently captures no audio — while our state machine still reports
// "listening". The robust, widely-documented cure is to instantiate a BRAND-NEW
// SpeechRecognition for every listening turn instead of reusing one long-lived
// instance. We only need to know we're on such a platform to arm the extra
// safety watchdog below; the fresh-instance strategy itself runs everywhere.
function isMobileSpeechPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

// Safety net for the silent-start failure above. If, after we enter `listening`
// on a mobile device, the freshly created recognizer produces NO sign of life
// (no result, no end, no error) within this window, we assume the native
// recognizer silently failed and surface a visible "tap to continue" affordance
// instead of stranding the user in a fake listening state where they talk and
// nothing happens. On a healthy device `onend` fires spontaneously well within
// this window (and simply restarts the loop, re-arming the watchdog), so this
// never trips during normal hands-free use. Mobile-only so it can't regress
// desktop, where continuous recognition legitimately stays open silently.
const MOBILE_LISTEN_WATCHDOG_MS = 12000;

// Neutral (ambiguous) silence wait in voice mode. This is the BASE the adaptive
// heuristic scales around: it waits shorter when the utterance already sounds
// finished and longer when it clearly is not (see recommendSilenceMs). Kept at
// the previous fixed value so the ambiguous case is unchanged. Overridable
// per-caller via `UseVoiceConversationOptions.silenceAutoSendMs`.
const DEFAULT_SILENCE_AUTOSEND_MS = 1500;

export interface UseVoiceConversationOptions {
  // Send one turn. `withAudio` reflects whether voice mode is on so the caller's
  // request can ask the backend to synthesize the reply's speech.
  send: (content: string, withAudio: boolean) => void;
  // Whether a send is currently in flight (disables the mic / re-entrancy).
  isSending: boolean;
  // Neutral silence wait (ms) used as the base for the adaptive end-of-turn
  // heuristic. Higher = more forgiving of natural mid-sentence pauses.
  silenceAutoSendMs?: number;
  // Called once a streamed reply finishes playing (or fails to play), so the
  // caller can refetch the session to surface the now-ready replay control.
  // This replaces the old 700ms audio poll loop.
  onReplyAudioSettled?: () => void;
}

// The complete, self-contained voice roleplay engine (Web Speech API + the
// deterministic voiceMachine + audio playback + auto-send). This is the SINGLE
// implementation shared by the trainee roleplay page and the public demo page —
// there is no parallel/forked voice system. The caller owns transport (which
// endpoint to POST to and how to store the session) and feeds replies back in
// via handleReply(), which streams the reply's audio from its stream URL.
export function useVoiceConversation({
  send,
  isSending,
  silenceAutoSendMs = DEFAULT_SILENCE_AUTOSEND_MS,
  onReplyAudioSettled,
}: UseVoiceConversationOptions) {
  // Keep the latest threshold in a ref so the recognition callback (created once
  // on mount) always reads the current value without being re-registered.
  const silenceAutoSendMsRef = useRef(silenceAutoSendMs);
  useEffect(() => {
    silenceAutoSendMsRef.current = silenceAutoSendMs;
  }, [silenceAutoSendMs]);
  const onReplyAudioSettledRef = useRef(onReplyAudioSettled);
  useEffect(() => {
    onReplyAudioSettledRef.current = onReplyAudioSettled;
  }, [onReplyAudioSettled]);
  const [draft, setDraft] = useState("");
  // A single "Voice mode" toggle governs the whole experience. ON = fully
  // automatic phone-call-style conversation (auto TTS + auto listen). OFF =
  // text-only, with the mic available only for optional one-shot dictation.
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(voiceMode);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

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
  const SpeechRecognitionCtorRef = useRef<(new () => SpeechRecognitionLike) | null>(null);
  const isMobileRef = useRef(false);
  // Fires only if a mobile listening turn shows no sign of life (see
  // MOBILE_LISTEN_WATCHDOG_MS). Cleared by any recognizer event or a stop.
  const listenWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  // Web Audio gain stage used to boost the (quiet) TTS playback above the
  // element's own ceiling. Created lazily inside a user gesture so browsers
  // allow it; if setup ever fails we leave these null and play the element
  // directly (unboosted but still audible).
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioBoostConnectedRef = useRef(false);
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

  // Wire the reusable audio element through a Web Audio gain node so replies
  // play louder than the raw TTS. Must run inside a user gesture (browsers
  // suspend AudioContexts created otherwise). Safe to call repeatedly — it wires
  // the graph once, then just resumes the context. Any failure is swallowed and
  // leaves playback on the plain element path.
  const setupAudioBoost = useCallback(() => {
    if (audioBoostConnectedRef.current) {
      audioContextRef.current?.resume?.().catch(() => {});
      return;
    }
    try {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) return;
      const ctx = audioContextRef.current ?? new Ctor();
      audioContextRef.current = ctx;
      ctx.resume?.().catch(() => {});
      const source = ctx.createMediaElementSource(getAudioEl());
      const gain = ctx.createGain();
      gain.gain.value = TTS_GAIN;
      source.connect(gain);
      gain.connect(ctx.destination);
      gainNodeRef.current = gain;
      audioBoostConnectedRef.current = true;
    } catch {
      // Web Audio unavailable/blocked (or source already created) — fall back to
      // plain element playback, which still works at the element's own volume.
    }
  }, [getAudioEl]);

  // Prime the reusable audio element on a user gesture so later programmatic
  // playback is allowed on mobile. Safe to call repeatedly.
  const unlockAudio = useCallback(() => {
    const el = getAudioEl();
    // Same gesture also unlocks/creates the gain stage used to boost loudness.
    setupAudioBoost();
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
  }, [getAudioEl, setupAudioBoost]);

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
      // Keep the gain-boosted graph running (contexts can auto-suspend); harmless
      // when no boost is wired.
      if (audioBoostConnectedRef.current) audioContextRef.current?.resume?.().catch(() => {});
      el.onended = () => {
        dispatchRef.current({ type: "AUDIO_ENDED" });
        // Streamed reply finished; its file is now persisted server-side. Let the
        // caller refetch once so the replay control appears (no polling needed).
        onReplyAudioSettledRef.current?.();
      };
      el.src = `${API_BASE}${url}`;
      el.muted = false;
      // Element is already at its ceiling; the audible loudness lift comes from
      // the Web Audio gain stage, not from this property.
      el.volume = 1.0;
      el.play().catch(() => {
        dispatchRef.current({ type: "AUDIO_FAILED" });
        onReplyAudioSettledRef.current?.();
      });
    },
    [getAudioEl]
  );

  const clearListenWatchdog = useCallback(() => {
    if (listenWatchdogRef.current) {
      clearTimeout(listenWatchdogRef.current);
      listenWatchdogRef.current = null;
    }
  }, []);

  // Tear down the current recognizer: detach handlers first so its trailing
  // `onend` can't fire a stray restart, then stop it. We discard the instance
  // rather than reuse it (the whole point of the mobile fix).
  const disposeRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      // Ignore stop() before start() / on an already-stopped instance.
    }
    recognitionRef.current = null;
  }, []);

  const stopRecognition = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    clearListenWatchdog();
    disposeRecognition();
  }, [clearListenWatchdog, disposeRecognition]);

  // Build a fresh, fully-wired SpeechRecognition. A NEW instance per listening
  // turn is the core mobile fix: reusing one long-lived instance is what makes
  // iOS Safari silently fail to capture on the 2nd+ `.start()`.
  const createRecognition = useCallback((): SpeechRecognitionLike | null => {
    const Ctor = SpeechRecognitionCtorRef.current;
    if (!Ctor) return null;
    const recognition = new Ctor();
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      clearListenWatchdog(); // proof of life: the recognizer is really capturing
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
      const combined = spoken ? `${base}${base ? " " : ""}${spoken}` : base;
      setDraft(combined);
      if (finalTranscript) {
        draftBeforeListening.current = `${base}${base ? " " : ""}${finalTranscript}`.trim();
      }

      // Voice loop only: after a silent gap, auto-send so the speaker can just
      // keep talking. Text-mode dictation never auto-sends. The wait is adaptive:
      // shorter when the utterance sounds finished, longer when it trails off on
      // a conjunction/preposition/filler so a thinking pause is not cut off.
      if (phaseRef.current === "listening") {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        const waitMs = recommendSilenceMs(combined, silenceAutoSendMsRef.current);
        silenceTimerRef.current = setTimeout(() => {
          if (draftBeforeListening.current.trim()) {
            handleSendRef.current();
          }
        }, waitMs);
      }
    };
    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      clearListenWatchdog();
      if (!voiceModeRef.current) {
        setIsDictating(false);
        return;
      }
      // Only a genuinely fatal error (mic blocked) drops the loop into the
      // tap-to-continue fallback. Transient errors like "no-speech"/"aborted"
      // fire constantly while listening hands-free between the user's turns;
      // ignoring them here lets the subsequent onend restart the mic so the
      // conversation keeps flowing without the user tapping every turn.
      if (FATAL_RECOGNITION_ERRORS.has(event.error)) {
        dispatchRef.current({ type: "RECOGNITION_ERROR" });
      }
    };
    recognition.onend = () => {
      clearListenWatchdog();
      if (voiceModeRef.current) {
        // In listening state this restarts the mic (mobile ends it
        // spontaneously); in any other state the machine ignores it.
        dispatchRef.current({ type: "RECOGNITION_ENDED" });
      } else {
        setIsDictating(false);
      }
    };
    return recognition;
  }, [clearListenWatchdog]);

  // fresh=true starts a brand-new utterance (voice loop, previous reply already
  // sent); fresh=false keeps whatever is already drafted (text-mode dictation).
  const startRecognition = useCallback(
    (fresh = true) => {
      if (!speechSupportedRef.current) return;
      // Always tear down any prior instance and build a new one — see
      // createRecognition. This is what makes turn 2+ reliably capture on mobile.
      clearListenWatchdog();
      disposeRecognition();
      const recognition = createRecognition();
      if (!recognition) return;
      recognitionRef.current = recognition;
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
        // A fresh instance shouldn't throw "already started", but if start()
        // fails outright in voice mode, surface the tap-to-continue fallback
        // rather than sitting in a listening state that never captures.
        recognitionRef.current = null;
        if (voiceModeRef.current) {
          dispatchRef.current({ type: "RECOGNITION_ERROR" });
        } else {
          setIsDictating(false);
        }
        return;
      }
      // Arm the mobile silent-start watchdog only for the hands-free loop.
      if (voiceModeRef.current && isMobileRef.current) {
        listenWatchdogRef.current = setTimeout(() => {
          listenWatchdogRef.current = null;
          if (phaseRef.current === "listening") {
            // Native recognizer never came alive — recover with a visible tap.
            disposeRecognition();
            dispatchRef.current({ type: "RECOGNITION_ERROR" });
          }
        }, MOBILE_LISTEN_WATCHDOG_MS);
      }
    },
    [clearListenWatchdog, disposeRecognition, createRecognition]
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
    // Stash the constructor; each listening turn builds its own instance via
    // createRecognition (fresh-instance-per-turn is the mobile capture fix).
    SpeechRecognitionCtorRef.current = SpeechRecognitionCtor;
    isMobileRef.current = isMobileSpeechPlatform();

    return () => {
      clearListenWatchdog();
      disposeRecognition();
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
  // In voice mode we start playing the reply's audio immediately from its stream
  // URL: the endpoint synthesizes and streams the audio on the fly, so playback
  // begins on the first chunk rather than after a fully buffered file plus a
  // poll cycle. No pending/polling step is involved anymore.
  const handleReply = useCallback((transcript: TranscriptMessage[]) => {
    if (!voiceModeRef.current) return;
    const last = transcript[transcript.length - 1];
    const hasAudio =
      last?.msgId &&
      last.audioUrl &&
      (last.audioStatus === "pending" || last.audioStatus === "ready");
    if (hasAudio && !playedAudioIds.current.has(last.msgId!)) {
      playedAudioIds.current.add(last.msgId!);
      dispatchRef.current({ type: "REPLY_AUDIO_READY" }, last.audioUrl);
    } else if (!hasAudio) {
      // Reply arrived with no audio to play — keep the loop moving.
      dispatchRef.current({ type: "REPLY_NO_AUDIO" });
    }
  }, []);

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
    handleMicTap,
    handleVoiceModeToggle,
    handleSend,
    handleReply,
    stopAudio,
  };
}
