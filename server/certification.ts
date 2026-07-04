// Certification exam engine: per-track question banks, random draw, and exact
// (deterministic) grading for multiple-choice / fill-in-the-blank questions.
// Free-text ("written") questions are graded by the LLM via an injected grader
// (see gradeWrittenAnswer in llm.ts) so this module itself stays pure and
// import-free of OpenAI, which keeps it trivially unit-testable.

export type Track = "consulting" | "leadership";
export type CertQuestionType = "multiple_choice" | "fill_blank" | "written";

export interface MultipleChoiceQuestion {
  id: string;
  track: Track;
  type: "multiple_choice";
  prompt: string;
  options: string[];
  answer: number; // index into options
}

export interface FillBlankQuestion {
  id: string;
  track: Track;
  type: "fill_blank";
  prompt: string;
  answer: string;
  acceptable?: string[]; // additional accepted normalized answers
}

export interface WrittenQuestion {
  id: string;
  track: Track;
  type: "written";
  prompt: string;
  rubric: string; // what a correct free-text answer must contain; handed to the LLM grader
}

export type CertQuestion = MultipleChoiceQuestion | FillBlankQuestion | WrittenQuestion;

// A question with all grading data stripped — the only shape ever sent to the client.
export type PublicCertQuestion =
  | { id: string; type: "multiple_choice"; prompt: string; options: string[] }
  | { id: string; type: "fill_blank"; prompt: string }
  | { id: string; type: "written"; prompt: string };

// 30 questions per attempt. Passing is 85% correct (>= 26/30) to match the 85
// threshold used everywhere else in the product.
export const EXAM_QUESTION_COUNT = 30;
export const WRITTEN_PASS_PERCENT = 85;
export const WRITTEN_PASS_CORRECT = Math.ceil((WRITTEN_PASS_PERCENT / 100) * EXAM_QUESTION_COUNT); // 26

// The two distinct named credentials, one per track.
export const TRACK_CREDENTIAL: Record<Track, string> = {
  consulting: "SOLVE Framework Certified",
  leadership: "SOLVE Conflict Management Certified",
};

// ---------------------------------------------------------------------------
// Consulting (SOLVE discovery) question bank
// ---------------------------------------------------------------------------
const CONSULTING_QUESTIONS: CertQuestion[] = [
  // ----- Multiple choice -----
  { id: "c-mc-1", track: "consulting", type: "multiple_choice", prompt: "In the 'drill vs. hole' distinction at the heart of SOLVE discovery, the 'hole' represents:", options: ["The specific product the customer asked for", "The customer's real underlying need or desired outcome", "The price the customer wants to pay", "The competitor's offer"], answer: 1 },
  { id: "c-mc-2", track: "consulting", type: "multiple_choice", prompt: "The best time to prevent an objection is:", options: ["After the customer raises it", "During the close", "Through deep discovery earlier in the conversation", "In a follow-up email"], answer: 2 },
  { id: "c-mc-3", track: "consulting", type: "multiple_choice", prompt: "A natural close, as SOLVE defines it, references:", options: ["A limited-time discount", "The customer's own words and stated needs", "The consultant's sales quota", "A scripted urgency tactic"], answer: 1 },
  { id: "c-mc-4", track: "consulting", type: "multiple_choice", prompt: "Which question is the strongest example of open discovery?", options: ["Do you want the premium package?", "Would you like to buy today?", "Walk me through what prompted you to start looking into this.", "Is $500 within your budget?"], answer: 2 },
  { id: "c-mc-5", track: "consulting", type: "multiple_choice", prompt: "Trust-building in SOLVE is best described as:", options: ["A tactic used only at the close", "A signal that stands independent of whether the deal closes", "Offering the lowest price", "Talking more than the customer"], answer: 1 },
  { id: "c-mc-6", track: "consulting", type: "multiple_choice", prompt: "A customer says 'I just need a quote for a new AC unit.' The most discovery-oriented response is:", options: ["Sure, the base model is $4,000.", "Before I quote it, help me understand what's been going on with your current system.", "Our units are the best on the market.", "Can you put down a deposit today?"], answer: 1 },
  { id: "c-mc-7", track: "consulting", type: "multiple_choice", prompt: "Relationship continuity means:", options: ["Ending the call as fast as possible", "Establishing a clear, low-pressure next step regardless of outcome", "Only following up with buyers", "Discounting to keep the customer"], answer: 1 },
  { id: "c-mc-8", track: "consulting", type: "multiple_choice", prompt: "Which is a sign the consultant jumped to a solution too early?", options: ["Recommending a product before understanding the real need", "Asking a follow-up question", "Summarizing the customer's concern", "Confirming budget after discovery"], answer: 0 },
  { id: "c-mc-9", track: "consulting", type: "multiple_choice", prompt: "Reflecting a customer's own words back to them primarily serves to:", options: ["Fill silence", "Demonstrate genuine listening and confirm understanding", "Speed up the close", "Avoid answering questions"], answer: 1 },
  { id: "c-mc-10", track: "consulting", type: "multiple_choice", prompt: "When a customer raises a price objection late in a well-run discovery, it often indicates:", options: ["Discovery surfaced the real need, so value can be tied to it", "The consultant should immediately discount", "Discovery was wasted", "The customer is not serious"], answer: 0 },
  { id: "c-mc-11", track: "consulting", type: "multiple_choice", prompt: "The FIRST goal when a customer opens with a specific request is to:", options: ["Confirm the sale", "Understand why they want it and what outcome they're after", "Quote a price", "Compare to a competitor"], answer: 1 },
  { id: "c-mc-12", track: "consulting", type: "multiple_choice", prompt: "Which behavior most undermines trust during discovery?", options: ["Patience and curiosity", "Interrupting to pitch a product", "Asking clarifying questions", "Summarizing needs"], answer: 1 },
  { id: "c-mc-13", track: "consulting", type: "multiple_choice", prompt: "A 'layered' discovery question is one that:", options: ["Repeats the same question", "Builds on the customer's previous answer to go deeper", "Asks for the sale", "Lists product features"], answer: 1 },
  { id: "c-mc-14", track: "consulting", type: "multiple_choice", prompt: "Discovery is best characterized as:", options: ["Persuasion", "Uncovering and understanding real needs", "Negotiation", "Presenting features"], answer: 1 },
  { id: "c-mc-15", track: "consulting", type: "multiple_choice", prompt: "Which is the strongest natural next step to preserve the relationship if the customer isn't ready to decide?", options: ["Pressure them to sign now", "Offer to send a tailored summary and check back at a time they choose", "End contact", "Add a surprise fee"], answer: 1 },
  { id: "c-mc-16", track: "consulting", type: "multiple_choice", prompt: "Objection PREVENTION differs from objection handling because it:", options: ["Happens reactively after the objection", "Addresses concerns before they surface via early discovery", "Requires discounting", "Ignores the objection"], answer: 1 },
  { id: "c-mc-17", track: "consulting", type: "multiple_choice", prompt: "A customer gives a surface request that hides a deeper worry about reliability. Good discovery should:", options: ["Quote the cheapest option", "Ask about their past experiences and what 'reliable' means to them", "Skip to the close", "Change the subject"], answer: 1 },
  { id: "c-mc-18", track: "consulting", type: "multiple_choice", prompt: "Which of these is NOT a SOLVE discovery dimension?", options: ["Needs discovery", "Objection prevention", "Aggressive urgency creation", "Relationship continuity"], answer: 2 },
  { id: "c-mc-19", track: "consulting", type: "multiple_choice", prompt: "The most useful thing to do with a long customer answer is:", options: ["Ignore the details", "Acknowledge and probe the most revealing part", "Immediately counter it", "Redirect to price"], answer: 1 },
  { id: "c-mc-20", track: "consulting", type: "multiple_choice", prompt: "Which opening keeps the consultant in discovery rather than pitching?", options: ["Here's why our product is best...", "Tell me more about what's driving this decision for you.", "We have a sale ending today.", "Can I get your signature?"], answer: 1 },
  { id: "c-mc-21", track: "consulting", type: "multiple_choice", prompt: "A close feels 'pressure-based' when it:", options: ["References the customer's stated needs", "Relies on urgency or fear rather than fit", "Follows thorough discovery", "Offers a genuine next step"], answer: 1 },
  { id: "c-mc-22", track: "consulting", type: "multiple_choice", prompt: "In discovery, silence after asking a question is best used to:", options: ["Fill immediately with a pitch", "Give the customer room to think and reveal more", "Signal impatience", "End the meeting"], answer: 1 },
  { id: "c-mc-23", track: "consulting", type: "multiple_choice", prompt: "Which indicates the real need was uncovered?", options: ["The customer repeats the original surface request verbatim", "The customer articulates an outcome they hadn't stated at the start", "The consultant lists all product specs", "The price is discussed first"], answer: 1 },
  { id: "c-mc-24", track: "consulting", type: "multiple_choice", prompt: "The purpose of confirming your understanding before recommending is to:", options: ["Delay the sale", "Ensure the recommendation is tied to the actual need and prevent objections", "Show off product knowledge", "Fill time"], answer: 1 },
  { id: "c-mc-25", track: "consulting", type: "multiple_choice", prompt: "A consultant who 'sells the hole, not the drill' focuses on:", options: ["The literal product requested", "The outcome the customer ultimately wants", "The highest-margin item", "The fastest close"], answer: 1 },
  { id: "c-mc-26", track: "consulting", type: "multiple_choice", prompt: "Which is the best response to 'I'm just looking'?", options: ["Okay, let me know if you need anything.", "No problem — what got you looking in the first place?", "You should buy now before prices rise.", "Here's our catalog."], answer: 1 },
  { id: "c-mc-27", track: "consulting", type: "multiple_choice", prompt: "Discovery questions should generally be phrased as:", options: ["Yes/no questions", "Open-ended questions", "Leading questions toward a product", "Rhetorical questions"], answer: 1 },
  { id: "c-mc-28", track: "consulting", type: "multiple_choice", prompt: "Tying a recommendation to the customer's own words primarily improves:", options: ["Talk time", "Perceived relevance and trust", "Discount size", "Call speed"], answer: 1 },
  { id: "c-mc-29", track: "consulting", type: "multiple_choice", prompt: "The healthiest measure of a good discovery session is:", options: ["Whether it closed immediately", "Whether the real need was understood and a fitting next step was set", "How many features were listed", "How fast it ended"], answer: 1 },
  { id: "c-mc-30", track: "consulting", type: "multiple_choice", prompt: "When the customer's stated request and real need conflict, the consultant should:", options: ["Follow the stated request blindly", "Surface the gap gently and align the recommendation to the real need", "Ignore the real need", "Push the pricier item"], answer: 1 },

  // ----- Fill in the blank -----
  { id: "c-fb-1", track: "consulting", type: "fill_blank", prompt: "In SOLVE, customers don't want a drill — they want the ______.", answer: "hole" },
  { id: "c-fb-2", track: "consulting", type: "fill_blank", prompt: "Deep, early ______ is what prevents objections before they arise.", answer: "discovery", acceptable: ["questions", "questioning"] },
  { id: "c-fb-3", track: "consulting", type: "fill_blank", prompt: "A natural close references the customer's own ______.", answer: "words", acceptable: ["needs"] },
  { id: "c-fb-4", track: "consulting", type: "fill_blank", prompt: "Open-ended questions typically begin with words like 'what', 'how', or '______'.", answer: "why" },
  { id: "c-fb-5", track: "consulting", type: "fill_blank", prompt: "Trust is a signal that should stand ______ of whether the deal closes.", answer: "independent", acceptable: ["independently"] },
  { id: "c-fb-6", track: "consulting", type: "fill_blank", prompt: "Establishing a low-pressure next step regardless of outcome is called relationship ______.", answer: "continuity" },
  { id: "c-fb-7", track: "consulting", type: "fill_blank", prompt: "Reflecting the customer's words back to confirm understanding is called ______ listening.", answer: "active", acceptable: ["reflective"] },
  { id: "c-fb-8", track: "consulting", type: "fill_blank", prompt: "The consultant should uncover the real need before proposing a ______.", answer: "solution", acceptable: ["recommendation", "product"] },
  { id: "c-fb-9", track: "consulting", type: "fill_blank", prompt: "Asking a follow-up that builds on a prior answer is a ______ question.", answer: "layered", acceptable: ["follow-up", "followup"] },
  { id: "c-fb-10", track: "consulting", type: "fill_blank", prompt: "A close driven by urgency or fear rather than fit is called ______-based.", answer: "pressure" },
  { id: "c-fb-11", track: "consulting", type: "fill_blank", prompt: "Discovery is about understanding needs, not ______ the customer.", answer: "persuading", acceptable: ["pressuring", "convincing"] },
  { id: "c-fb-12", track: "consulting", type: "fill_blank", prompt: "The stated request is often the 'drill'; the underlying outcome is the '______'.", answer: "hole" },
  { id: "c-fb-13", track: "consulting", type: "fill_blank", prompt: "Giving the customer ______ after a question lets them reveal more.", answer: "silence", acceptable: ["time", "space"] },
  { id: "c-fb-14", track: "consulting", type: "fill_blank", prompt: "A recommendation is strongest when it is ______ to the customer's stated need.", answer: "tied", acceptable: ["linked", "connected"] },
  { id: "c-fb-15", track: "consulting", type: "fill_blank", prompt: "The named credential for the consulting track is 'SOLVE Framework ______'.", answer: "certified" },
  { id: "c-fb-16", track: "consulting", type: "fill_blank", prompt: "Objection ______ addresses concerns before they surface.", answer: "prevention" },
  { id: "c-fb-17", track: "consulting", type: "fill_blank", prompt: "Curiosity and ______ are the core postures of good discovery.", answer: "patience", acceptable: ["listening"] },
  { id: "c-fb-18", track: "consulting", type: "fill_blank", prompt: "When stated request and real need conflict, align the recommendation to the real ______.", answer: "need" },
  { id: "c-fb-19", track: "consulting", type: "fill_blank", prompt: "The best discovery questions are ______-ended.", answer: "open" },
  { id: "c-fb-20", track: "consulting", type: "fill_blank", prompt: "A good session is measured by whether the real need was ______, not by how fast it closed.", answer: "understood", acceptable: ["uncovered", "discovered"] },

  // ----- Written / short answer -----
  { id: "c-wr-1", track: "consulting", type: "written", prompt: "Explain the 'drill vs. hole' concept in your own words and give an example.", rubric: "Answer must convey that customers state a request (the drill) but actually want an underlying outcome/need (the hole), and give a concrete example distinguishing the two." },
  { id: "c-wr-2", track: "consulting", type: "written", prompt: "A customer opens with 'Just give me your cheapest option.' Describe how you'd respond using discovery.", rubric: "Answer should avoid immediately quoting price, instead ask open questions to understand the customer's real situation/need and what 'cheapest' is protecting against, before recommending." },
  { id: "c-wr-3", track: "consulting", type: "written", prompt: "How does early discovery prevent objections later in the conversation?", rubric: "Answer should explain that uncovering real needs/concerns early lets the consultant address them proactively and tie value to the need, so objections don't arise or are pre-empted." },
  { id: "c-wr-4", track: "consulting", type: "written", prompt: "Describe what a 'natural close' looks like versus a pressure-based close.", rubric: "Answer should contrast a close that references the customer's own words/needs as a logical next step against one relying on urgency, fear, or pressure tactics." },
  { id: "c-wr-5", track: "consulting", type: "written", prompt: "Why should trust-building be independent of whether the sale closes?", rubric: "Answer should explain that genuine trust comes from curiosity, listening, and patience regardless of outcome, and that it preserves the relationship and future opportunities even without an immediate sale." },
  { id: "c-wr-6", track: "consulting", type: "written", prompt: "Give an example of a layered discovery question sequence for an HVAC customer.", rubric: "Answer should show at least two connected open questions where the second builds on the customer's answer to the first, going deeper into the real need." },
  { id: "c-wr-7", track: "consulting", type: "written", prompt: "What is relationship continuity and why does it matter even when a customer doesn't buy?", rubric: "Answer should define establishing a clear low-pressure next step/follow-up and explain it preserves the relationship and future business regardless of the immediate outcome." },
  { id: "c-wr-8", track: "consulting", type: "written", prompt: "A customer's stated request conflicts with what they actually need. How do you handle it?", rubric: "Answer should describe gently surfacing the gap, confirming understanding, and aligning the recommendation to the real underlying need rather than blindly following the surface request." },
  { id: "c-wr-9", track: "consulting", type: "written", prompt: "Explain why reflecting a customer's own words back to them is effective in discovery.", rubric: "Answer should explain it demonstrates active listening, confirms understanding, builds trust, and makes any later recommendation feel relevant to the customer." },
  { id: "c-wr-10", track: "consulting", type: "written", prompt: "Describe how you'd open a discovery conversation with a customer who says 'I'm just looking.'", rubric: "Answer should show a low-pressure, curious open-ended response that invites the customer to share what prompted their interest, without pushing a product or the close." },
  { id: "c-wr-11", track: "consulting", type: "written", prompt: "What distinguishes discovery from persuasion or traditional selling?", rubric: "Answer should explain discovery centers on understanding real needs through questions and listening, whereas persuasion/selling pushes a predetermined product or pressures the customer." },
  { id: "c-wr-12", track: "consulting", type: "written", prompt: "How can you tell you've actually uncovered the customer's real need?", rubric: "Answer should note signals such as the customer articulating an outcome not stated at the start, emotional buy-in, or being able to restate the need in the customer's own words and have them confirm it." },
  { id: "c-wr-13", track: "consulting", type: "written", prompt: "Why is jumping to a recommendation too early risky?", rubric: "Answer should explain it may address the wrong (surface) need, erode trust, and invite objections because the recommendation isn't grounded in the real need." },
  { id: "c-wr-14", track: "consulting", type: "written", prompt: "Describe the role of open-ended questions in SOLVE discovery.", rubric: "Answer should explain open-ended questions invite detailed responses, surface real needs and context, and keep the consultant in discovery rather than pitching." },
  { id: "c-wr-15", track: "consulting", type: "written", prompt: "A customer raises a price objection after strong discovery. How should you respond?", rubric: "Answer should tie value back to the real need uncovered in discovery and connect the recommendation to the customer's own stated outcomes rather than immediately discounting." },
  { id: "c-wr-16", track: "consulting", type: "written", prompt: "Explain how patience and silence function as discovery tools.", rubric: "Answer should explain that pausing after questions gives the customer room to think and reveal more, and that patience signals genuine interest and builds trust." },
];

// ---------------------------------------------------------------------------
// Leadership / Conflict-Management question bank
// ---------------------------------------------------------------------------
const LEADERSHIP_QUESTIONS: CertQuestion[] = [
  // ----- Multiple choice -----
  { id: "l-mc-1", track: "leadership", type: "multiple_choice", prompt: "The FIRST thing to do when someone is venting an emotional complaint is:", options: ["Immediately offer a solution", "Let them fully vent and feel heard before responding", "Defend the company", "Correct their facts"], answer: 1 },
  { id: "l-mc-2", track: "leadership", type: "multiple_choice", prompt: "Empathy acknowledgment means:", options: ["Agreeing you were wrong", "Naming and validating the person's feeling before problem-solving", "Apologizing repeatedly", "Changing the subject"], answer: 1 },
  { id: "l-mc-3", track: "leadership", type: "multiple_choice", prompt: "Root-cause discovery in conflict means:", options: ["Reacting only to the surface complaint", "Asking questions to uncover the real underlying issue", "Assigning blame", "Ending the conversation quickly"], answer: 1 },
  { id: "l-mc-4", track: "leadership", type: "multiple_choice", prompt: "A blameless resolution avoids blaming:", options: ["Only the customer", "Only the company", "Neither the person nor the company/coworker", "The manager only"], answer: 2 },
  { id: "l-mc-5", track: "leadership", type: "multiple_choice", prompt: "Solution visualization is best achieved by:", options: ["Imposing a fix unilaterally", "Co-creating what a good outcome looks like with the other party", "Offering a refund immediately", "Escalating to a supervisor"], answer: 1 },
  { id: "l-mc-6", track: "leadership", type: "multiple_choice", prompt: "Which phrase best acknowledges emotion?", options: ["Calm down.", "I can hear how frustrating this has been for you.", "That's not our fault.", "What do you want me to do about it?"], answer: 1 },
  { id: "l-mc-7", track: "leadership", type: "multiple_choice", prompt: "Interrupting an upset person to defend yourself usually:", options: ["De-escalates them", "Escalates the conflict and signals you aren't listening", "Builds trust", "Resolves the issue"], answer: 1 },
  { id: "l-mc-8", track: "leadership", type: "multiple_choice", prompt: "An employee grievance about workload is best opened with:", options: ["You need to work harder.", "Help me understand what's felt unmanageable lately.", "Everyone is busy.", "That's not my problem."], answer: 1 },
  { id: "l-mc-9", track: "leadership", type: "multiple_choice", prompt: "Active listening is demonstrated by:", options: ["Planning your rebuttal while they talk", "Letting them finish and reflecting back what you heard", "Checking your phone", "Talking over them"], answer: 1 },
  { id: "l-mc-10", track: "leadership", type: "multiple_choice", prompt: "In a peer conflict, a blameless framing sounds like:", options: ["You always drop the ball.", "Here's how the handoff broke down — how can we fix it together?", "This is your fault.", "I'm going to HR."], answer: 1 },
  { id: "l-mc-11", track: "leadership", type: "multiple_choice", prompt: "Jumping to a solution before acknowledging feelings often:", options: ["Makes the person feel unheard", "Resolves conflict fastest", "Builds empathy", "Is always correct"], answer: 0 },
  { id: "l-mc-12", track: "leadership", type: "multiple_choice", prompt: "The purpose of asking questions during a complaint is to:", options: ["Trap the person", "Uncover the real underlying issue behind the surface complaint", "Delay", "Prove them wrong"], answer: 1 },
  { id: "l-mc-13", track: "leadership", type: "multiple_choice", prompt: "Co-creating a resolution matters because:", options: ["It's faster than deciding alone", "The other party is more committed to a solution they helped shape", "It avoids responsibility", "It impresses your boss"], answer: 1 },
  { id: "l-mc-14", track: "leadership", type: "multiple_choice", prompt: "Which is a de-escalation behavior?", options: ["Raising your voice to match theirs", "Staying calm, slowing down, and validating the emotion", "Threatening consequences", "Walking away mid-sentence"], answer: 1 },
  { id: "l-mc-15", track: "leadership", type: "multiple_choice", prompt: "A customer is furious about a repeated billing error. The best first move is:", options: ["Explain the billing system", "Acknowledge the frustration and that it's happened repeatedly", "Blame the software vendor", "Ask them to call back"], answer: 1 },
  { id: "l-mc-16", track: "leadership", type: "multiple_choice", prompt: "Scapegoating a coworker to appease a customer is problematic because:", options: ["It resolves the issue", "It shifts blame rather than resolving the root cause and damages trust", "Customers prefer it", "It's blameless"], answer: 1 },
  { id: "l-mc-17", track: "leadership", type: "multiple_choice", prompt: "Reflecting back ('So what I'm hearing is...') primarily:", options: ["Wastes time", "Confirms understanding and shows the person they were heard", "Ends the conversation", "Assigns blame"], answer: 1 },
  { id: "l-mc-18", track: "leadership", type: "multiple_choice", prompt: "Which is NOT a leadership/conflict rubric dimension?", options: ["Active listening", "Empathy acknowledgment", "Aggressive rebuttal", "Blameless resolution"], answer: 2 },
  { id: "l-mc-19", track: "leadership", type: "multiple_choice", prompt: "When an employee feels unheard, the most effective response is to:", options: ["Restate policy", "Slow down, let them fully explain, and validate the feeling", "Offer a raise", "Redirect to email"], answer: 1 },
  { id: "l-mc-20", track: "leadership", type: "multiple_choice", prompt: "A good resolution to a conflict should feel:", options: ["Imposed by the manager", "Mutually agreed and co-created", "One-sided", "Rushed"], answer: 1 },
  { id: "l-mc-21", track: "leadership", type: "multiple_choice", prompt: "Naming an emotion precisely ('you sound worried, not just annoyed') helps because:", options: ["It corrects the person", "It shows deep listening and helps the person feel understood", "It delays resolution", "It assigns blame"], answer: 1 },
  { id: "l-mc-22", track: "leadership", type: "multiple_choice", prompt: "Which response best avoids blame in a peer conflict?", options: ["You never communicate.", "I think we both had different assumptions about the deadline.", "It's entirely on you.", "Talk to my manager."], answer: 1 },
  { id: "l-mc-23", track: "leadership", type: "multiple_choice", prompt: "Defensiveness during de-escalation typically signals to the other party that:", options: ["You care about them", "You're protecting yourself rather than understanding them", "The issue is resolved", "You're listening"], answer: 1 },
  { id: "l-mc-24", track: "leadership", type: "multiple_choice", prompt: "The goal of root-cause discovery is to:", options: ["Win the argument", "Fix the real problem so it doesn't recur", "Close the ticket fast", "Assign fault"], answer: 1 },
  { id: "l-mc-25", track: "leadership", type: "multiple_choice", prompt: "Which best keeps a hostile customer engaged toward resolution?", options: ["Matching their hostility", "Calm validation plus a genuine question about what outcome would help", "Silence", "Transferring the call"], answer: 1 },
  { id: "l-mc-26", track: "leadership", type: "multiple_choice", prompt: "Letting someone 'fully vent' is valuable because:", options: ["It tires them out", "It lets them feel heard and lowers emotional intensity before problem-solving", "It wastes their time", "It proves them wrong"], answer: 1 },
  { id: "l-mc-27", track: "leadership", type: "multiple_choice", prompt: "The difference between sympathy and empathy in conflict is that empathy:", options: ["Feels sorry from a distance", "Acknowledges and connects with the person's actual feeling", "Ignores emotion", "Offers a discount"], answer: 1 },
  { id: "l-mc-28", track: "leadership", type: "multiple_choice", prompt: "A resolution that blames 'the system' but not any person is:", options: ["Fully blameless", "Still risky if it dodges accountability and doesn't fix the root cause", "Always ideal", "Empathetic by default"], answer: 1 },
  { id: "l-mc-29", track: "leadership", type: "multiple_choice", prompt: "When two team members disagree, a manager mediating should first:", options: ["Pick a side", "Let each person feel heard and surface the underlying interests", "Impose a decision", "End the meeting"], answer: 1 },
  { id: "l-mc-30", track: "leadership", type: "multiple_choice", prompt: "The healthiest measure of handling a conflict well is:", options: ["How fast it ended", "Whether the person felt heard, the root cause surfaced, and a blameless resolution was co-created", "Whether you won", "How many policies you cited"], answer: 1 },

  // ----- Fill in the blank -----
  { id: "l-fb-1", track: "leadership", type: "fill_blank", prompt: "Before problem-solving, you should name and ______ the person's feeling.", answer: "validate", acceptable: ["acknowledge"] },
  { id: "l-fb-2", track: "leadership", type: "fill_blank", prompt: "Letting a person fully ______ before responding is core to active listening.", answer: "vent", acceptable: ["speak", "explain"] },
  { id: "l-fb-3", track: "leadership", type: "fill_blank", prompt: "A resolution that blames no one is called ______.", answer: "blameless" },
  { id: "l-fb-4", track: "leadership", type: "fill_blank", prompt: "Asking questions to find the issue behind the surface complaint is ______-cause discovery.", answer: "root" },
  { id: "l-fb-5", track: "leadership", type: "fill_blank", prompt: "Co-creating the outcome WITH the other party is called solution ______.", answer: "visualization" },
  { id: "l-fb-6", track: "leadership", type: "fill_blank", prompt: "Interrupting and defending yourself tends to ______ the conflict.", answer: "escalate" },
  { id: "l-fb-7", track: "leadership", type: "fill_blank", prompt: "Reflecting back what you heard confirms ______.", answer: "understanding" },
  { id: "l-fb-8", track: "leadership", type: "fill_blank", prompt: "The named credential for the leadership track is 'SOLVE Conflict Management ______'.", answer: "certified" },
  { id: "l-fb-9", track: "leadership", type: "fill_blank", prompt: "Empathy ______ the emotion; sympathy only feels sorry from a distance.", answer: "connects", acceptable: ["acknowledges", "names"] },
  { id: "l-fb-10", track: "leadership", type: "fill_blank", prompt: "A resolution should feel mutually ______ rather than imposed.", answer: "agreed", acceptable: ["agreed-upon", "co-created"] },
  { id: "l-fb-11", track: "leadership", type: "fill_blank", prompt: "Staying ______ when someone is hostile is a key de-escalation skill.", answer: "calm" },
  { id: "l-fb-12", track: "leadership", type: "fill_blank", prompt: "Shifting blame to a coworker to appease a customer is called ______.", answer: "scapegoating", acceptable: ["blame-shifting"] },
  { id: "l-fb-13", track: "leadership", type: "fill_blank", prompt: "Jumping to a ______ before acknowledging feelings makes people feel unheard.", answer: "solution", acceptable: ["fix"] },
  { id: "l-fb-14", track: "leadership", type: "fill_blank", prompt: "Naming an emotion ______ ('you sound worried') shows deep listening.", answer: "precisely", acceptable: ["accurately"] },
  { id: "l-fb-15", track: "leadership", type: "fill_blank", prompt: "The four steps roughly go: listen, acknowledge, discover the root cause, and ______ a resolution.", answer: "co-create", acceptable: ["create", "reach"] },
  { id: "l-fb-16", track: "leadership", type: "fill_blank", prompt: "Letting someone vent lowers the emotional ______ before problem-solving.", answer: "intensity", acceptable: ["temperature"] },
  { id: "l-fb-17", track: "leadership", type: "fill_blank", prompt: "Defensiveness signals you are protecting ______ rather than understanding the person.", answer: "yourself" },
  { id: "l-fb-18", track: "leadership", type: "fill_blank", prompt: "A person is more committed to a solution they helped ______.", answer: "shape", acceptable: ["create", "design"] },
  { id: "l-fb-19", track: "leadership", type: "fill_blank", prompt: "The surface complaint often hides the real ______.", answer: "issue", acceptable: ["problem", "cause"] },
  { id: "l-fb-20", track: "leadership", type: "fill_blank", prompt: "Good conflict handling is measured by whether the person felt ______.", answer: "heard", acceptable: ["understood"] },

  // ----- Written / short answer -----
  { id: "l-wr-1", track: "leadership", type: "written", prompt: "Describe the sequence you'd follow to de-escalate an upset customer.", rubric: "Answer should include letting them vent/feel heard, acknowledging and validating the emotion, asking questions to find the root cause, and co-creating a blameless resolution." },
  { id: "l-wr-2", track: "leadership", type: "written", prompt: "Why is acknowledging emotion before offering a solution so important?", rubric: "Answer should explain that people need to feel heard first; jumping to solutions makes them feel dismissed and escalates conflict, while acknowledgment lowers intensity and builds trust." },
  { id: "l-wr-3", track: "leadership", type: "written", prompt: "Explain what a 'blameless resolution' is and why it matters.", rubric: "Answer should define resolving the issue without blaming the customer/employee/peer or scapegoating the company/coworker, and explain it preserves relationships and focuses on fixing the real problem." },
  { id: "l-wr-4", track: "leadership", type: "written", prompt: "An employee complains their workload is unfair. How do you open the conversation?", rubric: "Answer should show active listening and an open, non-defensive invitation to understand their experience, validating the feeling before problem-solving or citing policy." },
  { id: "l-wr-5", track: "leadership", type: "written", prompt: "What does 'co-creating' a solution look like in a peer conflict?", rubric: "Answer should describe involving both parties in shaping the outcome, surfacing each side's interests, and reaching a mutually agreed resolution rather than one imposed." },
  { id: "l-wr-6", track: "leadership", type: "written", prompt: "Give an example of naming an emotion precisely and explain its effect.", rubric: "Answer should give a concrete empathetic statement that names a specific feeling and explain it makes the person feel deeply understood and de-escalates." },
  { id: "l-wr-7", track: "leadership", type: "written", prompt: "How do you find the root cause behind a surface complaint?", rubric: "Answer should describe asking open follow-up questions, listening for what's underneath the stated complaint, and confirming the underlying issue before solving." },
  { id: "l-wr-8", track: "leadership", type: "written", prompt: "Why does interrupting or getting defensive escalate a conflict?", rubric: "Answer should explain it signals you aren't listening, invalidates the person's experience, and intensifies emotion rather than lowering it." },
  { id: "l-wr-9", track: "leadership", type: "written", prompt: "A customer wants you to blame a coworker for a mistake. How do you respond without scapegoating?", rubric: "Answer should describe acknowledging the customer's frustration and owning the resolution without blaming the coworker or the company, focusing on fixing the issue and root cause." },
  { id: "l-wr-10", track: "leadership", type: "written", prompt: "Describe how active listening differs from just waiting for your turn to talk.", rubric: "Answer should explain active listening involves fully attending, not planning a rebuttal, and reflecting back to confirm understanding, versus merely waiting to speak." },
  { id: "l-wr-11", track: "leadership", type: "written", prompt: "How would you handle two team members who each blame the other for a missed deadline?", rubric: "Answer should describe letting each feel heard, avoiding taking sides, surfacing the underlying breakdown blamelessly, and co-creating a fix together." },
  { id: "l-wr-12", track: "leadership", type: "written", prompt: "What signals tell you a conflict conversation is going well?", rubric: "Answer should mention the person's emotional intensity lowering, feeling heard, the root cause surfacing, and movement toward a mutually agreed resolution." },
  { id: "l-wr-13", track: "leadership", type: "written", prompt: "Explain the difference between empathy and sympathy in a conflict context.", rubric: "Answer should distinguish empathy (connecting with and acknowledging the person's actual feeling) from sympathy (feeling sorry from a distance) and note why empathy is more effective." },
  { id: "l-wr-14", track: "leadership", type: "written", prompt: "A resolution that blames 'the system' can still be problematic. Why?", rubric: "Answer should explain that blaming the system can dodge accountability and fail to fix the real root cause, and that a genuine blameless resolution still addresses the underlying problem." },
  { id: "l-wr-15", track: "leadership", type: "written", prompt: "How do you keep a hostile customer engaged toward a resolution?", rubric: "Answer should describe staying calm, validating the emotion, not matching hostility, and asking what outcome would help so the customer participates in the solution." },
  { id: "l-wr-16", track: "leadership", type: "written", prompt: "Why is it important to let someone fully vent before responding?", rubric: "Answer should explain that venting lets the person feel heard and lowers emotional intensity, making them more receptive to problem-solving." },
];

const BANKS: Record<Track, CertQuestion[]> = {
  consulting: CONSULTING_QUESTIONS,
  leadership: LEADERSHIP_QUESTIONS,
};

export function normalizeTrack(track: string | null | undefined): Track {
  return track === "leadership" ? "leadership" : "consulting";
}

export function questionBank(track: Track): CertQuestion[] {
  return BANKS[track];
}

export function questionBankSize(track: Track): number {
  return BANKS[track].length;
}

// Fisher–Yates shuffle using an injectable RNG (defaults to Math.random) so a
// test can draw a deterministic set. Does not mutate the input.
export function drawExam(track: Track, count = EXAM_QUESTION_COUNT, rng: () => number = Math.random): string[] {
  const ids = BANKS[track].map((q) => q.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(count, ids.length));
}

const byId = new Map<string, CertQuestion>(
  [...CONSULTING_QUESTIONS, ...LEADERSHIP_QUESTIONS].map((q) => [q.id, q]),
);

export function getQuestion(id: string): CertQuestion | undefined {
  return byId.get(id);
}

export function getQuestions(ids: string[]): CertQuestion[] {
  return ids.map((id) => byId.get(id)).filter((q): q is CertQuestion => !!q);
}

// Strip all grading data (correct answers, rubrics) before sending to the client.
export function toPublicQuestion(q: CertQuestion): PublicCertQuestion {
  if (q.type === "multiple_choice") {
    return { id: q.id, type: q.type, prompt: q.prompt, options: q.options };
  }
  return { id: q.id, type: q.type, prompt: q.prompt };
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

// Deterministic grading for the two exact types. Multiple-choice compares the
// submitted option index; fill-in-the-blank normalizes text and accepts any of
// the acceptable variants. Returns false for a written question (those must go
// through the LLM grader) and for unparseable answers.
export function gradeExact(question: CertQuestion, answer: unknown): boolean {
  if (question.type === "multiple_choice") {
    const idx = typeof answer === "number" ? answer : Number(answer);
    return Number.isInteger(idx) && idx === question.answer;
  }
  if (question.type === "fill_blank") {
    if (typeof answer !== "string") return false;
    const norm = normalizeText(answer);
    if (!norm) return false;
    const accepted = [question.answer, ...(question.acceptable ?? [])].map(normalizeText);
    return accepted.includes(norm);
  }
  return false;
}

export interface WrittenExamResult {
  correct: number;
  total: number;
  percent: number;
  passed: boolean;
  perQuestion: { id: string; type: CertQuestionType; correct: boolean }[];
}

// Grades a whole written exam. Exact types are graded deterministically here;
// each "written" question is delegated to the injected async `gradeWritten`
// (backed by the LLM in production). Answers is a map of questionId -> value.
export async function gradeWrittenExam(
  questionIds: string[],
  answers: Record<string, unknown>,
  gradeWritten: (question: WrittenQuestion, answer: string) => Promise<boolean>,
): Promise<WrittenExamResult> {
  const questions = getQuestions(questionIds);
  const perQuestion: { id: string; type: CertQuestionType; correct: boolean }[] = [];
  for (const q of questions) {
    let correct: boolean;
    if (q.type === "written") {
      const raw = answers[q.id];
      correct = await gradeWritten(q, typeof raw === "string" ? raw : "");
    } else {
      correct = gradeExact(q, answers[q.id]);
    }
    perQuestion.push({ id: q.id, type: q.type, correct });
  }
  const correct = perQuestion.filter((r) => r.correct).length;
  const total = questions.length;
  const percent = total === 0 ? 0 : Math.round((correct / total) * 100);
  const passed = correct >= WRITTEN_PASS_CORRECT;
  return { correct, total, percent, passed, perQuestion };
}
