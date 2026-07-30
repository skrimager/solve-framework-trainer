// Feature-flag gate for the Vapi voice pilot.
//
// The pilot replaces the browser voice pipeline (Web Speech API STT +
// client-side turn detection + streamed OpenAI TTS) with a Vapi call, for ONE
// scenario only. Everything in this file exists to make "is the pilot on right
// now?" a single pure predicate, so the answer is the same on the roleplay page
// and in tests, and so the default path cannot be reached differently by
// accident.
//
// THREE CONDITIONS, ALL REQUIRED
//   1. the build-time env flag VITE_VAPI_PILOT_ENABLED is on, OR the URL carries
//      ?vapi=1 (an escape hatch for testing a deployed build without a rebuild);
//   2. the active scenario slug is exactly the one pilot scenario;
//   3. a Vapi public key and assistant id are configured.
//
// Condition 2 is the hard safety property: no other scenario can enter the pilot
// path even with the flag on and keys present. Condition 3 means a half-configured
// environment silently stays on the existing path instead of failing at call time.
//
// NO localStorage. The project's website-building rules forbid it, so the runtime
// override is a query param — which also has the nicer property of being
// per-tab and shareable as a link.

// The ONE scenario the pilot serves. Must match VAPI_PILOT_SCENARIO_SLUG in
// server/vapiCustomLlm.ts and the slug in server/seed.ts.
export const VAPI_PILOT_SCENARIO_SLUG = "auto-sales-growing-family-suv";

// Query param that turns the pilot on for a single tab, e.g. /roleplay/42?vapi=1.
export const VAPI_PILOT_QUERY_PARAM = "vapi";

export interface VapiPilotConfig {
  // Vapi PUBLIC key. Safe in the browser by design — it can only start calls
  // against assistants in this account, and is a different credential from the
  // private key the setup script uses.
  publicKey: string;
  // Assistant to dial. Swapping this between the two A/B assistants created by
  // scripts/setup-vapi-pilot.ts is how the voices get compared by ear.
  assistantId: string;
}

// Truthiness for env flags. Vite inlines env vars as strings, so `false` and
// `"0"` both arrive as non-empty strings and would otherwise read as "on".
function envFlagOn(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export interface VapiPilotGateInput {
  // Slug of the scenario currently being role-played. Undefined while the
  // scenario query is still in flight — which must read as "not the pilot", so
  // the pilot can never be entered before the scenario is known.
  scenarioSlug?: string | null;
  // import.meta.env.VITE_VAPI_PILOT_ENABLED
  envFlag?: unknown;
  // window.location.search, passed in rather than read here so this stays pure.
  search?: string;
  config?: Partial<VapiPilotConfig> | null;
}

// True when the pilot should drive the voice UI. Every caller goes through this.
export function isVapiPilotActive({ scenarioSlug, envFlag, search, config }: VapiPilotGateInput): boolean {
  if (scenarioSlug !== VAPI_PILOT_SCENARIO_SLUG) return false;
  if (!config?.publicKey || !config?.assistantId) return false;
  if (envFlagOn(envFlag)) return true;
  return queryParamOn(search);
}

// Reads the per-tab override. Accepts `?vapi=1`, `?vapi=true`, and bare `?vapi`
// (no value), because a bare param is what someone typing the URL by hand writes.
export function queryParamOn(search?: string): boolean {
  if (!search) return false;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has(VAPI_PILOT_QUERY_PARAM)) return false;
  const value = params.get(VAPI_PILOT_QUERY_PARAM);
  // Bare `?vapi` yields "" — treat presence alone as opting in.
  return value === null || value === "" || envFlagOn(value);
}

// Pulls the browser-side config out of Vite's env. Returns null unless BOTH
// values are present, so callers get one "configured / not configured" answer
// instead of having to check each field.
export function vapiPilotConfigFromEnv(env: Record<string, unknown>): VapiPilotConfig | null {
  const publicKey = typeof env.VITE_VAPI_PUBLIC_KEY === "string" ? env.VITE_VAPI_PUBLIC_KEY.trim() : "";
  const assistantId = typeof env.VITE_VAPI_ASSISTANT_ID === "string" ? env.VITE_VAPI_ASSISTANT_ID.trim() : "";
  if (!publicKey || !assistantId) return null;
  return { publicKey, assistantId };
}
