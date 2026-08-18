# Discovery scenario and voice investigation

**Scope:** session 503 (`auto-sales-tech-worker-upgrade`); no deploy or production configuration was changed.

## Executive findings

1. **Inventory/test-drive requests are a prompt-boundary gap, not a scenario-only defect.** Session 503 contains the reported catalog-style questions and ends with a request to test drive (source evidence: `/home/user/workspace/session_503_transcript.txt`, JSON line 1). The scenario core establishes Alex's situation, hidden reliability need, and discovery behavior, but has no rule that forbids physical inventory, catalog browsing, or in-person actions (`/home/user/workspace/scenario_config.json:7`).
2. **The active checked-out product uses neither Vapi nor OpenAI Realtime.** It uses browser Web Speech recognition, a client silence heuristic, an OpenAI chat reply, and streamed `gpt-4o-mini-tts` audio (`docs/voice-realtime-migration.md:9-22`). Vapi is not a dependency or source path on the active branch; the Vapi implementation exists only on the divergent remote `origin/vapi-voice-pilot-suv` branch.
3. **The current voice configuration contains direct explanations for both quality complaints.** The universal TTS instruction explicitly requires a "flat, calm, and even" voice (`server/voices.ts:156-166`), while a transcript classified as complete is auto-sent after only `2500 * 0.4 = 1000 ms` (`client/src/lib/turnDetection.ts:24-44, 155-183`).

## Bug 1 — nonsensical requests to browse inventory or test drive

### Evidence and actual prompt path

- The scenario JSON identifies the affected record as `auto-sales-tech-worker-upgrade` (`scenario_config.json:3`) and its persona text calls Alex a customer in a discovery conversation but does not prohibit catalog/inventory/test-drive behavior (`scenario_config.json:5,7-10`).
- The app uses `personaCore` when populated and falls back only for legacy scenarios (`server/persona.ts:152-158`); therefore the `persona_core` in the supplied config is the relevant scenario text, not the legacy `customer_persona` column.
- Real session creation calls `getCustomerOpening(personaOpeningCoreFor(scenario), ...)` (`server/routes.ts:394-395`), and ordinary replies call `getCustomerReply(personaCoreFor(scenario), ...)` (`server/routes.ts:1089-1090`).
- The streamed voice path uses the same shared reply function through `runReplyStream`, passing `personaCoreFor(scenario)` (`server/turnStream.ts:116-123`). This also covers the public/demo flow because `buildCustomerReplyStablePrefix` is the shared reply-template assembler (`server/llm.ts:432-457`).
- Before this change, the strongest shared role rule prohibited speaking *as* the dealership or claiming its inventory (`server/llm.ts:394-402`), but it did not prohibit a simulated customer from asking to be shown physical inventory or from requesting a test drive. The existing reactive-only rule also did not define the no-physical-inventory boundary (`server/llm.ts:408-424`).

### Implemented PR change

Branch: `fix/global-discovery-only-boundary`

The change is deliberately global and small:

- Adds `DISCOVERY_ONLY_PRACTICE_RULES` as the first instruction in both opening and reply prompts (`server/llm.ts:380-388, 457`).
- The hard rule says the exercise has no physical inventory, catalog, showroom, jobsite, or appointment; forbids asking to see/browse/view physical inventory, brochures, SKUs/models/units/options, in-stock products, demonstrations, or test drives; and prevents premature pitching from being redirected into a product browse (`server/llm.ts:382-388`).
- It still allows general category preference and a reaction to a consultant's verbal description, so it does not make discovery unnaturally restrictive (`server/llm.ts:386-388`).
- Refactors the opening prompt into the pure `buildCustomerOpeningPrompt` helper, so the opening turn receives the same rule and the placement can be unit tested (`server/llm.ts:164-205`).
- Adds tests that require the block to be first in all reply difficulties and consulting/leadership openings, plus phrase-level coverage of the forbidden and allowed behaviors (`server/llm.test.ts:88-114`).

### Validation

- `npm run check` passed.
- Focused prompt/persona/stream tests passed: **267 tests, 0 failures** (`server/llm.test.ts`, `server/persona.test.ts`, `server/turnStream.test.ts`).
- `git diff --check` passed.

## Bug 2 — slow/monotone voice and mid-sentence cutoffs

### Provider and architecture determination

**Vapi is not active on the checked-out branch.** Active `package.json` contains `openai` but not `@vapi-ai/web`; Vapi source files (`client/src/lib/vapiPilot.ts`, `client/src/hooks/use-vapi-voice-conversation.ts`, `server/vapiCustomLlm.ts`, `scripts/setup-vapi-pilot.ts`) are absent from `HEAD`. The old Vapi work remains on remote `origin/vapi-voice-pilot-suv`, so its `stopSpeakingPlan` settings are not current runtime settings.

**OpenAI Realtime is also not active.** The Realtime document calls itself a forward-looking, unscheduled scoping note (`docs/voice-realtime-migration.md:1-7`) and says a future migration would add a `/realtime/sessions` endpoint and `semantic_vad` (`docs/voice-realtime-migration.md:24-38, 53-60`). No such endpoint or WebSocket/WebRTC client is present on the active branch.

**Current pipeline:**

1. Browser Web Speech API captures speech (`client/src/hooks/use-voice-conversation.ts:356-364`).
2. The client concatenates interim/final transcript text and starts an adaptive auto-send timer on every result (`client/src/hooks/use-voice-conversation.ts:366-405`).
3. The app sends the text turn to the normal session message route; the reply is generated and the first completed sentence is TTS-synthesized and pushed over SSE (`server/routes.ts:1057-1084, 1320-1339`).
4. OpenAI TTS is invoked directly with `client.audio.speech.create` (`server/llm.ts:120-130, 141-157`).

The public staging service is reachable, but its page exposes no provider or runtime voice configuration. Therefore source control establishes the application architecture, while production-only environment values cannot be asserted without Render environment/log access.

### Exact active-source configuration

| Concern | Current value / behavior | Evidence |
|---|---|---|
| TTS provider/model | Direct OpenAI `gpt-4o-mini-tts` unless `OPENAI_TTS_MODEL` overrides it | `server/llm.ts:107-108, 120-129, 141-153` |
| Session 503 voice ID | `echo` for `auto-sales-tech-worker-upgrade` | `server/voices.ts:42-49`; route applies per-scenario voice at `server/routes.ts:1309-1316` |
| TTS speed runtime fallback | `1.0` when `OPENAI_TTS_SPEED` is absent/invalid | `server/llm.ts:109-115` |
| Repository env-template value | `OPENAI_TTS_SPEED=1.12`; this conflicts with its comment claiming that it is the default | `.env.example:10-11` |
| Runtime deployment env evidence | The supplied local `.env` has no `OPENAI_TTS_SPEED`, `OPENAI_TTS_MODEL`, Vapi, or Realtime key. Render secrets were not available to inspect, so the deployed override (if any) is **not verified**. | local checkout environment inspection |
| Voice delivery instruction | Every persona gets a universal directive to keep delivery "flat, calm, and even" and to keep the voice level regardless of content | `server/voices.ts:145-177` |
| Base end-of-turn wait | `2500 ms` | `client/src/lib/turnDetection.ts:24-30` |
| "Complete" turn wait | `1000 ms` (`2500 * 0.4`) | `client/src/lib/turnDetection.ts:32-37, 175-183` |
| "Neutral" turn wait | `2500 ms` | `client/src/lib/turnDetection.ts:30, 175-183` |
| "Incomplete" turn wait | `4250 ms` (`2500 * 1.7`), capped at `5000 ms` | `client/src/lib/turnDetection.ts:37-44, 175-183` |
| Complete classification | trailing terminal punctuation or words such as `yes`, `right`, `good`, `thanks` | `client/src/lib/turnDetection.ts:79-88, 155-165` |
| Recognition mode | `interimResults=true`; `continuous=true` in voice mode | `client/src/hooks/use-voice-conversation.ts:356-405, 435-480` |
| Vapi `stopSpeakingPlan` / transcriber config | **Not applicable to the active product path** | Vapi source/config absent from `HEAD`; see provider finding above |
| OpenAI Realtime VAD threshold/silence config | **Not applicable to the active product path**; it has not been implemented | `docs/voice-realtime-migration.md:24-38, 53-60` |

### Diagnosis

- **Monotone:** The source has an explicit global instruction to be flat and even on every line. That is a direct, high-confidence contributor to the reported monotony, especially because session 503 has no scenario-specific voice instruction to counterbalance it (`server/voices.ts:134-177`).
- **Slow/does not keep pace:** This is not Realtime bidirectional audio. It is browser STT, then a normal request/LLM reply, then TTS. The architecture note acknowledges sequential hops and heuristic turn detection rather than actual VAD (`docs/voice-realtime-migration.md:19-22`). The exact deployed speed override remains unverified; do not change it based only on `.env.example`.
- **Cuts the consultant off:** The client auto-sends after a silence interval derived from the provisional Web Speech transcript. If an interim/final partial happens to end in punctuation or a sentence-final token, the app uses the 1-second complete interval and calls `handleSend` (`client/src/hooks/use-voice-conversation.ts:386-405`; `client/src/lib/turnDetection.ts:155-183`). That is aggressive enough to turn a normal mid-thought pause into a completed turn. The code's own comments identify this browser heuristic as distinct from semantic VAD (`client/src/lib/turnDetection.ts:1-12`).

### Recommended fix — diagnosis only, no voice-pipeline change in this PR

1. **Do a controlled delivery A/B before changing providers.** Keep Alex on `echo` initially, but replace the universal final mandate "flat, calm, and even" with a controlled conversational instruction: allow subtle, context-appropriate prosody and emphasis while forbidding extreme anger/excitement or volume spikes. This directly removes the instruction that causes monotony without forcing a provider/voice migration. Evaluate the same transcript against the current and revised instruction by ear.
2. **Make endpointing less aggressive in a separate, feature-flagged PR.** Keep `DEFAULT_SILENCE_MS=2500` for the neutral case initially, but raise `COMPLETE_RATIO` from `0.4` to `0.6`; that makes the complete wait `1500 ms` rather than `1000 ms`. Add an explicit test for a mid-thought provisional transcript that arrives with punctuation, and compare interruption rate and perceived latency before global rollout. This is safer than changing every wait class at once.
3. **If the desired experience is genuinely real-time, plan rather than partially emulate a Realtime migration.** The documented future target is OpenAI Realtime WebRTC with `semantic_vad` and tunable `eagerness` (`docs/voice-realtime-migration.md:24-38, 53-60`). That is a larger cost/architecture decision, so it should not be folded into this prompt PR. Vapi should not be diagnosed or tuned as though it is live.
4. **Verify deployment settings before any rollout.** Inspect the Render production service environment or startup diagnostics for `OPENAI_TTS_MODEL` and `OPENAI_TTS_SPEED` (with values safely redacted where appropriate) and record the effective non-secret values. The repository source establishes fallback values but cannot prove a production override.

## PR status

A focused prompt-only PR is prepared from `fix/global-discovery-only-boundary`. It has not been merged or deployed. Voice changes are intentionally excluded because they need listening validation and separate approval.
