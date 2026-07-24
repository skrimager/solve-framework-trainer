// One-time setup for the SOLVE Pricing v2 (flat-per-tier) billing model. Creates
// the Stripe products and per-tier prices, then prints the price IDs to paste into
// your environment.
//
// Pricing v2 is flat-per-tier (NOT graduated): a consultant seat and the optional
// Manager Dashboard each have ONE flat monthly rate per plan tier. The app switches
// an office's seat/dashboard subscription items between these prices as its seat
// count moves tiers (see server/billing.ts). Enterprise (36+) is a custom quote —
// no self-serve Stripe price object is created for it.
//
//   Consultant Seat (monthly, flat per unit, one price per tier):
//     Team    (1–5)   $49/seat
//     Office  (6–20)  $45/seat
//     Company (21–35) $41/seat
//   Manager Dashboard (monthly flat, optional, one price per tier):
//     Team $249/mo   Office $389/mo   Company $529/mo
//   Annual-prepay Dashboard coupon (optional): 20% off the dashboard only, for 12
//     months. Percent-off (not a yearly price) so it tracks the current dashboard
//     rate and never touches seats.
//
// Run against TEST mode first:
//   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts
//
// Stripe prices are IMMUTABLE and this script has no natural upsert key, so each run
// creates NEW products/prices. Run once per environment and record the printed IDs.
// Do NOT delete old price objects — archive/deprecate the superseded ones in Stripe.
import Stripe from "stripe";

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is required (use a sk_test_... key first).");
    process.exit(1);
  }
  const stripe = new Stripe(key, { apiVersion: "2025-02-24.acacia" });

  // Per-seat monthly rates (in cents) by tier.
  const SEAT_TIERS = [
    { tier: "TEAM", label: "Team (1–5)", unit_amount: 4900 },
    { tier: "OFFICE", label: "Office (6–20)", unit_amount: 4500 },
    { tier: "COMPANY", label: "Company (21–35)", unit_amount: 4100 },
  ] as const;

  // Optional Manager Dashboard monthly fee (in cents) by tier.
  const DASHBOARD_TIERS = [
    { tier: "TEAM", label: "Team", unit_amount: 24900 },
    { tier: "OFFICE", label: "Office", unit_amount: 38900 },
    { tier: "COMPANY", label: "Company", unit_amount: 52900 },
  ] as const;

  console.log("Creating Consultant Seat product…");
  const seatProduct = await stripe.products.create({
    name: "Consultant Seat",
    description: "Per-consultant monthly practice seat. Flat-per-tier: all seats bill at the office's current plan tier rate.",
  });
  const seatPriceIds: Record<string, string> = {};
  for (const t of SEAT_TIERS) {
    const price = await stripe.prices.create({
      product: seatProduct.id,
      currency: "usd",
      unit_amount: t.unit_amount,
      recurring: { interval: "month" },
      nickname: `Consultant Seat — ${t.label} ($${(t.unit_amount / 100).toFixed(0)}/seat/mo)`,
    });
    seatPriceIds[t.tier] = price.id;
  }

  console.log("Creating Manager Dashboard product…");
  const dashboardProduct = await stripe.products.create({
    name: "Manager Dashboard",
    description: "Optional monthly manager dashboard (team oversight and practice tracking). Not required to practice; does not include a personal practice seat.",
  });
  const dashboardPriceIds: Record<string, string> = {};
  for (const t of DASHBOARD_TIERS) {
    const price = await stripe.prices.create({
      product: dashboardProduct.id,
      currency: "usd",
      unit_amount: t.unit_amount,
      recurring: { interval: "month" },
      nickname: `Manager Dashboard — ${t.label} ($${(t.unit_amount / 100).toFixed(0)}/mo)`,
    });
    dashboardPriceIds[t.tier] = price.id;
  }

  // Annual-prepay dashboard discount. A percent-off coupon (not a yearly Price) so
  // it (a) tracks whatever the current dashboard rate is — launch rate before Aug 1,
  // standard after — without needing new price objects, and (b) leaves seats on the
  // monthly plan (no mixed-interval subscription). Scoped to the Manager Dashboard
  // product via applies_to.products so it can ONLY ever reduce the dashboard line,
  // never a consultant seat. duration_in_months: 12 = one prepaid year, then it lapses
  // back to the undiscounted monthly dashboard rate.
  console.log("Creating annual-prepay Manager Dashboard coupon (20% off dashboard, 12 months)…");
  const annualCoupon = await stripe.coupons.create({
    percent_off: 20,
    duration: "repeating",
    duration_in_months: 12,
    applies_to: { products: [dashboardProduct.id] },
    name: "Annual Prepay — Manager Dashboard 20% off (12 months)",
  });

  console.log("\n✅ Stripe products/prices created. Add these to your environment:\n");
  console.log(`STRIPE_SEAT_TEAM_PRICE_ID=${seatPriceIds.TEAM}`);
  console.log(`STRIPE_SEAT_OFFICE_PRICE_ID=${seatPriceIds.OFFICE}`);
  console.log(`STRIPE_SEAT_COMPANY_PRICE_ID=${seatPriceIds.COMPANY}`);
  console.log(`STRIPE_DASHBOARD_TEAM_PRICE_ID=${dashboardPriceIds.TEAM}`);
  console.log(`STRIPE_DASHBOARD_OFFICE_PRICE_ID=${dashboardPriceIds.OFFICE}`);
  console.log(`STRIPE_DASHBOARD_COMPANY_PRICE_ID=${dashboardPriceIds.COMPANY}`);
  console.log(`STRIPE_DASHBOARD_ANNUAL_COUPON_ID=${annualCoupon.id}`);
  console.log("\nEnterprise (36+) is a custom quote — no self-serve price object is created.");
  console.log("Leave STRIPE_DASHBOARD_ANNUAL_COUPON_ID unset to hide the annual option entirely.");
  console.log("Also set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and APP_URL.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
