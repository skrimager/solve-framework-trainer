import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  voiceTransition,
  type VoiceState,
  type VoiceEvent,
  type VoiceContext,
} from "../client/src/lib/voiceMachine";

const SUPPORTED: VoiceContext = { speechSupported: true };
const UNSUPPORTED: VoiceContext = { speechSupported: false };

function run(state: VoiceState, event: VoiceEvent, ctx: VoiceContext = SUPPORTED) {
  return voiceTransition(state, event, ctx);
}

describe("voiceTransition - toggling voice mode", () => {
  test("turning voice mode on from idle starts listening", () => {
    const r = run("idle", { type: "TOGGLE_VOICE_MODE", on: true });
    assert.equal(r.state, "listening");
    assert.deepEqual(r.effects, ["START_LISTENING"]);
  });

  test("turning voice mode on with no speech support waits for the user", () => {
    const r = run("idle", { type: "TOGGLE_VOICE_MODE", on: true }, UNSUPPORTED);
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, []);
  });

  test("turning voice mode off from any state returns to idle and stops everything", () => {
    for (const state of [
      "listening",
      "processing",
      "ai_speaking",
      "awaiting_user",
    ] as VoiceState[]) {
      const r = run(state, { type: "TOGGLE_VOICE_MODE", on: false });
      assert.equal(r.state, "idle");
      assert.deepEqual(r.effects, ["STOP_LISTENING", "STOP_AUDIO"]);
    }
  });

  test("idle ignores conversation events (text mode)", () => {
    const r = run("idle", { type: "SEND" });
    assert.equal(r.state, "idle");
    assert.deepEqual(r.effects, []);
  });
});

describe("voiceTransition - the hands-free loop", () => {
  test("sending while listening moves to processing and stops the mic", () => {
    const r = run("listening", { type: "SEND" });
    assert.equal(r.state, "processing");
    assert.deepEqual(r.effects, ["STOP_LISTENING"]);
  });

  test("a reply with ready audio plays it", () => {
    const r = run("processing", { type: "REPLY_AUDIO_READY" });
    assert.equal(r.state, "ai_speaking");
    assert.deepEqual(r.effects, ["PLAY_AUDIO"]);
  });

  test("pending audio keeps waiting in processing", () => {
    const r = run("processing", { type: "REPLY_AUDIO_PENDING" });
    assert.equal(r.state, "processing");
    assert.deepEqual(r.effects, []);
  });

  test("audio finishing resumes listening automatically", () => {
    const r = run("ai_speaking", { type: "AUDIO_ENDED" });
    assert.equal(r.state, "listening");
    assert.deepEqual(r.effects, ["START_LISTENING"]);
  });

  test("a full turn cycles idle->listening->processing->ai_speaking->listening", () => {
    let s: VoiceState = "idle";
    s = run(s, { type: "TOGGLE_VOICE_MODE", on: true }).state;
    assert.equal(s, "listening");
    s = run(s, { type: "SEND" }).state;
    assert.equal(s, "processing");
    s = run(s, { type: "REPLY_AUDIO_READY" }).state;
    assert.equal(s, "ai_speaking");
    s = run(s, { type: "AUDIO_ENDED" }).state;
    assert.equal(s, "listening");
  });
});

describe("voiceTransition - failing safe (no silent dead ends)", () => {
  test("a reply with no audio resumes listening instead of stalling", () => {
    const r = run("processing", { type: "REPLY_NO_AUDIO" });
    assert.equal(r.state, "listening");
    assert.deepEqual(r.effects, ["START_LISTENING"]);
  });

  test("no-audio reply with no speech support falls back to the user", () => {
    const r = run("processing", { type: "REPLY_NO_AUDIO" }, UNSUPPORTED);
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, []);
  });

  test("TTS playback failure falls back to a mic-tap affordance", () => {
    const r = run("ai_speaking", { type: "AUDIO_FAILED" });
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, ["STOP_AUDIO"]);
  });

  test("recognition error falls back to a mic-tap affordance", () => {
    const r = run("listening", { type: "RECOGNITION_ERROR" });
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, []);
  });

  test("spontaneous recognition end while listening restarts the mic", () => {
    const r = run("listening", { type: "RECOGNITION_ENDED" });
    assert.equal(r.state, "listening");
    assert.deepEqual(r.effects, ["START_LISTENING"]);
  });

  test("recognition end with no support falls back to the user", () => {
    const r = run("listening", { type: "RECOGNITION_ENDED" }, UNSUPPORTED);
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, []);
  });
});

describe("voiceTransition - manual mic taps", () => {
  test("tapping the mic while listening stops early and awaits the user", () => {
    const r = run("listening", { type: "MIC_TAP" });
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, ["STOP_LISTENING"]);
  });

  test("tapping the mic while awaiting resumes listening", () => {
    const r = run("awaiting_user", { type: "MIC_TAP" });
    assert.equal(r.state, "listening");
    assert.deepEqual(r.effects, ["START_LISTENING"]);
  });

  test("tapping the mic during playback barges in (stops audio, starts listening)", () => {
    const r = run("ai_speaking", { type: "MIC_TAP" });
    assert.equal(r.state, "listening");
    assert.deepEqual(r.effects, ["STOP_AUDIO", "START_LISTENING"]);
  });

  test("barge-in with no speech support just stops audio and awaits the user", () => {
    const r = run("ai_speaking", { type: "MIC_TAP" }, UNSUPPORTED);
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, ["STOP_AUDIO"]);
  });

  test("mic taps during processing are ignored", () => {
    const r = run("processing", { type: "MIC_TAP" });
    assert.equal(r.state, "processing");
    assert.deepEqual(r.effects, []);
  });

  test("sending from the awaiting_user fallback moves to processing", () => {
    const r = run("awaiting_user", { type: "SEND" });
    assert.equal(r.state, "processing");
    assert.deepEqual(r.effects, []);
  });
});

// The hook creates a brand-new SpeechRecognition per listening turn (iOS Safari
// silently fails to re-capture on a reused instance). When even a fresh start
// shows no sign of life, a mobile watchdog / a thrown start() feeds
// RECOGNITION_ERROR so the loop drops to a visible "tap to continue" affordance
// instead of a silent dead end. These assert that machine-level escape+recovery.
describe("voiceTransition - mobile silent-start recovery", () => {
  test("a silent/failed listening start recovers to a tap-to-continue affordance", () => {
    const r = run("listening", { type: "RECOGNITION_ERROR" });
    assert.equal(r.state, "awaiting_user");
    assert.deepEqual(r.effects, []);
  });

  test("tapping to continue then restarts a fresh listening turn", () => {
    let s: VoiceState = "listening";
    s = run(s, { type: "RECOGNITION_ERROR" }).state;
    assert.equal(s, "awaiting_user");
    const resume = run(s, { type: "MIC_TAP" });
    assert.equal(resume.state, "listening");
    // START_LISTENING is what the hook turns into a NEW recognizer instance.
    assert.deepEqual(resume.effects, ["START_LISTENING"]);
  });

  test("every resumed turn re-issues START_LISTENING (fresh instance per turn)", () => {
    for (const trigger of [
      { type: "AUDIO_ENDED" } as VoiceEvent,
      { type: "REPLY_NO_AUDIO" } as VoiceEvent,
      { type: "RECOGNITION_ENDED" } as VoiceEvent,
    ]) {
      const from: VoiceState =
        trigger.type === "AUDIO_ENDED"
          ? "ai_speaking"
          : trigger.type === "REPLY_NO_AUDIO"
            ? "processing"
            : "listening";
      const r = run(from, trigger);
      assert.equal(r.state, "listening");
      assert.deepEqual(r.effects, ["START_LISTENING"]);
    }
  });
});
