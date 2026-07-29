// Deterministic state machine for the roleplay voice-conversation loop.
//
// The old UI wired speech recognition (input) and audio playback (output) to
// conversation turns through ad-hoc event handlers gated by two independent
// toggles. That produced four possible behaviors and non-deterministic drift
// between them. This machine collapses the loop into a single, testable flow:
//
//   idle  --toggle on-->  listening
//   listening --send-->  processing
//   processing --reply w/ audio-->  ai_speaking --audio ends-->  listening
//   processing --reply w/o audio-->  listening
//   any (recoverable failure) -->  awaiting_user  (visible mic-tap affordance)
//   any --toggle off-->  idle
//
// `idle` is exactly "voice mode off". Every other state implies voice mode on.
// The reducer is pure: it returns the next state plus a list of side-effect
// intents for the component to execute (start/stop recognition, play/stop
// audio). This keeps the DOM/browser quirks out of the transition logic so the
// flow can be unit-tested in isolation.

export type VoiceState =
  | "idle"
  | "listening"
  | "processing"
  | "ai_speaking"
  | "awaiting_user";

export type VoiceEvent =
  | { type: "TOGGLE_VOICE_MODE"; on: boolean }
  // A message was submitted to the server (manually or via silence auto-send).
  | { type: "SEND" }
  // The reply arrived but its audio is still being generated server-side.
  | { type: "REPLY_AUDIO_PENDING" }
  // The reply's audio is ready to play.
  | { type: "REPLY_AUDIO_READY" }
  // The reply arrived with no audio to play (TTS failed or none produced).
  | { type: "REPLY_NO_AUDIO" }
  // TTS playback finished normally.
  | { type: "AUDIO_ENDED" }
  // TTS playback could not start/failed (e.g. mobile autoplay restriction).
  | { type: "AUDIO_FAILED" }
  // Speech recognition ended (onend) — on mobile this fires spontaneously.
  | { type: "RECOGNITION_ENDED" }
  // Speech recognition errored (permission denied, repeated no-speech, etc.).
  | { type: "RECOGNITION_ERROR" }
  // The user tapped the mic button.
  | { type: "MIC_TAP" };

export type VoiceEffect =
  | "START_LISTENING"
  // Chrome/Chromium's native SpeechRecognition enforces its own internal,
  // non-configurable session-length limit (commonly ~60s, decided server-side
  // by the browser, not this app). When that boundary fires mid-utterance it
  // looks identical to the "user stopped talking" case at the state-machine
  // level (RECOGNITION_ENDED), but it is NOT a new turn — the speaker may be
  // mid-sentence with zero silence. RESUME_LISTENING tells the hook to start
  // a new recognizer instance (still required per-turn for mobile capture)
  // WITHOUT wiping the draft already captured, so words already spoken are
  // never discarded. Contrast with START_LISTENING, which always means "begin
  // a genuinely new utterance" (AI just replied, or voice mode just turned
  // on) and correctly resets the draft to empty.
  | "RESUME_LISTENING"
  | "STOP_LISTENING"
  | "PLAY_AUDIO"
  | "STOP_AUDIO";

export interface VoiceContext {
  // Whether the browser exposes the Web Speech API. When false we never emit
  // START_LISTENING and land in `awaiting_user`, which the UI renders as a
  // "type your reply" fallback rather than a silent dead end.
  speechSupported: boolean;
}

export interface VoiceResult {
  state: VoiceState;
  effects: VoiceEffect[];
}

const noChange = (state: VoiceState): VoiceResult => ({ state, effects: [] });

// Pure mapping from "which listening effect fired" to "should the draft be
// wiped before this recognizer instance starts". Exported so it is directly
// unit-testable without any DOM/SpeechRecognition mocking — the hook (which
// does need that mocking) just calls this and passes the result to
// startRecognition(fresh). Keeping this decision here, next to the effects it
// classifies, is what stops a future new listening-effect from silently
// defaulting to the wrong behavior.
export function shouldResetDraftForEffect(effect: VoiceEffect): boolean {
  switch (effect) {
    case "START_LISTENING":
      return true;
    case "RESUME_LISTENING":
      return false;
    default:
      return true;
  }
}

// Resolve a transition that wants to begin listening. Falls back to
// `awaiting_user` (mic-tap / type affordance) when recognition is unavailable.
function beginListening(ctx: VoiceContext): VoiceResult {
  return ctx.speechSupported
    ? { state: "listening", effects: ["START_LISTENING"] }
    : { state: "awaiting_user", effects: [] };
}

export function voiceTransition(
  state: VoiceState,
  event: VoiceEvent,
  ctx: VoiceContext,
): VoiceResult {
  // Turning voice mode off is always allowed and always fully resets the loop.
  if (event.type === "TOGGLE_VOICE_MODE") {
    if (!event.on) {
      return { state: "idle", effects: ["STOP_LISTENING", "STOP_AUDIO"] };
    }
    // Turning voice mode on from idle. This is a user gesture, so it's the
    // right moment to start listening (and, in the component, unlock audio).
    if (state === "idle") return beginListening(ctx);
    return noChange(state);
  }

  switch (state) {
    case "idle":
      // Voice mode is off; the machine ignores conversation events. Text-mode
      // dictation is handled outside the machine.
      return noChange(state);

    case "listening":
      switch (event.type) {
        case "SEND":
          return { state: "processing", effects: ["STOP_LISTENING"] };
        case "MIC_TAP":
          // Tapping the mic while listening interrupts/stops early. The user
          // can then edit/send the draft or tap again to resume.
          return { state: "awaiting_user", effects: ["STOP_LISTENING"] };
        case "RECOGNITION_ENDED":
          // Fires both when the speaker genuinely paused (mobile browsers end
          // continuous recognition spontaneously between utterances) AND when
          // Chrome's own internal session-length cap kills a still-ongoing
          // utterance out from under the speaker (see RESUME_LISTENING doc
          // comment above). We cannot tell which case this is from the event
          // alone, but resuming without wiping the draft is safe either way:
          // if the speaker had genuinely finished, there is nothing in the
          // draft to preserve; if they were mid-sentence, this is exactly the
          // case that must not reset. So always resume rather than restart.
          return ctx.speechSupported
            ? { state: "listening", effects: ["RESUME_LISTENING"] }
            : { state: "awaiting_user", effects: [] };
        case "RECOGNITION_ERROR":
          // Permission denied or repeated failures — fall back to a mic tap
          // rather than silently retrying forever.
          return { state: "awaiting_user", effects: [] };
        default:
          return noChange(state);
      }

    case "processing":
      switch (event.type) {
        case "REPLY_AUDIO_PENDING":
          return noChange(state);
        case "REPLY_AUDIO_READY":
          return { state: "ai_speaking", effects: ["PLAY_AUDIO"] };
        case "REPLY_NO_AUDIO":
          // Nothing to play — resume listening immediately so voice mode never
          // silently renders a text-only reply and stalls.
          return beginListening(ctx);
        case "MIC_TAP":
          // Can't act mid-request; ignore.
          return noChange(state);
        default:
          return noChange(state);
      }

    case "ai_speaking":
      switch (event.type) {
        case "AUDIO_ENDED":
          return beginListening(ctx);
        case "AUDIO_FAILED":
          // Autoplay blocked / playback error — surface a mic tap instead of a
          // silent dead end.
          return { state: "awaiting_user", effects: ["STOP_AUDIO"] };
        case "MIC_TAP":
          // Barge-in: user wants to talk over/skip the reply. Stop audio and
          // start listening.
          return ctx.speechSupported
            ? { state: "listening", effects: ["STOP_AUDIO", "START_LISTENING"] }
            : { state: "awaiting_user", effects: ["STOP_AUDIO"] };
        default:
          return noChange(state);
      }

    case "awaiting_user":
      switch (event.type) {
        case "MIC_TAP":
          // Explicit resume after a fallback.
          return beginListening(ctx);
        case "SEND":
          // The user typed/dictated and sent from the fallback affordance.
          return { state: "processing", effects: [] };
        default:
          return noChange(state);
      }

    default:
      return noChange(state);
  }
}
