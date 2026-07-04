// Maps each scenario's unique slug to a generated persona portrait so the
// roleplay session shows a face instead of a blank panel. Client-side only —
// no database schema change needed. Images live in client/public/avatars/
// and are served as static files, named exactly `${slug}.jpg`.
//
// This is a plain filename list (not import.meta.glob) so the images stay as
// static public assets instead of being pulled into the JS bundle.
const AVATAR_SLUGS = new Set([
  "manufactured-housing-first-time-buyer",
  "manufactured-housing-retiree-downsizing",
  "manufactured-housing-single-mom-relocation",
  "manufactured-housing-investor-buyer",
  "manufactured-housing-community-lot-rent-sticker-shock",
  "manufactured-housing-community-retiree-community-fit",
  "manufactured-housing-community-existing-resident-renewal",
  "manufactured-housing-community-investor-bulk-lots",
  "auto-sales-tech-worker-upgrade",
  "auto-sales-growing-family-suv",
  "auto-sales-skeptical-negotiator",
  "auto-sales-first-car-college-student",
  "auto-sales-cross-shopper-competing-offers",
  "hvac-service-ac-out-in-summer",
  "hvac-service-recurring-noise-complaint",
  "hvac-service-landlord-tenant-complaint",
  "hvac-service-elderly-fixed-income",
  "hvac-sales-old-system-failing",
  "hvac-sales-new-home-buyer",
  "hvac-sales-eco-conscious-upgrade",
  "hvac-sales-competing-quotes",
  "plumbing-service-slow-drain-annoyance",
  "plumbing-service-water-heater-emergency",
  "plumbing-service-diy-attempted-repair",
  "plumbing-service-renovation-timeline-pressure",
  "financial-advisor-young-professional-starting",
  "financial-advisor-pre-retiree-anxious",
  "financial-advisor-inheritance-windfall",
  "financial-advisor-overconfident-diy-investor",
  "insurance-auto-price-shopper",
  "insurance-auto-new-driver-parent",
  "insurance-auto-post-accident-frustrated",
  "insurance-auto-bundling-opportunity",
  "real-estate-relocating-professional",
  "real-estate-downsizing-empty-nesters",
  "real-estate-first-time-buyer-anxious",
  "real-estate-investor-multi-unit",
  "apartment-rental-recent-grad",
  "apartment-rental-family-more-space",
  "apartment-rental-remote-worker-noise",
  "apartment-rental-pet-owner-restrictions",
  "apartment-rental-competitor-anchored-negotiator",
]);

export function getAvatarUrl(slug: string | undefined | null): string | null {
  if (!slug) return null;
  if (!AVATAR_SLUGS.has(slug)) return null;
  return `/avatars/${slug}.jpg`;
}
