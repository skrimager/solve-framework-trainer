// Test-mode catalog helper for the locked pricing model. The catalog below is
// already provisioned in Stripe TEST MODE, so this script deliberately verifies
// and prints it rather than creating duplicate immutable Products or Prices.
import Stripe from "stripe";

const TEST_CATALOG = {
  seatProduct: "prod_V6F5OKmgs8hQhC",
  evaluationProduct: "prod_V6F68KNXauj7Rk",
  team: "price_1U62btE4KoeeCPKqiEKlX9ZS",
  office: "price_1U62buE4KoeeCPKqw3ch709K",
  company: "price_1U62buE4KoeeCPKqSr05RW4o",
  evaluationBase: "price_1U62c6E4KoeeCPKqlb0BDIkv",
  evaluationAdditional: "price_1U62c7E4KoeeCPKqDHrLm1K8",
} as const;

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key?.startsWith("sk_test_")) {
    throw new Error("Refusing to inspect the catalog without an explicit sk_test_ key.");
  }
  const stripe = new Stripe(key, { apiVersion: "2025-02-24.acacia" });
  const prices = [TEST_CATALOG.team, TEST_CATALOG.office, TEST_CATALOG.company, TEST_CATALOG.evaluationBase, TEST_CATALOG.evaluationAdditional];
  await Promise.all(prices.map((id) => stripe.prices.retrieve(id)));

  console.log("Verified existing Stripe TEST MODE pricing catalog. Add these IDs to the test environment:");
  console.log(`STRIPE_SEAT_TEAM_PRICE_ID=${TEST_CATALOG.team}`);
  console.log(`STRIPE_SEAT_OFFICE_PRICE_ID=${TEST_CATALOG.office}`);
  console.log(`STRIPE_SEAT_COMPANY_PRICE_ID=${TEST_CATALOG.company}`);
  console.log(`STRIPE_EVALUATION_BASE_PRICE_ID=${TEST_CATALOG.evaluationBase}`);
  console.log(`STRIPE_EVALUATION_ADDITIONAL_PARTICIPANT_PRICE_ID=${TEST_CATALOG.evaluationAdditional}`);
  console.log("Team is 1-5 at $129/person/month, Office is 6-15 at $115, and Company is 16-21 at $99.");
  console.log("14-Day Team Evaluation uses $249 for 3-5 participants plus $50 for each participant after five.");
  console.log("The hidden 1-2 participant rate is server-authored Checkout price_data; Enterprise has no self-serve price.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
