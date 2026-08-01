// Vapi-backed voice conversation hook — PILOT, one scenario only.
//
// WHY THIS EXISTS
// The default voice engine (use-voice-conversation.ts) decides when the rep has
// finished talking from the browser itself: Web Speech API interim results plus
// the adaptive silence heuristic in lib/turnDetection.ts. That works, but a
// natural mid-sentence pause ("so the monthly payment would be... let me pull up
// the number...") can read as end-of-turn and cut the rep off. Vapi moves turn
// detection server-side, where a real endpointing model and a conservative
// stopSpeakingPlan (configured in scripts/setup-vapi-pilot.ts) decide instead.
//
// This hook is a DROP-IN ALTERNATIVE, not a replacement. It returns the same
// shape as useVoiceConversation so the roleplay page can pick one at runtime
// without branching its JSX. use-voice-conversation.ts, turnDetection.ts and
// voiceMachine.ts are untouched and remain the default for every scenario.
//
// INERT WHEN DISABLED — the important bit
// React forbids conditional hook calls, so the roleplay page must call BOTH
// hooks on every render and choose between the results. That means this hook
// runs for every scenario, including ones the pilot must never touch. So while
// `enabled` is false it constructs no Vapi client, requests no microphone,
// registers no listeners, and opens no network connection. It is a state-free
// stub returning the same keys with the same types.
//
// WHAT IT DOES NOT DO
// It does not persist turns or trigger scoring. On the Vapi path the whole
// conversation happens inside the call: Vapi transcribes the rep, POSTs to our
// custom-LLM route (server/vapiCustomLlm.ts) which calls the existing
// getCustomerReply(), and speaks the result. No /api/sessions/:id/message round
// trip happens, so nothing is written to the session. That is deliberate for a
// pilot whose pass bar is "zero mid-sentence cutoffs" — persisting a Vapi call
// would mean a new write route and a change to how sessions are scored, both of
// which are out of scope here. The adapted transcript is exposed via
// `vapiTranscript` (already in the exact TranscriptMessage[] shape
// scoreTranscript() consumes) so that wiring is a small, separate change.

import { useState, useRef, useEffect, useCallback } from "react";
import Vapi from "@vapi-ai/web";
import {
  vapiTranscriptEventsToTranscript,
  type VapiTranscriptEvent,
} from "@shared/vapiTranscript";
import type { VoiceState } from "@/lib/voiceMachine";
import type { VapiPilotConfig } from "@/lib/vapiPilot";
import type { TranscriptMessage } from "@shared/schema";
import type { UseVoiceConversationOptions } from "./use-voice-conversation";

export interface UseVapiVoiceConversationOptions extends UseVoiceConversationOptions {
  // Master switch. False for every scenario except the pilot one with the flag
  // on; see lib/vapiPilot.ts. When false this hook does nothing at all.
  enabled: boolean;
  // Public key + assistant id. Null whenever the pilot is not configured.
  config: VapiPilotConfig | null;
}

// The status/label strings are copied verbatim from useVoiceConversation so the
// UI reads identically on both paths — a rep A/B-ing the two voices should not be
// able to tell which engine is running from the on-screen copy, only from how it
// feels to talk to.
function statusFor(voiceMode: boolean, phase: VoiceState): string | null {
  if (!voiceMode) return null;
  if (phase === "listening") return "Listening — just keep talking.";
  if (phase === "processing") return "Customer is thinking...";
  if (phase === "ai_speaking") return "Customer is speaking — tap the mic to jump in.";
  if (phase === "awaiting_user") return "Tap the mic to continue the conversation.";
  return null;
}

function micLabelFor(voiceMode: boolean, phase: VoiceState, isListening: boolean): string {
  if (!voiceMode) return "Start voice input";
  if (phase === "ai_speaking") return "Interrupt and speak";
  return isListening ? "Stop listening" : "Start listening";
}

export type UseVapiVoiceConversationResult = {
  draft: string;
  setDraft: (value: string) => void;
  voiceMode: boolean;
  phase: VoiceState;
  isDictating: boolean;
  speechSupported: boolean;
  micActive: boolean;
  isListening: boolean;
  voiceStatus: string | null;
  micLabel: string;
  handleMicTap: () => void;
  handleVoiceModeToggle: (next: boolean) => void;
  handleSend: () => void;
  handleReply: (transcript: TranscriptMessage[]) => void;
  handleReplyStream: (streamUrl: string) => void;
  stopAudio: () => void;
  // Pilot-only additions. The default hook has no equivalent; the roleplay page
  // reads them only on the pilot path.
  vapiTranscript: TranscriptMessage[];
  callActive: boolean;
  errorMessage: string | null;
};

export function useVapiVoiceConversation({
  enabled,
  config,
  send,
  isSending,
}: UseVapiVoiceConversationOptions): UseVapiVoiceConversationResult {
  const [draft, setDraft] = useState("");
  const [voiceMode, setVoiceMode] = useState(false);
  const [phase, setPhase] = useState<VoiceState>("idle");
  const [callActive, setCallActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Raw Vapi transcript events, kept as-received. The adapter converts them on
  // read rather than on write, so partial/final handling and same-speaker merging
  // live in exactly one place (shared/vapiTranscript.ts) and stay testable
  // without React.
  const [events, setEvents] = useState<VapiTranscriptEvent[]>([]);

  const vapiRef = useRef<Vapi | null>(null);

  const stopCall = useCallback(() => {
    const client = vapiRef.current;
    vapiRef.current = null;
    if (!client) return;
    // Vapi's stop() rejects if the call already ended; that is not an error worth
    // surfacing, and swallowing it keeps teardown idempotent.
    client.stop().catch(() => {});
    client.removeAllListeners();
  }, []);

  // Tear the call down when the component unmounts or the pilot is switched off
  // mid-session, so a live mic can never outlive the page that opened it.
  useEffect(() => {
    if (enabled) return;
    stopCall();
    setVoiceMode(false);
    setPhase("idle");
    setCallActive(false);
    setEvents([]);
  }, [enabled, stopCall]);

  useEffect(() => stopCall, [stopCall]);

  const startCall = useCallback(async () => {
    if (!enabled || !config) return;
    if (vapiRef.current) return;
    setErrorMessage(null);
    setEvents([]);
    const client = new Vapi(config.publicKey);
    vapiRef.current = client;

    client.on("call-start", () => {
      setCallActive(true);
      // The assistant is configured with firstMessageMode
      // "assistant-waits-for-user", so the call opens with the rep holding the
      // floor. `listening` is the honest phase to show.
      setPhase("listening");
    });
    client.on("call-end", () => {
      setCallActive(false);
      setPhase("idle");
    });
    // Vapi's speech-start/-end refer to the ASSISTANT speaking. The rep's own
    // speech boundaries are not surfaced as events here, and deliberately are not
    // inferred: guessing them client-side is exactly the mistake the pilot is
    // testing a fix for.
    client.on("speech-start", () => setPhase("ai_speaking"));
    client.on("speech-end", () => setPhase("listening"));
    client.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const type = (message as { type?: unknown }).type;
      if (type === "transcript") {
        const event = message as VapiTranscriptEvent & { type: string };
        // Store every transcript message, partials included; the adapter drops
        // partials on read. Keeping them here means a future debug view can show
        // what the transcriber actually heard mid-utterance.
        setEvents((prev) => [...prev, { role: event.role, transcriptType: event.transcriptType, transcript: event.transcript }]);
      } else if (type === "user-interrupted") {
        // The rep talked over the customer and Vapi yielded the floor. That is
        // the desired behaviour (a rep can always jump in); the reverse — the
        // customer cutting the rep off — is what must never happen.
        setPhase("listening");
      }
    });
    client.on("error", (err: unknown) => {
      const detail =
        err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "Voice call error.";
      setErrorMessage(detail);
      setCallActive(false);
      setPhase("idle");
    });

    try {
      await client.start(config.assistantId);
    } catch (err) {
      vapiRef.current = null;
      client.removeAllListeners();
      setErrorMessage(err instanceof Error ? err.message : "Could not start the voice call.");
      setVoiceMode(false);
      setPhase("idle");
    }
  }, [enabled, config]);

  const handleVoiceModeToggle = useCallback(
    (next: boolean) => {
      if (!enabled) return;
      setVoiceMode(next);
      if (next) {
        void startCall();
      } else {
        stopCall();
        setPhase("idle");
        setCallActive(false);
      }
    },
    [enabled, startCall, stopCall]
  );

  // On the Vapi path the mic is owned by the call, not by a per-turn recognizer,
  // so a tap means "leave/join the call" rather than "start/stop listening".
  const handleMicTap = useCallback(() => {
    if (!enabled) return;
    if (vapiRef.current) {
      stopCall();
      setVoiceMode(false);
      setPhase("idle");
      setCallActive(false);
      return;
    }
    setVoiceMode(true);
    void startCall();
  }, [enabled, startCall, stopCall]);

  // Typed fallback. Vapi has no text-turn concept, so a typed reply goes through
  // the caller's normal `send` — the same transport the default path uses — which
  // keeps the text box working while the pilot is on.
  const handleSend = useCallback(() => {
    const content = draft.trim();
    if (!content || isSending) return;
    send(content, false);
    setDraft("");
  }, [draft, isSending, send]);

  // Present so the return type matches the default hook exactly. Reply audio is
  // synthesized and played by Vapi, so there is nothing to fetch or schedule.
  const handleReply = useCallback((_transcript: TranscriptMessage[]) => {}, []);
  const handleReplyStream = useCallback((_streamUrl: string) => {}, []);
  const stopAudio = useCallback(() => {
    // The only way to silence the customer on this path is to stop the call;
    // Vapi owns the audio element. Interrupting by speaking is the intended
    // in-conversation route (see the user-interrupted handler above).
    if (!enabled) return;
    stopCall();
    setCallActive(false);
    setPhase("idle");
  }, [enabled, stopCall]);

  const isListening = phase === "listening";
  const vapiTranscript = enabled ? vapiTranscriptEventsToTranscript(events) : [];

  return {
    draft,
    setDraft,
    voiceMode,
    phase,
    // Dictation-into-the-textbox has no Vapi equivalent: the call is either live
    // or it is not.
    isDictating: false,
    // Vapi does its own capture and transcription in a WebRTC session, so the
    // browser's SpeechRecognition support is irrelevant — voice is always
    // available on this path.
    speechSupported: enabled,
    micActive: callActive,
    isListening,
    voiceStatus: statusFor(voiceMode, phase),
    micLabel: micLabelFor(voiceMode, phase, isListening),
    handleMicTap,
    handleVoiceModeToggle,
    handleSend,
    handleReply,
    handleReplyStream,
    stopAudio,
    vapiTranscript,
    callActive,
    errorMessage,
  };
}
