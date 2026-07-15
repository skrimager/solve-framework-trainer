// Human-readable labels for scenario verticals, used by manager analytics views.
// Mirrors the map in pages/scenarios.tsx (kept separate to avoid coupling the
// consultant picker to the manager dashboard). Unknown verticals fall back to a
// title-cased version of the raw key so a new vertical never renders blank.
const VERTICAL_LABELS: Record<string, string> = {
  upset_customer_service: "Upset customer service",
  employee_grievance: "Employee grievance",
  peer_conflict: "Peer conflict",
  manufactured_housing_community: "Manufactured housing community",
  manufactured_housing: "Manufactured housing dealer",
  real_estate: "Real estate purchase / listing",
  apartment_rental: "Apartment rental",
  auto_sales: "Auto sales",
  hvac_service: "HVAC service call",
  hvac_sales: "HVAC new system sales call",
  plumbing: "Plumbing service call",
  home_improvement: "Home improvement projects",
  pool_landscaping: "Pool & landscaping",
  financial_advisor: "Financial advisor",
  insurance_auto: "Insurance",
  solar: "Solar",
  pest_control: "Pest control",
  roofing: "Roofing",
  saas: "SaaS",
};

export function verticalLabel(vertical: string): string {
  if (VERTICAL_LABELS[vertical]) return VERTICAL_LABELS[vertical];
  return vertical
    .split("_")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}
