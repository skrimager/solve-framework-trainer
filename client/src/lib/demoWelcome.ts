// Copy for the welcome / instructions screen that sits between the industry
// choice and the roleplay. Kept out of the page component for the same reason as
// demoPaywall.ts: this repo has no React component test setup, and the exact
// wording is the first impression for visitors who arrive on a forwarded demo
// link having never seen the marketing site.

// The five SOLVE steps, rendered as a scannable list rather than a paragraph.
export const SOLVE_STEPS = [
  {
    letter: "S",
    label: "Situation",
    body: "Figure out what's really going on for this customer.",
  },
  {
    letter: "O",
    label: "Open with questions",
    body: "Lead with curiosity, not a pitch.",
  },
  {
    letter: "L",
    label: "Listen for the motivation",
    body: "What are they actually trying to accomplish? It's usually not what they first say.",
  },
  {
    letter: "V",
    label: "Visualize success",
    body: "Help them picture what a solved outcome looks like.",
  },
  {
    letter: "E",
    label: "Engineer the solution",
    body: "Build an answer around what you uncovered.",
  },
] as const;

// Shown before the one free session, and to anyone who has not just paid.
export const WELCOME_FIRST = {
  headline: "Before you start: here's how this works.",
  intro:
    "You're about to have a practice conversation with an AI customer. Your job isn't to close them. Your job is to understand them.",
  methodLead: "Use the SOLVE method:",
  goal:
    'Here\'s the goal: ask good enough questions that by the end, you\'ve engineered a real solution and the customer can see it working, so there are no objections left to overcome. You don\'t have to "close." If you did the discovery well, the close takes care of itself.',
  coach:
    "Miss a step and SOLVE Coach™ will show you exactly where. Nail them and you'll score high.",
  why:
    "Every conversation is different. The customer's motivation changes every time, so you can't memorize your way through it, you have to actually ask and actually listen. That's the point: it builds the habit of asking great questions and engineering great solutions, so you become the kind of consultant who earns more referrals and more deals with fewer objections to fight.",
  inputHeading: "Type or talk, your choice.",
  inputBody:
    "You can type your responses, or have a real spoken conversation. To talk instead of type, switch on Voice Mode in the top right corner, allow microphone access when your browser asks, and turn your sound up so you can hear the customer respond. Prefer to type? Just start typing, text mode is on by default.",
  buttonLabel: "Start the Conversation →",
  footnote: "Takes about 5 minutes. You'll get a score and coaching at the end.",
} as const;

// Shown before a purchased session. Short on purpose: they have done this once.
export const WELCOME_REPEAT = {
  headline: "Round two. New customer, new motivation.",
  body:
    "Same method: Situation, Open with questions, Listen for the motivation, Visualize success, Engineer the solution. Remember, this customer wants something different than the last one. Ask, listen, and engineer the solution so there's nothing left to object to. SOLVE Coach™ will score you and show you where to sharpen. (Want to talk instead of type? Switch on Voice Mode in the top right, allow your mic, and turn your sound up.)",
  buttonLabel: "Start the Conversation →",
} as const;

export type WelcomeVariant = "first" | "repeat";
