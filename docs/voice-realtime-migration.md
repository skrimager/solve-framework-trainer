# Phase 2 (scoping note): OpenAI Realtime API migration

This is a forward-looking scoping note, not a spec and not scheduled work. The
current voice pipeline was improved in place (streaming TTS plus an adaptive
end-of-turn heuristic); this document sketches what a future move to the OpenAI
Realtime API would involve so the tradeoffs are on record when someone decides
whether to take it on.

## Where we are today (post-improvement)

- STT: browser Web Speech API (`client/src/hooks/use-voice-conversation.ts`).
- Turn-taking: client-side adaptive silence heuristic (`client/src/lib/turnDetection.ts`).
- LLM reply: non-streaming chat completion via `POST /api/sessions/:id/message`.
- TTS: `gpt-4o-mini-tts`, streamed to the client on the first chunk from
  `GET /api/sessions/:id/audio-stream/:msgId` and teed to disk for replays.
- Playback: single `HTMLAudioElement` with a Web Audio gain boost and a mobile
  autoplay unlock.

This gets the audible reply to start in roughly 1 to 1.5 seconds. It is a real
improvement but it is still three sequential network hops (STT is local, then
LLM, then TTS) plus a heuristic for turn detection rather than true voice
activity detection.

## What a Realtime migration would change

- WebRTC connection directly from the browser to OpenAI. The backend mints a
  short-lived ephemeral key (a `/realtime/sessions` call using the standing
  `OPENAI_API_KEY`) and hands it to the client; the audio path never proxies
  through our server.
- Native server-side turn detection: `turn_detection: { type: "semantic_vad" }`
  with a tunable `eagerness` setting, replacing the Web Speech API plus the
  client-side silence heuristic entirely.
- Native streaming audio in and out over the peer connection, so the model
  starts responding while the user is still finishing, rather than after a full
  transcribe then complete then synthesize round trip.
- The Web Speech API dependency is removed, which also removes its
  cross-browser reliability quirks (the mobile fresh-instance workaround, the
  no-speech/aborted handling, the silent-start watchdog).

## Cost and latency tradeoffs

- Latency: expect end-to-end response start in roughly the 300 to 800 ms range,
  versus today's multi-second-to-~1.5s experience.
- Cost: Realtime audio pricing is billed on audio input and output tokens,
  which is a different (and generally higher) cost structure than the current
  chat completion plus `gpt-4o-mini-tts` setup. This is the main reason it was
  deferred: the current approach keeps the existing cost model.
- Complexity: adds WebRTC session management, ephemeral key minting and
  rotation, and a different client audio stack. The deterministic
  `voiceMachine` loop would need to be re-expressed against Realtime session
  events.

## Rough implementation outline (if pursued)

1. Backend endpoint to mint ephemeral Realtime sessions from `OPENAI_API_KEY`.
2. Client WebRTC setup: peer connection, local mic track, remote audio track
   wired through the existing gain stage.
3. Configure the session (voice, instructions, `semantic_vad`, eagerness).
4. Drive UI state from Realtime events instead of Web Speech plus the silence
   timer; retire `turnDetection.ts` and the Web Speech code paths.
5. Decide whether transcripts and replay audio are still persisted, and how.
