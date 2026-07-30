// Creates (or updates) the Vapi assistants for the voice pilot.
//
//   npx tsx scripts/setup-vapi-pilot.ts        # create/update
//   npx tsx scripts/setup-vapi-pilot.ts --dry-run
//
// Everything about the pilot's Vapi configuration lives in this file. The Vapi
// dashboard is deliberately NOT used: the config has to be reproducible from the
// repo and reviewable in a diff, so any change is made here and re-run.
//
// The script is idempotent. It GETs /assistant, matches on the exact assistant
// `name`, and PATCHes an existing match instead of creating a duplicate. Re-run
// it as often as you like.
//
// Required env:
//   VAPI_API_KEY          Vapi PRIVATE key. Server-side only; never shipped to the browser.
//   VAPI_CUSTOM_LLM_URL   Public base URL of our custom-LLM route (see below).
// Optional env:
//   VAPI_ELEVENLABS_VOICE_ID  Opt-in only; see the ElevenLabs note below.

import { writeFileSync } from "node:fs";

const VAPI_API_BASE = "https://api.vapi.ai";
const OUTPUT_FILE = "VAPI_PILOT_ASSISTANTS.md";

// The ONE scenario this pilot targets. Must stay in sync with
// VAPI_PILOT_SCENARIO_SLUG in server/vapiCustomLlm.ts.
const PILOT_SCENARIO_SLUG = "auto-sales-growing-family-suv";

// Assistant names double as the idempotency key, so they must not be edited
// casually — renaming one causes the next run to create a second assistant
// rather than update the first.
const DEFAULT_VOICE_ASSISTANT_NAME = "SUV Pilot - Default Voice";
const ELEVENLABS_VOICE_ASSISTANT_NAME = "SUV Pilot - ElevenLabs Voice";

// ---------------------------------------------------------------------------
// Anti-interruption configuration. This is the entire point of the pilot.
//
// The failure we are fixing is reps being cut off mid-sentence while they are
// still actively speaking. Every value below is therefore biased HARD toward
// letting the rep finish, explicitly accepting that Priya will sometimes wait a
// beat too long before replying. A late reply is a mild annoyance; getting talked
// over mid-sentence is the bug we are here to eliminate.
//
// Ranges quoted below are from Vapi's own OpenAPI schema (GET
// https://api.vapi.ai/api-json), not from the docs site, so they are the limits
// the API actually enforces.
// ---------------------------------------------------------------------------

const STOP_SPEAKING_PLAN = {
  // Vapi default is 0, which means "interrupt on a VAD spike". A breath, a chair
  // creak, or a filler "um" is enough to trip that, which is exactly how reps get
  // cut off. Requiring 3 real transcribed words means Priya only yields when the
  // rep has demonstrably started saying something. Schema range: 0-10.
  //
  // Note: Vapi's schema documents `voiceSeconds` as being used ONLY when
  // numWords is 0. With numWords: 3 the word count is the active gate and
  // voiceSeconds below is inert — it is set anyway so that if anyone ever tunes
  // numWords back down to 0, they do not silently fall back to the twitchy 0.2s
  // default.
  numWords: 3,

  // Raised from the 0.2s default to reduce false-positive interrupts from breath
  // sounds and short pauses. 0.5 is the MAXIMUM the API accepts (schema:
  // minimum 0, maximum 0.5) — the brief asked for 0.5-0.8s, and 0.5 is as
  // conservative as Vapi allows.
  voiceSeconds: 0.5,

  // After any interruption, wait a full 2s before speaking again instead of the
  // 1s default. Without this, an accidental interrupt turns into Priya barging
  // straight back in and talking over the rep a second time. Schema range: 0-10.
  backoffSeconds: 2.0,

  // Vapi's default acknowledgement list ("okay", "right", "yeah", ...) already
  // never interrupts. We extend it with the disfluencies reps actually produce
  // mid-sentence while thinking, so "um, let me pull that up" cannot be read as
  // the rep taking the floor back.
  acknowledgementPhrases: [
    "i understand", "i see", "i got it", "i hear you", "im listening", "im with you",
    "right", "okay", "ok", "sure", "alright", "got it", "understood", "yeah", "yes",
    "uh-huh", "mm-hmm", "gotcha", "mhmm", "ah", "yeah okay", "yeah sure",
    // Pilot additions: filler and thinking noises, not turn-taking signals.
    "um", "uh", "hmm", "er", "so", "like", "you know", "i mean", "let me see",
    "one second", "hold on a sec", "bear with me",
  ],

  // Vapi's default interruption list includes "but", "not", "no", "hold" and
  // "wait" — all of which appear mid-sentence in ordinary sales speech ("...but
  // the warranty covers it", "hold on, let me check"). Under the default list
  // those words cut the rep off, which is the exact bug. Narrowed to phrases that
  // only ever mean "stop talking".
  interruptionPhrases: ["stop", "shut up", "be quiet", "enough", "nevermind", "never mind"],
} as const;

const START_SPEAKING_PLAN = {
  // Minimum wait before Priya speaks, up from the 0.4s default. This is the
  // single most effective guard against clipping a rep who pauses mid-sentence.
  // Schema range: 0-5.
  waitSeconds: 0.8,

  // Smart endpointing: a model that judges whether the rep has actually finished
  // a thought, rather than timing raw silence. Vapi recommends LiveKit for
  // English (it is English-only), and this pilot is English-only.
  //
  // waitFunction maps P(rep is still speaking) -> milliseconds to wait. Vapi's
  // default is "20 + 500 * sqrt(x) + 2500 * x^3". Ours is uniformly larger:
  // a 150ms floor even when the model is confident the rep is done, and a much
  // steeper climb so genuine uncertainty buys a long wait instead of a guess.
  smartEndpointingPlan: {
    provider: "livekit",
    waitFunction: "150 + 1200 * sqrt(x) + 5000 * x^3",
  },

  // Fallback layer, used where the smart endpointer is not decisive. All three
  // values are raised well above their defaults (0.1 / 1.5 / 0.5). Schema caps
  // each at 3.
  transcriptionEndpointingPlan: {
    // Even a confidently punctuated sentence gets a beat, because transcribers
    // punctuate mid-sentence pauses.
    onPunctuationSeconds: 0.4,
    // No punctuation means the transcriber was not confident the thought ended.
    // Wait a long time — this is the "...let me pull up the exact number..." case.
    onNoPunctuationSeconds: 2.5,
    // Reps read numbers in chunks ("four hundred... and twenty"). Long wait so a
    // price or a rate is never cut in half.
    onNumberSeconds: 1.5,
  },

  // Reps enumerate lists and figures out loud. When the rep's last utterance
  // trails off on a conjunction/filler or ends on a digit, override the plans
  // above with an even longer timeout. Custom rules have the highest precedence.
  customEndpointingRules: [
    {
      type: "customer",
      // Trailing conjunction, preposition, filler, or a bare number: the rep is
      // mid-thought, not done.
      regex: "\\b(and|or|but|so|because|the|a|an|to|for|with|about|um|uh|like|around|about)\\s*$|\\d\\s*$",
      timeoutSeconds: 3.0,
    },
  ],
} as const;

// Krisp denoising. Background speech and room noise are a direct cause of
// false-positive interrupts, so filtering them is another layer of the same fix.
const BACKGROUND_SPEECH_DENOISING_PLAN = {
  smartDenoisingPlan: { enabled: true },
} as const;

// English-tuned transcriber.
//
// `endpointing: 300` (up from the default 10) is Deepgram's own recommendation
// when reliability matters more than latency: a 10ms context drops short
// utterances and, more importantly here, finalizes too eagerly mid-sentence.
const TRANSCRIBER = {
  provider: "deepgram",
  model: "nova-2",
  language: "en",
  // Off on purpose: smart formatting sometimes rewrites spoken numbers as times
  // ("four twenty" -> "4:20"), and reps say prices out loud constantly.
  smartFormat: false,
  endpointing: 300,
} as const;

// ---------------------------------------------------------------------------
// Voices — the A/B comparison.
//
// (a) Vapi's own platform TTS. Requires no extra credential and is the pilot's
//     default. Two different Vapi voices are created so the pilot is genuinely
//     A/B-able by ear, with everything else about the two assistants identical.
//
// (b) ElevenLabs. NOT created by default, and this is a verified decision rather
//     than an assumption:
//       - Vapi's OpenAPI spec exposes no voice-library endpoint. The only
//         /provider/{provider}/{resourceName} route accepts exactly one resource,
//         "pronunciation-dictionary", so there is no API way to enumerate which
//         ElevenLabs voices an account can reach.
//       - The `ElevenLabsVoice.voiceId` field is documented as "Ensure the Voice
//         is present in your 11Labs Voice Library", and a
//         CreateElevenLabsCredentialDTO exists requiring `{ provider, apiKey }`.
//     Both point the same way: reaching an ElevenLabs voice through Vapi needs a
//     separate ElevenLabs API key (BYOK) attached to the Vapi account. Per the
//     pilot brief we therefore do not attempt it.
//
//     If you later add an ElevenLabs key to the Vapi account, set
//     VAPI_ELEVENLABS_VOICE_ID and re-run this script; the second variant will be
//     created with all the same anti-interruption settings so the comparison
//     stays apples-to-apples.
//
// Voice choice: Priya is 31, female, warm and nervous-excited (server/seed.ts),
// and the existing pipeline casts her as "nova" (server/voices.ts). "Neha" and
// "Paige" are both female Vapi platform voices from the schema's voiceId enum.
const VAPI_VOICE_A = { provider: "vapi", voiceId: "Neha", speed: 1.0 } as const;
const VAPI_VOICE_B = { provider: "vapi", voiceId: "Paige", speed: 1.0 } as const;

// Client messages the browser hook subscribes to (see
// client/src/hooks/use-vapi-voice-conversation.ts). "transcript" drives the live
// draft, "speech-update" drives the phase display, and "conversation-update"
// carries the OpenAI-formatted history the transcript adapter consumes.
const CLIENT_MESSAGES = [
  "conversation-update",
  "speech-update",
  "status-update",
  "transcript",
  "user-interrupted",
] as const;

type Json = Record<string, unknown>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`Missing required env var ${name}.`);
    console.error("See .env.example for what each Vapi pilot variable is for.");
    process.exit(1);
  }
  return value.trim();
}

async function vapiRequest(apiKey: string, method: string, path: string, body?: Json): Promise<any> {
  const res = await fetch(`${VAPI_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the request body on failure — it is config, not secrets, but the
    // response text is what actually explains a 400 from Vapi.
    throw new Error(`Vapi ${method} ${path} failed: ${res.status} ${res.statusText}\n${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// Builds the full assistant payload. Both variants share every setting except
// `name` and `voice`, which is what makes the voice comparison valid.
function buildAssistantPayload(name: string, voice: Json, customLlmUrl: string): Json {
  return {
    name,
    // Wait for the rep to open. This is a rep-initiated discovery conversation:
    // the rep greets the customer, exactly as in the existing text/voice flow.
    firstMessageMode: "assistant-waits-for-user",
    firstMessage: "",

    model: {
      provider: "custom-llm",
      // Vapi uses this as an OpenAI `baseURL` and POSTs to
      // `<url>/chat/completions`. Our route ignores the model name (the reply is
      // produced by our own prompt builder in server/llm.ts), but the field is
      // required, so it carries the scenario for legibility in Vapi's logs.
      url: customLlmUrl,
      model: `solve-${PILOT_SCENARIO_SLUG}`,
      // Our endpoint holds the full prompt; sending Vapi's own metadata would
      // only add noise it cannot use.
      metadataSendMode: "off",
      // getCustomerReply() does a full non-streaming OpenAI call before we start
      // writing SSE, so the first byte can legitimately take several seconds.
      // The 20s default is too tight on a cold start.
      timeoutSeconds: 30,
    },

    transcriber: TRANSCRIBER,
    voice,

    // The three anti-interruption layers.
    stopSpeakingPlan: STOP_SPEAKING_PLAN,
    startSpeakingPlan: START_SPEAKING_PLAN,
    backgroundSpeechDenoisingPlan: BACKGROUND_SPEECH_DENOISING_PLAN,

    clientMessages: CLIENT_MESSAGES,

    // A discovery role-play runs a few minutes; this is a backstop against a
    // forgotten open tab billing a long call.
    maxDurationSeconds: 1800,

    metadata: {
      solvePilot: "vapi-voice-pilot",
      scenarioSlug: PILOT_SCENARIO_SLUG,
    },
  };
}

// Idempotent upsert keyed on the assistant's exact `name`.
async function upsertAssistant(
  apiKey: string,
  existing: any[],
  name: string,
  voice: Json,
  customLlmUrl: string,
  dryRun: boolean,
): Promise<{ name: string; id: string }> {
  const payload = buildAssistantPayload(name, voice, customLlmUrl);
  const match = existing.find((a) => a?.name === name);

  if (dryRun) {
    console.log(`\n[dry-run] would ${match ? `PATCH /assistant/${match.id}` : "POST /assistant"} for "${name}":`);
    console.log(JSON.stringify(payload, null, 2));
    return { name, id: match?.id ?? "(not created — dry run)" };
  }

  if (match) {
    // PATCH rather than POST so re-running never leaves duplicate assistants
    // behind. `name` is omitted from the patch body since it is the match key.
    const { name: _omit, ...patch } = payload;
    const updated = await vapiRequest(apiKey, "PATCH", `/assistant/${match.id}`, patch);
    console.log(`Updated existing assistant "${name}" (${updated.id})`);
    return { name, id: updated.id };
  }

  const created = await vapiRequest(apiKey, "POST", "/assistant", payload);
  console.log(`Created assistant "${name}" (${created.id})`);
  return { name, id: created.id };
}

function writeSummary(
  results: { name: string; id: string }[],
  customLlmUrl: string,
  elevenLabsSkipped: boolean,
): void {
  const lines = [
    "# Vapi pilot assistants",
    "",
    "Generated by `npx tsx scripts/setup-vapi-pilot.ts`. Re-running the script",
    "updates the same assistants in place (matched by name) and rewrites this file.",
    "",
    `- Scenario: \`${PILOT_SCENARIO_SLUG}\` ("Growing Family Needs More Room", persona Priya)`,
    `- Custom-LLM URL: \`${customLlmUrl}\``,
    "",
    "## Assistant IDs",
    "",
    "| Variant | Assistant ID |",
    "| --- | --- |",
    ...results.map((r) => `| ${r.name} | \`${r.id}\` |`),
    "",
    "## Wiring these into the app",
    "",
    "Set these in the client environment (see `.env.example`):",
    "",
    "```",
    "VITE_VAPI_PILOT_ENABLED=true",
    "VITE_VAPI_PUBLIC_KEY=<your Vapi PUBLIC key>",
    `VITE_VAPI_ASSISTANT_ID=${results[0]?.id ?? "<assistant id>"}`,
    "```",
    "",
    "`VITE_VAPI_PUBLIC_KEY` is the **public** key, which is the only Vapi key the",
    "browser SDK needs and the only one safe to expose. The private",
    "`VAPI_API_KEY` used by this script must stay server-side.",
    "",
    "Vapi's REST API exposes no endpoint that returns the account's public key, so",
    "it has to be copied from the Vapi account settings once and stored as an env",
    "var. Everything else about the pilot is created by this script.",
    "",
    "## A/B-ing the two voices",
    "",
    "Both assistants are byte-for-byte identical except for `voice`, so swapping",
    "`VITE_VAPI_ASSISTANT_ID` between the IDs above changes only what Priya sounds",
    "like. Run the same call script (`VAPI_INTERRUPTION_TEST_SCRIPT.md`) against",
    "each and pick by ear.",
    "",
  ];

  if (elevenLabsSkipped) {
    lines.push(
      "## ElevenLabs variant: not created",
      "",
      "Reaching an ElevenLabs voice through Vapi requires a **separate ElevenLabs**",
      "**API key (BYOK)** attached to the Vapi account. Evidence, from Vapi's own",
      "OpenAPI spec rather than the docs site:",
      "",
      "- There is no voice-library endpoint. The only `/provider/{provider}/{resourceName}`",
      "  route accepts exactly one resource, `pronunciation-dictionary`, so the API",
      "  cannot even enumerate which ElevenLabs voices an account can reach.",
      "- `ElevenLabsVoice.voiceId` is documented as *\"Ensure the Voice is present in",
      "  your 11Labs Voice Library\"*, and `CreateElevenLabsCredentialDTO` requires",
      "  `{ provider, apiKey }`.",
      "",
      "Per the pilot brief, no ElevenLabs voice was attempted. The A/B comparison is",
      "instead between two Vapi platform voices, which needs no additional key.",
      "",
      "If an ElevenLabs key is later added to the Vapi account, set",
      "`VAPI_ELEVENLABS_VOICE_ID=<voice id>` and re-run this script — the ElevenLabs",
      "variant is created with identical anti-interruption settings so the",
      "comparison stays valid.",
      "",
    );
  }

  writeFileSync(OUTPUT_FILE, lines.join("\n"));
  console.log(`\nWrote ${OUTPUT_FILE}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  // A dry run should be runnable without credentials so the exact payload can be
  // reviewed in a PR.
  const apiKey = dryRun ? (process.env.VAPI_API_KEY ?? "").trim() : requireEnv("VAPI_API_KEY");
  const rawUrl = dryRun
    ? (process.env.VAPI_CUSTOM_LLM_URL ?? "https://example.invalid").trim()
    : requireEnv("VAPI_CUSTOM_LLM_URL");

  // Vapi appends "/chat/completions" to model.url, so the configured value must
  // be the base without it. Tolerate a trailing slash and a URL that already
  // includes the suffix rather than silently producing a 404 route.
  const customLlmUrl = rawUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  console.log(`Custom-LLM base URL: ${customLlmUrl}`);
  console.log(`Vapi will POST to:   ${customLlmUrl}/chat/completions`);

  // Existing assistants, fetched once and reused for both upserts. This GET is
  // what makes the script safe to re-run.
  const existing: any[] = apiKey ? await vapiRequest(apiKey, "GET", "/assistant?limit=1000") : [];
  if (apiKey) console.log(`Found ${existing.length} existing assistant(s) on this Vapi account.`);

  const results: { name: string; id: string }[] = [];
  results.push(await upsertAssistant(apiKey, existing, DEFAULT_VOICE_ASSISTANT_NAME, { ...VAPI_VOICE_A }, customLlmUrl, dryRun));
  results.push(
    await upsertAssistant(apiKey, existing, "SUV Pilot - Alt Platform Voice", { ...VAPI_VOICE_B }, customLlmUrl, dryRun),
  );

  const elevenLabsVoiceId = (process.env.VAPI_ELEVENLABS_VOICE_ID ?? "").trim();
  if (elevenLabsVoiceId) {
    console.log("\nVAPI_ELEVENLABS_VOICE_ID is set — creating the opt-in ElevenLabs variant.");
    console.log("This requires an ElevenLabs credential (BYOK) on the Vapi account; if none is");
    console.log("attached, Vapi will reject the call at dial time rather than here.");
    results.push(
      await upsertAssistant(
        apiKey,
        existing,
        ELEVENLABS_VOICE_ASSISTANT_NAME,
        { provider: "11labs", voiceId: elevenLabsVoiceId, model: "eleven_turbo_v2_5" },
        customLlmUrl,
        dryRun,
      ),
    );
  } else {
    console.log(`\nSkipping the "${ELEVENLABS_VOICE_ASSISTANT_NAME}" variant.`);
    console.log("Vapi exposes no voice-library endpoint, and ElevenLabs voices are documented as");
    console.log("needing to be present in YOUR 11Labs Voice Library (CreateElevenLabsCredentialDTO");
    console.log("requires an apiKey) — i.e. a SEPARATE ElevenLabs API key / BYOK is required.");
    console.log("Per the pilot brief, no ElevenLabs voice was attempted. The A/B comparison uses");
    console.log("two Vapi platform voices instead. To enable the ElevenLabs variant later, add an");
    console.log("ElevenLabs key to the Vapi account, set VAPI_ELEVENLABS_VOICE_ID, and re-run.");
  }

  writeSummary(results, customLlmUrl, !elevenLabsVoiceId);

  console.log("\nAnti-interruption settings applied (deliberately conservative):");
  console.log(`  stopSpeakingPlan.numWords        = ${STOP_SPEAKING_PLAN.numWords}   (Vapi default 0)`);
  console.log(`  stopSpeakingPlan.voiceSeconds    = ${STOP_SPEAKING_PLAN.voiceSeconds} (default 0.2, API max 0.5)`);
  console.log(`  stopSpeakingPlan.backoffSeconds  = ${STOP_SPEAKING_PLAN.backoffSeconds} (default 1)`);
  console.log(`  startSpeakingPlan.waitSeconds    = ${START_SPEAKING_PLAN.waitSeconds} (default 0.4)`);
  console.log(`  smartEndpointingPlan.provider    = ${START_SPEAKING_PLAN.smartEndpointingPlan.provider}`);
  console.log("\nNext: run through VAPI_INTERRUPTION_TEST_SCRIPT.md. Pass bar is zero mid-sentence cutoffs.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
