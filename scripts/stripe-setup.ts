// One-time setup: creates the two Stripe products and their prices for the SOLVE
// billing model, then prints the price IDs to paste into your environment.
//
//   Product 1 — "Manager Dashboard + User Portal": flat $189/year, quantity always 1.
//   Product 2 — "Consultant Seat": $29/mo per seat for the first 5, $24/mo for 6–15,
//               $19/mo for 16+ — using volume tiered pricing (the whole quantity is
//               billed at the tier its total falls into).
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
    description: "Per-consultant monthly training seat with volume pricing.",
  });
  const seatPrice = await stripe.prices.create({
    product: seatProduct.id,
    currency: "usd",
    recurring: { interval: "month" },
    billing_scheme: "tiered",
    tiers_mode: "volume",
    tiers: [
      { up_to: 5, unit_amount: 2900 }, // $29/seat when total ≤ 5
      { up_to: 15, unit_amount: 2400 }, // $24/seat when total ≤ 15
      { up_to: "inf", unit_amount: 1900 }, // $19/seat when total ≥ 16
    ],
    nickname: "Consultant Seat (monthly, volume tiered)",
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
