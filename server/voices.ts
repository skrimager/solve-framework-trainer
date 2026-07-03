// Maps each scenario's unique slug to an OpenAI TTS voice that fits the
// simulated customer's persona (gender/age/tone), so the voice heard in a
// role-play session matches the avatar shown on screen instead of a single
// generic voice for everyone.
//
// Available OpenAI TTS voices: alloy, ash, ballad, coral, echo, fable,
// nova, onyx, sage, shimmer.
export const PERSONA_VOICES: Record<string, string> = {
  // Manufactured housing — dealer
  "manufactured-housing-first-time-buyer": "nova", // Jamie, 29
  "manufactured-housing-retiree-downsizing": "shimmer", // Carol, 67
  "manufactured-housing-single-mom-relocation": "coral", // Renee, 34
  "manufactured-housing-investor-buyer": "onyx", // Deshawn, 45

  // Manufactured housing — community
  "manufactured-housing-community-lot-rent-sticker-shock": "shimmer", // Denise, 52
  "manufactured-housing-community-retiree-community-fit": "ash", // Walt, 71
  "manufactured-housing-community-existing-resident-renewal": "coral", // Marisol, 58
  "manufactured-housing-community-investor-bulk-lots": "onyx", // Frank, 49

  // Auto sales
  "auto-sales-tech-worker-upgrade": "echo", // Alex, 27 (male-leaning read)
  "auto-sales-growing-family-suv": "nova", // Priya, 31
  "auto-sales-skeptical-negotiator": "onyx", // Frank, 52
  "auto-sales-first-car-college-student": "coral", // Mia, 20

  // HVAC service
  "hvac-service-ac-out-in-summer": "shimmer", // Linda, 58
  "hvac-service-recurring-noise-complaint": "echo", // Marcus, 39
  "hvac-service-landlord-tenant-complaint": "onyx", // Tom, 47
  "hvac-service-elderly-fixed-income": "ash", // Dorothy, 74

  // HVAC sales
  "hvac-sales-old-system-failing": "onyx", // Greg, 44
  "hvac-sales-new-home-buyer": "nova", // Jordan & Sam (couple, lead voice)
  "hvac-sales-eco-conscious-upgrade": "coral", // Elena, 41
  "hvac-sales-competing-quotes": "echo", // Victor, 50

  // Plumbing
  "plumbing-service-slow-drain-annoyance": "echo", // Ben, 36
  "plumbing-service-water-heater-emergency": "shimmer", // Angela, 45
  "plumbing-service-diy-attempted-repair": "ash", // Kyle, 33
  "plumbing-service-renovation-timeline-pressure": "onyx", // Ray, 48

  // Financial advisor
  "financial-advisor-young-professional-starting": "ash", // Derek, 26
  "financial-advisor-pre-retiree-anxious": "shimmer", // Susan, 61
  "financial-advisor-inheritance-windfall": "coral", // Nadia, 52
  "financial-advisor-overconfident-diy-investor": "echo", // Wei, 38

  // Insurance
  "insurance-auto-price-shopper": "nova", // Michelle, 43
  "insurance-auto-new-driver-parent": "shimmer", // Patricia, 47
  "insurance-auto-post-accident-frustrated": "onyx", // Howard, 58
  "insurance-auto-bundling-opportunity": "coral", // Yasmin, 29

  // Real estate
  "real-estate-relocating-professional": "echo", // Derek, 38
  "real-estate-downsizing-empty-nesters": "shimmer", // Linda, 61
  "real-estate-first-time-buyer-anxious": "nova", // Priya, 27
  "real-estate-investor-multi-unit": "onyx", // Marcus, 52

  // Apartment rental
  "apartment-rental-recent-grad": "ash", // Alex, 22
  "apartment-rental-family-more-space": "coral", // Rosa, 33
  "apartment-rental-remote-worker-noise": "echo", // Jordan, 31
  "apartment-rental-pet-owner-restrictions": "onyx", // Sam, 35
};

const DEFAULT_VOICE = "alloy";

export function getVoiceForScenario(slug: string | undefined | null): string {
  if (!slug) return DEFAULT_VOICE;
  return PERSONA_VOICES[slug] ?? DEFAULT_VOICE;
}
