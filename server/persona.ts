import type { Scenario, Session } from "@shared/schema";

// Per-session persona variation. Each scenario carries a FIXED core (identity,
// situation, opening stance, and the designed ideal-outcome behavior that must
// never change) plus three pools: personality/communication styles, primary
// motivation drivers, and objections. When a session starts we draw one
// personality, one motivation, and a small ordered subset of objections, so the
// same scenario plays out differently each replay while the same underlying
// customer and the same "solved" outcome are preserved. The selection is stored
// resolved on the session so every turn reconstructs the identical rendition.

// The structured pools a scenario exposes for variation.
export interface ScenarioPersonaVariants {
  personalityVariants: string[];
  motivationVariants: string[];
  objectionPool: string[];
}

// The one-time structured rewrite of a scenario's persona: the fixed core prose
// plus the three variation pools. Stored in server/personaVariants.ts keyed by
// scenario slug and merged into the seed rows / backfilled onto existing rows.
export interface PersonaVariantSeed {
  core: string;
  personalities: string[];
  motivations: string[];
  objections: string[];
}

// One objection drawn for a session, tagged with roughly where in the
// conversation it should surface.
export type ObjectionPosition = "early" | "midway" | "later";
export interface SelectedObjection {
  text: string;
  position: ObjectionPosition;
}

// The resolved rendition chosen for a single session. Stored as JSON on
// sessions.persona_variant so it is stable across every turn of that session.
export interface SelectedPersonaVariant {
  personality: string;
  motivation: string;
  objections: SelectedObjection[];
}

// Deterministic, seedable PRNG (mulberry32). Used so a session with no stored
// variant (a legacy or in-flight row) still reconstructs the SAME rendition on
// every turn — seeded by the session id — and so tests can draw reproducibly.
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: T[], rng: () => number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

// Fisher-Yates shuffle using the injectable RNG. Does not mutate the input.
function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const POSITIONS: ObjectionPosition[] = ["early", "midway", "later"];

// Chooses this session's rendition: one personality, one motivation, and a
// random 1-2 objections (in a random order, each tagged with a rough position).
// Pools may be empty (an unmigrated or future scenario), in which case the
// corresponding field is left blank and buildPersonaVariantSection collapses to
// an empty string, making the whole feature a no-op for that scenario.
export function selectPersonaVariant(
  variants: ScenarioPersonaVariants,
  rng: () => number = Math.random
): SelectedPersonaVariant {
  const personality = pick(variants.personalityVariants, rng) ?? "";
  const motivation = pick(variants.motivationVariants, rng) ?? "";

  const pool = variants.objectionPool ?? [];
  let objections: SelectedObjection[] = [];
  if (pool.length > 0) {
    const shuffled = shuffle(pool, rng);
    // Draw 1-2 objections so no two sessions surface the same set/order.
    const count = Math.min(shuffled.length, 1 + Math.floor(rng() * 2));
    objections = shuffled.slice(0, count).map((text, i) => ({
      text,
      position: POSITIONS[Math.min(i, POSITIONS.length - 1)],
    }));
  }

  return { personality, motivation, objections };
}

const POSITION_HINT: Record<ObjectionPosition, string> = {
  early: "early in the conversation",
  midway: "once the conversation is underway",
  later: "later, after some rapport has built",
};

// Renders the per-session rendition into the prompt block that follows the fixed
// core. Kept separate and deterministic so it can be reconstructed identically
// every turn and unit-tested without the network. Returns "" when nothing was
// selected, so a scenario with no pools produces byte-identical prompts to the
// pre-variation behavior.
export function buildPersonaVariantSection(selected: SelectedPersonaVariant): string {
  const lines: string[] = [];
  if (selected.personality) {
    lines.push(`- Your personality and communication style this time: ${selected.personality}`);
  }
  if (selected.motivation) {
    lines.push(`- What is most driving you this time: ${selected.motivation}`);
  }
  if (selected.objections.length > 0) {
    lines.push(
      "- Concerns that are on your mind this time. Raise them naturally, in your own words, at roughly the point noted, and ONLY if the consultant has not already put them to rest. Do not list them all at once, and do not invent extra ones:"
    );
    for (const obj of selected.objections) {
      lines.push(`  - ${obj.text} (bring this up ${POSITION_HINT[obj.position]})`);
    }
  }
  if (lines.length === 0) return "";
  return `This session's rendition of you (stay consistent with this for the WHOLE conversation):\n${lines.join("\n")}`;
}

// Parses a scenario's stored JSON pools into arrays, tolerating empty/malformed
// values (returns empty pools rather than throwing).
export function scenarioPersonaVariants(scenario: Scenario): ScenarioPersonaVariants {
  return {
    personalityVariants: parseStringArray(scenario.personalityVariants),
    motivationVariants: parseStringArray(scenario.motivationVariants),
    objectionPool: parseStringArray(scenario.objectionPool),
  };
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// The fixed persona core used for prompt construction. Falls back to the legacy
// freeform customerPersona for any scenario not yet migrated, so prompts always
// have a persona even before backfill runs.
export function personaCoreFor(scenario: Scenario): string {
  return scenario.personaCore && scenario.personaCore.trim().length > 0
    ? scenario.personaCore
    : scenario.customerPersona;
}

function isSelectedPersonaVariant(value: unknown): value is SelectedPersonaVariant {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.personality === "string" &&
    typeof v.motivation === "string" &&
    Array.isArray(v.objections)
  );
}

// Reconstructs the rendition for an EXISTING session. Prefers the resolved
// selection stored when the session started; if absent (a legacy/in-flight row)
// it re-derives one deterministically from the session id so the customer stays
// identical across that session's turns without a stored value.
export function resolveSessionVariant(
  scenario: Scenario,
  session: Pick<Session, "id" | "personaVariant">
): SelectedPersonaVariant {
  if (session.personaVariant) {
    try {
      const parsed = JSON.parse(session.personaVariant);
      if (isSelectedPersonaVariant(parsed)) return parsed;
    } catch {
      // fall through to deterministic re-derivation
    }
  }
  return selectPersonaVariant(scenarioPersonaVariants(scenario), seededRng(session.id || 1));
}

// The variant prompt block for an existing session (convenience for callers that
// only need the rendered text to feed into the prompt builders).
export function sessionVariantSection(
  scenario: Scenario,
  session: Pick<Session, "id" | "personaVariant">
): string {
  return buildPersonaVariantSection(resolveSessionVariant(scenario, session));
}
