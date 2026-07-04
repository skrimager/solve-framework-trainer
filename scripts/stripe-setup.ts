// One-time setup: creates the two Stripe products and their prices for the SOLVE
// billing model, then prints the price IDs to paste into your environment.
//
//   Product 1 — "Manager Dashboard + User Portal": flat $189/year, quantity always 1.
//               Fully optional add-on — an office can subscribe to seats only.
//   Product 2 — "Consultant Seat": GRADUATED tiered pricing (like a tax bracket) —
//               seats 1–5 @ $29, 6–15 @ $26, 16–30 @ $23, 31+ @ $19. Each seat is
//               billed at the marginal rate for the band it falls into, so the total
//               increases monotonically with seat count (no volume-mode cliff).
//
// Run against TEST mode first:
//   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts
//
// Re-running creates NEW products/prices (Stripe has no natural upsert key here), so
// run once per environment and record the printed IDs.
import Stripe from "stripe";

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is required (use a sk_test_... key first).");
    process.exit(1);
  }
  const stripe = new Stripe(key, { apiVersion: "2025-02-24.acacia" });

  console.log("Creating Manager Dashboard product…");
  const managerProduct = await stripe.products.create({
    name: "Manager Dashboard + User Portal",
    description: "Annual access to the manager dashboard and user portal (one per office).",
  });
  const managerPrice = await stripe.prices.create({
    product: managerProduct.id,
    currency: "usd",
    unit_amount: 18900, // $189.00
    recurring: { interval: "year" },
    nickname: "Manager Dashboard (annual flat)",
  });

  console.log("Creating Consultant Seat product…");
  const seatProduct = await stripe.products.create({
    name: "Consultant Seat",
    description: "Per-consultant monthly training seat with graduated pricing.",
  });
  // Graduated tiers: `up_to` values are cumulative seat-count boundaries. Each seat
  // is charged the unit_amount of the band it falls into (marginal, like tax brackets).
  const seatPrice = await stripe.prices.create({
    product: seatProduct.id,
    currency: "usd",
    recurring: { interval: "month" },
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 5, unit_amount: 2900 }, // seats 1–5 @ $29 each
      { up_to: 15, unit_amount: 2600 }, // seats 6–15 @ $26 each
      { up_to: 30, unit_amount: 2300 }, // seats 16–30 @ $23 each
      { up_to: "inf", unit_amount: 1900 }, // seats 31+ @ $19 each
    ],
    nickname: "Consultant Seat (monthly, graduated tiered)",
  });

  console.log("\n✅ Stripe products/prices created. Add these to your environment:\n");
  console.log(`STRIPE_MANAGER_DASHBOARD_PRICE_ID=${managerPrice.id}`);
  console.log(`STRIPE_CONSULTANT_SEAT_PRICE_ID=${seatPrice.id}`);
  console.log("\nAlso set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and APP_URL.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
