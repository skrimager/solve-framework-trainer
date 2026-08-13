// Copy and routing for the post-free-session fork on the demo results screen.
// Kept out of the page component so the exact customer-facing wording is
// importable and unit-testable without a DOM: this repo has no React component
// test setup, and the wording here is contractual with the marketing site.

// Where "Become a Member" goes. The existing self-serve manager signup route
// (email capture, verify, office setup, then the existing Stripe seat checkout).
// No new signup flow and no new Stripe product are introduced for this fork.
export const MEMBER_SIGNUP_PATH = "/signup";

export const MEMBER_OPTION = {
  headline: "Become a Member",
  subhead: "Unlock the complete SOLVE experience.",
  buttonLabel: "Become a Member",
  badge: "Recommended",
  features: [
    "Up to 10 hours of practice sessions every month",
    "Full Manager Dashboard",
    "Team management",
    "Progress tracking",
    "Performance analytics",
    "Scenario library",
    "Upload real call recordings for AI coaching",
    "Upload call scripts for AI scoring and coaching",
    "Coaching history",
    "SOLVE Academy access",
    "Level progression",
    "Bronze, Silver, Gold, and Expert achievement awards",
    "Certifications",
    "Unlimited Message Coach, score and rewrite your outreach before you send it.",
    "Future platform updates",
  ],
} as const;

export const PAY_PER_SESSION_OPTION = {
  headline: "Purchase Individual Demo Sessions",
  // Display copy only. The charged amount is DEMO_SESSION_PRICE_CENTS in
  // server/demoPayments.ts; change both together.
  priceLine: "$4.99 per session",
  subhead:
    "Individual demo sessions are designed for users who simply want additional AI practice before becoming a member.",
  includesLabel: "Includes",
  includes: [
    "One AI practice session",
    "AI feedback",
    "Session scoring",
    "Conversation coaching",
  ],
  excludesLabel: "Does Not Include",
  excludes: [
    "Manager Dashboard",
    "Team management",
    "Progress tracking",
    "Performance analytics",
    "Uploading call recordings",
    "Uploading call scripts",
    "Coaching history",
    "SOLVE Academy",
    "Level progression",
    "Bronze/Silver/Gold/Expert awards",
    "Certifications",
    "Member-only content or features",
  ],
  disclaimer:
    "Individual demo sessions are intended for practice only. They do not include the SOLVE Academy, certifications, awards, dashboards, or the ability to upload your own conversations for coaching. To unlock the complete SOLVE experience, including member tools, recognition, and advanced coaching features, you'll need a SOLVE membership.",
  buttonLabel: "Continue Practicing - $4.99 per Session",
  // While the Checkout Session is being created, before the redirect.
  pendingLabel: "Taking you to checkout...",
  // The request failed and the button stays clickable.
  errorMessage: "We couldn't open checkout. Please try again.",
} as const;

// Shown on the welcome screen when the visitor comes back from a completed
// Stripe Checkout. A cancelled checkout is not a failure and says nothing.
export const PAID_RETURN_NOTICE = {
  headline: "Payment received.",
  body: "You have one practice session ready. Start it whenever you like.",
} as const;
