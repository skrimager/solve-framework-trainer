// Maps each scenario's unique slug to an OpenAI TTS voice that fits the
// simulated customer's persona (gender/age/tone), so the voice heard in a
// role-play session matches the avatar shown on screen instead of a single
// generic voice for everyone.
//
// The scenario's `gender` field (see shared/schema.ts) is the single source of
// truth: it must match the persona's avatar image, and it deterministically
// gates which voice can be used. The curated per-slug map below only supplies
// the age/tone-appropriate *shade* of voice — it can never override gender.
// If a curated voice ever disagrees with the scenario's gender, we ignore it
// and fall back to a deterministic same-gender voice, so a wrong-gender voice
// for the shown face is structurally impossible.
//
// Available OpenAI TTS voices: alloy, ash, ballad, coral, echo, fable,
// nova, onyx, sage, shimmer.

// Gendered voice pools. Every voice actually used is drawn from one of these,
// which is what makes gender authoritative over the heard voice.
const FEMALE_VOICES = ["nova", "shimmer", "coral", "sage"] as const;
const MALE_VOICES = ["onyx", "echo", "ash", "ballad"] as const;

const VOICE_GENDER: Record<string, "male" | "female"> = {
  ...Object.fromEntries(FEMALE_VOICES.map((v) => [v, "female" as const])),
  ...Object.fromEntries(MALE_VOICES.map((v) => [v, "male" as const])),
};

// Curated age/tone-appropriate voice per persona. Must agree with the
// scenario's `gender`; entries are gender-validated at call time.
export const PERSONA_VOICES: Record<string, string> = {
  // Manufactured housing — dealer
  "manufactured-housing-first-time-buyer": "nova", // Jamie, 29 (f)
  "manufactured-housing-retiree-downsizing": "shimmer", // Carol, 67 (f)
  "manufactured-housing-single-mom-relocation": "coral", // Renee, 34 (f)
  "manufactured-housing-investor-buyer": "onyx", // Deshawn, 45 (m)

  // Manufactured housing — community
  "manufactured-housing-community-lot-rent-sticker-shock": "shimmer", // Denise, 52 (f)
  "manufactured-housing-community-retiree-community-fit": "ash", // Walt, 71 (m)
  "manufactured-housing-community-existing-resident-renewal": "coral", // Marisol, 58 (f)
  "manufactured-housing-community-investor-bulk-lots": "onyx", // Frank, 49 (m)

  // Auto sales
  "auto-sales-tech-worker-upgrade": "echo", // Alex, 27 (m)
  "auto-sales-growing-family-suv": "nova", // Priya, 31 (f)
  "auto-sales-skeptical-negotiator": "onyx", // Frank, 52 (m)
  "auto-sales-first-car-college-student": "coral", // Mia, 20 (f)

  // HVAC service
  "hvac-service-ac-out-in-summer": "shimmer", // Linda, 58 (f)
  "hvac-service-recurring-noise-complaint": "echo", // Marcus, 39 (m)
  "hvac-service-landlord-tenant-complaint": "onyx", // Tom, 47 (m)
  "hvac-service-elderly-fixed-income": "shimmer", // Dorothy, 74 (f) — was "ash" (male), corrected

  // HVAC sales
  "hvac-sales-old-system-failing": "onyx", // Greg, 44 (m)
  "hvac-sales-new-home-buyer": "nova", // Jordan & Sam (couple) — woman is the lead/speaking contact in the avatar (f)
  "hvac-sales-eco-conscious-upgrade": "coral", // Elena, 41 (f)
  "hvac-sales-competing-quotes": "echo", // Victor, 50 (m)

  // Plumbing
  "plumbing-service-slow-drain-annoyance": "echo", // Ben, 36 (m)
  "plumbing-service-water-heater-emergency": "shimmer", // Angela, 45 (f)
  "plumbing-service-diy-attempted-repair": "ash", // Kyle, 33 (m)
  "plumbing-service-renovation-timeline-pressure": "onyx", // Ray, 48 (m)

  // Financial advisor
  "financial-advisor-young-professional-starting": "ash", // Derek, 26 (m)
  "financial-advisor-pre-retiree-anxious": "shimmer", // Susan, 61 (f)
  "financial-advisor-inheritance-windfall": "coral", // Nadia, 52 (f)
  "financial-advisor-overconfident-diy-investor": "echo", // Wei, 38 (m)

  // Insurance
  "insurance-auto-price-shopper": "nova", // Michelle, 43 (f)
  "insurance-auto-new-driver-parent": "shimmer", // Patricia, 47 (f)
  "insurance-auto-post-accident-frustrated": "onyx", // Howard, 58 (m)
  "insurance-auto-bundling-opportunity": "coral", // Yasmin, 29 (f)

  // Real estate
  "real-estate-relocating-professional": "echo", // Derek, 38 (m)
  "real-estate-downsizing-empty-nesters": "shimmer", // Linda, 61 (f)
  "real-estate-first-time-buyer-anxious": "nova", // Priya, 27 (f)
  "real-estate-investor-multi-unit": "onyx", // Marcus, 52 (m)

  // Apartment rental
  "apartment-rental-recent-grad": "nova", // Alex, 22 (f) — was "ash" (male), corrected
  "apartment-rental-family-more-space": "coral", // Rosa, 33 (f)
  "apartment-rental-remote-worker-noise": "echo", // Jordan, 31 (m)
  "apartment-rental-pet-owner-restrictions": "coral", // Sam, 35 (f) — was "onyx" (male), corrected

  // Leadership — upset customer service
  "upset-customer-late-delivery-refund": "coral", // Dana, 38 (f)
  "upset-customer-damaged-item-replacement": "echo", // Marcus, 44 (m)
  "upset-customer-repeat-failure-review-threat": "nova", // Priya, 41 (f)
  "upset-customer-billing-overcharge-dispute": "onyx", // Terrence, 50 (m)
  "upset-customer-demand-manager-legal-chargeback": "ash", // Victor, 55 (m)
  "upset-customer-feels-lied-to-cancellation": "shimmer", // Aisha, 47 (f)

  // Leadership — employee grievance
  "employee-grievance-schedule-change-upset": "ash", // Kevin, 33 (m)
  "employee-grievance-pto-denied-frustration": "coral", // Renee, 29 (f)
  "employee-grievance-passed-over-promotion-defensive": "echo", // Brandon, 36 (m)
  "employee-grievance-workload-burnout-complaint": "nova", // Sophia, 34 (f)
  "employee-grievance-unfair-treatment-hr-sensitive": "shimmer", // Nia, 40 (f)
  "employee-grievance-favoritism-discrimination-allegation": "onyx", // Darius, 43 (m)

  // Leadership — peer conflict
  "peer-conflict-shared-account-approach": "nova", // Hannah, 31 (f)
  "peer-conflict-desk-space-noise-friction": "echo", // Tyler, 28 (m)
  "peer-conflict-cross-department-missed-deadline-blame": "ash", // Raj, 39 (m)
  "peer-conflict-credit-stealing-project": "coral", // Elena, 35 (f)
  "peer-conflict-long-running-team-morale-mediation": "shimmer", // Monica, 45 (f)
  "peer-conflict-senior-junior-power-struggle": "onyx", // Greg, 52 (m)
};

const DEFAULT_FEMALE_VOICE = "shimmer";
const DEFAULT_MALE_VOICE = "onyx";

// Stable non-negative hash of a string, so the same slug always maps to the
// same fallback voice (deterministic — no per-session randomization).
function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Returns a TTS voice guaranteed to match `gender`. Uses the curated per-slug
// voice when it agrees with gender; otherwise deterministically picks a
// same-gender voice from the pool. Gender is authoritative — the returned
// voice can never be the wrong gender for the persona's avatar.
export function getVoiceForScenario(
  slug: string | undefined | null,
  gender: string | undefined | null,
): string {
  const g: "male" | "female" = gender === "male" ? "male" : "female";
  const pool = g === "male" ? MALE_VOICES : FEMALE_VOICES;

  const curated = slug ? PERSONA_VOICES[slug] : undefined;
  if (curated && VOICE_GENDER[curated] === g) return curated;

  if (!slug) return g === "male" ? DEFAULT_MALE_VOICE : DEFAULT_FEMALE_VOICE;
  return pool[stableHash(slug) % pool.length];
}
