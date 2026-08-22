// Customer-facing copy for the Message Coach page. Kept out of the component for
// the same reason demoPaywall.ts is: this repo has no React component test
// setup, and the exact wording is contractual with the marketing site, so it
// needs to be importable and unit-testable without a DOM.
//
// House voice standard: no em dashes and no en dashes anywhere in this file.
// There is a test that asserts it, because a dash slipping into shipped copy is
// the kind of thing nobody notices in review.

export const MESSAGE_COACH_PATH = "/message-coach";

export const MESSAGE_COACH_HEADER = {
  title: "SOLVE Message Coach",
  subtitle:
    "Paste a message you would send a prospect. Get it scored, diagnosed, and rewritten against the SOLVE rubric.",
} as const;

// Sits near the top of the page, above the input. Quoted from the spec, so treat
// changes here as a copy decision, not a code change.
export const POSITIONING_COPY =
  "ChatGPT can write you a nice, professional message. That's not the same thing. SOLVE rewrites your message against a published rubric, scores it, and shows you exactly why the rewrite gets responses instead of STOP replies. You're not just getting a better message, you're learning what makes messages work. Write them yourself once you've got it, or keep letting the system do it. Either way, you'll know why it works.";

export const INPUT_COPY = {
  messageLabel: "Your message",
  messagePlaceholder:
    "Paste your outreach message, a cold text, email, or DM you'd send to a prospect.",
  industryLabel: "Industry",
  industryHint: "Optional. It helps the rubric judge how specific your message really is.",
  nameLabel: "Name",
  namePlaceholder: "Your name",
  emailLabel: "Email",
  emailPlaceholder: "you@company.com",
  gateNote: "We'll show your score as soon as you tell us where to send it.",
  submitLabel: "Score my message",
  submitPendingLabel: "Scoring your message...",
  errorMessage: "We couldn't score that message. Please try again.",
} as const;

// The two-step email verification gate shown to anonymous visitors before the
// message/industry form unlocks. Members never see this (isMember bypass).
export const VERIFY_COPY = {
  emailHeading: "Where should we send your access code?",
  emailBody: "Enter your name and email and we'll send a 6-digit code to score your message.",
  sendButtonLabel: "Send my code",
  sendButtonPendingLabel: "Sending code...",
  codeHeading: "Enter your 6-digit code",
  codeBody: "We sent a code to",
  codeExpiry: "It expires in 10 minutes.",
  codeHint:
    "Check your email for your verification code. If it's not in your inbox, look in your spam or junk folder.",
  verifyButtonLabel: "Verify code",
  verifyButtonPendingLabel: "Verifying...",
  backLabel: "Use a different email",
  resendLabel: "Resend code",
  resendPendingLabel: "Resending...",
  resentNote: "A new code is on its way.",
} as const;

// The industry dropdown. Values are sent to the server verbatim and must match
// the enum in server/messageCoachRoutes.ts.
export const INDUSTRY_OPTIONS = [
  "Auto",
  "Real Estate",
  "Mortgage",
  "Home Services",
  "Other",
] as const;
export type MessageCoachIndustry = (typeof INDUSTRY_OPTIONS)[number];

export const RESULT_COPY = {
  scoreLabel: "Your score",
  scoreSuffix: "out of 100",
  stalledLabel: "Where it stalled",
  coachingLabel: "What's happening",
  rewriteLabel: "First touch",
  rewriteNote: "Send this first.",
  copyLabel: "Copy the first touch",
  copiedLabel: "Copied",
  followUpLabel: "Second touch, if they do not reply",
  followUpNote: "A low-pressure next step using an existing gated demo.",
  followUpCopyLabel: "Copy the second touch",
  followUpCopiedLabel: "Second touch copied",
  againLabel: "Score another message",
} as const;

export const PAYWALL_COPY = {
  headline: "You've used your free score.",
  // Display copy only. The charged amount is MESSAGE_COACH_PRICE_CENTS in
  // server/messageCoach.ts; change both together.
  priceLine: "$4.99 for this score",
  body: "One more score and rewrite for this message, scored against the same rubric.",
  buttonLabel: "Score this message for $4.99",
  pendingLabel: "Taking you to checkout...",
  errorMessage: "We couldn't open checkout. Please try again.",
} as const;

// Shown while the payment webhook is still landing after the Stripe redirect.
export const PAID_RETURN_COPY = {
  headline: "Payment received.",
  confirming: "Confirming your payment, this takes a few seconds.",
  restore:
    "Paste your message again if it isn't already here, then score it. Your purchase is waiting.",
} as const;

// The funnel footer under the result.
export const FUNNEL_COPY = {
  headline: "This is one message.",
  body: "Imagine every conversation your team has, scored and coached like this.",
  demoLabel: "Try the Free Practice Demo",
  demoPath: "/demo",
  pricingLabel: "See Pricing",
  pricingPath: "/signup",
} as const;

// Shown when MESSAGE_COACH_ENABLED is not "true" on the server, so the page is
// reachable but the feature is not live.
export const UNAVAILABLE_COPY = {
  headline: "Message Coach isn't available yet.",
  body: "This tool is still being finished. Check back shortly.",
} as const;
