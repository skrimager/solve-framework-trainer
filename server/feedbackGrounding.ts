// Deterministic, transcript-derived grounding for the TIMING claims the Coach and
// the scoring rubric are allowed to make ("you should have brought budget up
// earlier in the conversation").
//
// The live failure this exists for: the feedback told a trainee they needed to
// talk about financing earlier, on a transcript where they had asked about
// budget, cash-versus-financing, and a trade-in a few turns in, right after the
// customer said they wanted something with more comfort. Nothing in either prompt
// checked whether the topic was already in the transcript before calling it late,
// and nothing required the suggestion to attach to a real moment, so the advice
// was both factually wrong and unactionable. A timing claim the trainee can
// disprove by rereading their own conversation costs the whole score its
// credibility, not just that one sentence.
//
// Same discipline as conversationState.ts: every fact here is read out of the
// transcript's own text by explicit patterns, so the block appended to a prompt
// can never assert something the conversation does not support. The split in
// ownership is deliberate. conversationState.ts derives what the simulated
// CUSTOMER knows; this module derives what a GRADER is allowed to claim about the
// trainee.

import type { TranscriptMessage } from "@shared/schema";
import { derivePriceState, PROPOSAL_MARKERS, TOPIC_PATTERNS } from "./conversationState";

export interface NumberedTurn {
  // 1-based position in the transcript as the graded prompts render it.
  turn: number;
  role: TranscriptMessage["role"];
  text: string;
}

// The single source of turn numbering for every graded prompt: blank turns
// dropped (voice mode inserts an empty customer placeholder), internal newlines
// collapsed so one turn is always one line, numbered from 1. renderTranscriptForScoring
// formats these, so a turn number cited in a grounding block always points at the
// same line the model was shown.
export function numberedTurns(transcript: TranscriptMessage[]): NumberedTurn[] {
  return transcript
    .filter((m) => m.content.trim().length > 0)
    .map((m, i) => ({
      turn: i + 1,
      role: m.role,
      text: m.content.trim().replace(/\s*\n+\s*/g, " "),
    }));
}

// Topics the rubric makes sensitive claims about. Budget/financing has a timing
// rule; warranty/service-plan/maintenance has an omission rule. They share the
// same transcript-derived pipeline so either kind of claim is checked against
// the consultant's actual words before reaching the scoring model.
export type TimingTopic = "budgetAndFinancing" | "warrantyServiceMaintenance";

const TIMING_TOPIC_LABEL: Record<TimingTopic, string> = {
  budgetAndFinancing: "budget, financing, or a trade-in",
  warrantyServiceMaintenance: "warranty, service-plan, maintenance, or protection coverage",
};

// Reuses the financing and payment-mechanics markers the customer-state module
// already matches on, so the two modules cannot disagree about whether a line is
// about financing, and adds the budget/cash/trade-in wording a rep uses when they
// raise the money conversation themselves.
const TIMING_TOPIC_PATTERNS: Record<TimingTopic, RegExp[]> = {
  budgetAndFinancing: [
    ...TOPIC_PATTERNS.financing,
    ...TOPIC_PATTERNS.paymentSpecifics,
    /\bbudget(?:ed|ing)?\b/i,
    /\bprice (?:range|point)\b/i,
    /\bafford(?:able)?\b/i,
    /\b(?:looking|hoping|planning|want|wanted|need) to (?:spend|invest)\b/i,
    /\bcomfortable (?:spending|investing|with)\b.{0,20}\b(?:range|number|month)/i,
    /\bpay(?:ing)? cash\b/i,
    /\bcash or\b/i,
    /\btrade-?in\b/i,
    /\btrading (?:in|it in)\b/i,
    /\bout the door\b/i,
    /\bwhat (?:number|range) (?:works|were you)\b/i,
  ],
  // Keep this bound directly to conversationState's warranty family. A
  // consultant who asks what a customer needs from a maintenance plan or
  // protection package has asked a warranty/service-coverage follow-up, even
  // when neither person uses the word "warranty".
  warrantyServiceMaintenance: [...TOPIC_PATTERNS.warranty],
};

// A question about the warranty-family topic is the relevant discovery move.
// We deliberately accept both conventional punctuation and common spoken
// question forms because voice transcripts often omit "?", and recognize
// invitations such as "tell me what coverage matters" as follow-up questions.
const FOLLOW_UP_QUESTION_MARKERS: RegExp[] = [
  /\?/,
  /^(?:what|which|how|when|where|why|who)\b/i,
  /^(?:do|does|did|is|are|was|were|can|could|would|will|should)\s+(?:you|we|i|the|this|that|a|an|your)\b/i,
  /^(?:tell|walk) me (?:about|through|what)\b/i,
  /^let me know\b/i,
];

// Customer lines in which the customer names what they are actually after. The
// first of these is the earliest real moment a timing suggestion can be attached
// to, and it is the moment the reported failure was about: the customer said they
// wanted more comfort, which is exactly when the money conversation fits.
const NEED_STATEMENT_PATTERNS: RegExp[] = [
  /\b(?:i|we)(?:'m| am|'re| are)? ?(?:want|wanted|need|needed|looking for|after|hoping for)\b/i,
  /\b(?:i|we)(?:'d| would) (?:like|love|prefer)\b/i,
  /\bsomething (?:with|that|more|a little|bigger|smaller|safer|newer)\b/i,
  /\bmore (?:comfort|comfortable|room|space|reliable|reliability|power|efficient|efficiency|storage|seating)\b/i,
  /\b(?:has|needs) to (?:be|have|fit|hold|seat)\b/i,
  /\bmust have\b/i,
  /\bwould be nice\b/i,
  /\bmy (?:priority|main thing|biggest thing)\b/i,
  /\bwhat matters (?:most )?to me\b/i,
  /\bideally\b/i,
];

// A topic raised at or before this fraction of the conversation counts as raised
// early on turn position alone. Position is only one of three early signals; see
// deriveTimingCoverage for the other two.
export const EARLY_TOPIC_FRACTION = 0.5;

// How many turns after the customer first names what they are after still counts
// as raising a topic AT that moment. This is the trainee's own standard for good
// timing: the money conversation belongs right after the customer says what they
// want, because that is when the shape of a workable option starts narrowing. Two
// turns covers the rep's immediate reply and the one after it.
export const EARLY_TRIGGER_GAP = 2;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export interface TimingTopicCoverage {
  topic: TimingTopic;
  label: string;
  totalTurns: number;
  // The first CONSULTANT turn that raised the topic, null when they never did.
  raisedTurn: number | null;
  raisedQuote: string | null;
  // The first turn on which the consultant put a recommendation in front of the
  // customer, i.e. the point past which the money conversation is no longer
  // shaping the options being considered.
  firstProposalTurn: number | null;
  // True when the topic was raised inside the first EARLY_TOPIC_FRACTION of the
  // turns, or before the conversation narrowed to a recommendation, or within
  // EARLY_TRIGGER_GAP turns of the customer naming what they were after.
  raisedEarly: boolean;
  // The earliest customer line naming what they were after: the real moment a
  // timing suggestion has to attach to. Null when the customer never named one,
  // in which case no moment is asserted rather than a weak one invented.
  triggerTurn: number | null;
  triggerQuote: string | null;
}

function isWarrantyFamilyFollowUpQuestion(text: string): boolean {
  return (
    matchesAny(text, TIMING_TOPIC_PATTERNS.warrantyServiceMaintenance) &&
    matchesAny(text, FOLLOW_UP_QUESTION_MARKERS)
  );
}

// Reads, for each timing-coachable topic, whether the consultant raised it, when,
// whether that was early, and which real customer moment a suggestion about it
// would attach to. Returns an empty array for an empty transcript, which is the
// only case where there is nothing at all to say.
export function deriveTimingCoverage(transcript: TranscriptMessage[]): TimingTopicCoverage[] {
  const turns = numberedTurns(transcript);
  if (turns.length === 0) return [];

  const firstProposal = turns.find(
    (t) => t.role === "consultant" && matchesAny(t.text, PROPOSAL_MARKERS),
  );
  const trigger = turns.find(
    (t) => t.role === "customer" && matchesAny(t.text, NEED_STATEMENT_PATTERNS),
  );
  const earlyCutoff = Math.ceil(turns.length * EARLY_TOPIC_FRACTION);

  return (Object.keys(TIMING_TOPIC_PATTERNS) as TimingTopic[]).map((topic) => {
    const raised = turns.find(
      (t) =>
        t.role === "consultant" &&
        (topic === "warrantyServiceMaintenance"
          ? isWarrantyFamilyFollowUpQuestion(t.text)
          : matchesAny(t.text, TIMING_TOPIC_PATTERNS[topic])),
    );
    const raisedEarly =
      raised !== undefined &&
      (raised.turn <= earlyCutoff ||
        (firstProposal !== undefined && raised.turn <= firstProposal.turn) ||
        (trigger !== undefined && raised.turn - trigger.turn <= EARLY_TRIGGER_GAP));
    return {
      topic,
      label: TIMING_TOPIC_LABEL[topic],
      totalTurns: turns.length,
      raisedTurn: raised?.turn ?? null,
      raisedQuote: raised?.text ?? null,
      firstProposalTurn: firstProposal?.turn ?? null,
      raisedEarly,
      triggerTurn: trigger?.turn ?? null,
      triggerQuote: trigger?.text ?? null,
    };
  });
}

// Renders the derived coverage as prompt lines. `speaker` is the label the
// surrounding prompt uses for the trainee's turns ("CONSULTANT" in the rubric,
// "TRAINEE" in the Coach chat) so a line never names a speaker the model cannot
// find in the transcript it was given. Returns "" for an empty transcript, so
// those prompts are byte-identical to the pre-change behavior.
export function buildTimingGroundingBlock(
  transcript: TranscriptMessage[],
  speaker: string = "CONSULTANT",
): string {
  const coverage = deriveTimingCoverage(transcript);
  if (coverage.length === 0) return "";

  const lines = coverage.flatMap((c) => {
    if (c.topic === "warrantyServiceMaintenance") {
      if (c.raisedTurn !== null) {
        return [
          `- ${c.label}: SPECIFIC FOLLOW-UP ASKED. The ${speaker} DID ask a specific warranty/service-plan/maintenance follow-up question at turn ${c.raisedTurn} of ${c.totalTurns}: "${c.raisedQuote}". Do not claim that they never asked what coverage, service plan, maintenance, or protection the customer wanted; do not coach them to ask an equivalent question as though it were absent. If there is a real depth or timing issue, describe that precise issue instead.`,
        ];
      }
      // A negative warranty line would put an unrelated omission in front of
      // every score. This safeguard has one job: make a false "never asked"
      // claim impossible when the consultant did ask the question.
      return [];
    }

    // Only offered as the moment to attach to when it genuinely precedes what is
    // being coached, so the block can never point "earlier" at a later turn.
    const trigger =
      c.triggerTurn !== null && (c.raisedTurn === null || c.triggerTurn < c.raisedTurn)
        ? ` The earliest moment the customer named what they were after is turn ${c.triggerTurn}: "${c.triggerQuote}".`
        : "";

    if (c.raisedTurn !== null && c.raisedEarly) {
      return [
        `- ${c.label}: ALREADY COVERED, and covered early. The ${speaker} raised it themselves at turn ${c.raisedTurn} of ${c.totalTurns}: "${c.raisedQuote}". Do not write that this was missing, do not write that it should have come up earlier or sooner, and do not hedge the same claim. If you mention it at all, credit them for raising it when they did.`,
      ];
    }
    if (c.raisedTurn !== null) {
      return [
        `- ${c.label}: COVERED, but not until turn ${c.raisedTurn} of ${c.totalTurns}: "${c.raisedQuote}".${c.firstProposalTurn !== null ? ` A recommendation was already on the table by turn ${c.firstProposalTurn}.` : ""} Never write that it was missing, because it is there. Timing coaching IS available here, and if you give it you must name when it actually happened and attach the suggestion to a real earlier moment the customer created.${trigger}`,
      ];
    }
    return [
      `- ${c.label}: NOT FOUND on any ${speaker} turn in this transcript. Timing or omission coaching is available here, and if you give it you must attach it to a real moment the customer created rather than to "earlier in the conversation".${trigger}`,
    ];
  });

  return [
    "TIMING PRE-CHECK (read out of the transcript above by exact text match, before you write anything). This is fact about this specific conversation. Never contradict it:",
    ...lines,
  ].join("\n");
}

function formatPrice(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// Deterministic price facts for the scoring model. Reuses the customer-state
// derivation rather than maintaining a second parser, so a customer reply and a
// score can never disagree about the reference price, offer history, or simple
// arithmetic. Returns no block until the transcript contains both a customer
// reference and a consultant offer, leaving unrelated scoring prompts unchanged.
export function buildPriceGroundingBlock(transcript: TranscriptMessage[]): string {
  const state = derivePriceState(transcript);
  if (!state.reference || state.comparisons.length === 0) return "";

  const lines = state.comparisons.map((comparison, index) => {
    const relationship =
      comparison.relation === "equal"
        ? `equal to the reference`
        : `${formatPrice(comparison.difference)} ${comparison.relation} the reference`;
    return `- Consultant offer ${index + 1}: ${formatPrice(comparison.offer.amount)} (${relationship} of ${formatPrice(comparison.reference.amount)}). Transcript line: "${comparison.offer.quote}"`;
  });

  return [
    "PRICE PRE-CHECK (computed from the transcript's dollar figures before you write feedback). These facts are authoritative; never invert a lower/higher comparison or praise a later, higher offer as a price improvement:",
    `- Customer reference price: ${formatPrice(state.reference.amount)}. Transcript line: "${state.reference.statement}"`,
    ...lines,
    "If you discuss price discipline, cite this actual history. Do not claim the consultant was above a reference when the computed comparison says below, and do not call a worse (higher) later offer a concession merely because the customer accepted it.",
  ].join("\n");
}

// Stall coaching has a different factual failure mode from timing coaching. A
// consultant can validate, ask the concern out, gather the requested evidence,
// or set a respectful boundary around "just send me a quote," and a grader can
// still suggest the same move as if it never happened. These phrase families
// intentionally identify only observable trainee actions. They do not infer
// whether the action was persuasive, complete, or well timed; those remain
// legitimate coaching questions for the scoring model.
export type StallActionCategory =
  | "validationAcknowledgement"
  | "stallClarification"
  | "diagnosticQuestion"
  | "collaborativeReviewDataGathering"
  | "futureImpactQuestion"
  | "prematureQuoteBoundary";

export interface StallActionCoverage {
  category: StallActionCategory;
  label: string;
  turn: number;
  quote: string;
}

const STALL_ACTION_LABEL: Record<StallActionCategory, string> = {
  validationAcknowledgement: "validation / acknowledgement",
  stallClarification: "clarification of the stall",
  diagnosticQuestion: "diagnostic question about the concern, reason, or decision process",
  collaborativeReviewDataGathering: "collaborative review or data gathering",
  futureImpactQuestion: "future-impact question",
  prematureQuoteBoundary: "boundary-setting around premature quoting",
};

const VALIDATION_ACKNOWLEDGEMENT_PATTERNS: RegExp[] = [
  /\b(?:i|we)\s+(?:completely |totally |really )?(?:understand|hear|appreciate)\b/i,
  /\bthat(?:'s| is) (?:fair|understandable|reasonable|a good point)\b/i,
  /\bthat makes (?:sense|perfect sense)\b/i,
  /\bno problem at all\b/i,
];

const STALL_CLARIFICATION_PATTERNS: RegExp[] = [
  /\b(?:think(?:ing)?|review|time|decid(?:e|ing|ision)|hesitat(?:e|ion)|hold(?:ing)? back|wait|comfortable)\b/i,
  /\b(?:quote|estimate|proposal|numbers?|details?|savings)\b/i,
];

const DIAGNOSTIC_QUESTION_PATTERNS: RegExp[] = [
  /\b(?:concern|worried|worry|uncomfortable|uncertain|uncertainty|confidence|confident|reason|why|finances?|budget|price|payment|deductible|savings|numbers?|details?)\b/i,
  /\b(?:what|which|how)\b.{0,90}\b(?:need|help|make|figure|confirm|work|feel|decid|think)\b/i,
  /\btell me\b.{0,90}\b(?:about|what|why|how)\b/i,
];

const COLLABORATIVE_REVIEW_DATA_PATTERNS: RegExp[] = [
  /\b(?:let'?s|we can|i can|why don'?t we)\b.{0,120}\b(?:review|look|go over|walk through|compare|figure out|pull|gather|check|log on|collect|grab)\b/i,
  /\b(?:review|look|go over|walk through|compare|pull|gather|check|collect|grab)\b.{0,80}\b(?:data|bills?|history|details?|numbers?|usage|information)\b/i,
];

const FUTURE_IMPACT_QUESTION_PATTERNS: RegExp[] = [
  /\bwhat would happen\b/i,
  /\bif (?:you|we)\b.{0,90}\b(?:wait|delay|don'?t|doesn'?t|not|happen|cost|damage)\b/i,
  /\b(?:are you planning on|over the next|next (?:week|month|year)|more or less)\b/i,
];

const QUOTE_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:send|email|give|provide|share)\b.{0,45}\b(?:quote|estimate|proposal|pricing)\b/i,
];

const QUOTE_BOUNDARY_PATTERNS: RegExp[] = [
  /\b(?:before|rather than|instead of|not just)\b.{0,55}\b(?:send|email|give|provide|share)\b/i,
  /\b(?:don'?t|do not)\b.{0,25}\bjust\b.{0,35}\b(?:send|email|give|provide|share)\b/i,
];

function isSpokenQuestion(text: string): boolean {
  return (
    /\?/.test(text) ||
    /(?:^|[.!]\s*)(?:what|which|how|why|where|who|do|does|did|is|are|can|could|would|will|should)\b/i.test(
      text,
    ) ||
    /\b(?:tell|walk) me\b/i.test(text)
  );
}

// Produces only affirmative, exact-text coverage. In particular, it never
// guesses that an action happened merely because the customer had a stall; a
// category is present only when the CONSULTANT's own turn matches an explicit
// phrase family above. A turn can legitimately appear in more than one category
// (for example, a validating diagnostic question).
export function deriveStallActionCoverage(transcript: TranscriptMessage[]): StallActionCoverage[] {
  const actions: StallActionCoverage[] = [];

  for (const turn of numberedTurns(transcript)) {
    if (turn.role !== "consultant") continue;

    const question = isSpokenQuestion(turn.text);
    const add = (category: StallActionCategory) =>
      actions.push({
        category,
        label: STALL_ACTION_LABEL[category],
        turn: turn.turn,
        quote: turn.text,
      });

    if (matchesAny(turn.text, VALIDATION_ACKNOWLEDGEMENT_PATTERNS)) add("validationAcknowledgement");
    if (question && matchesAny(turn.text, STALL_CLARIFICATION_PATTERNS)) add("stallClarification");
    if (question && matchesAny(turn.text, DIAGNOSTIC_QUESTION_PATTERNS)) add("diagnosticQuestion");
    if (matchesAny(turn.text, COLLABORATIVE_REVIEW_DATA_PATTERNS)) add("collaborativeReviewDataGathering");
    if (question && matchesAny(turn.text, FUTURE_IMPACT_QUESTION_PATTERNS)) add("futureImpactQuestion");
    if (
      question &&
      matchesAny(turn.text, QUOTE_REQUEST_PATTERNS) &&
      matchesAny(turn.text, QUOTE_BOUNDARY_PATTERNS)
    ) {
      add("prematureQuoteBoundary");
    }
  }

  return actions;
}

// A deterministic counterpart to STALL_DIAGNOSIS_RULES. The rubric still judges
// quality, depth, and timing, but this block makes it impossible for feedback to
// call an observable action absent or recommend the same action as a missing
// move. It is deliberately positive-only: no unmatched category is described as
// absent, so it cannot create new coaching obligations.
export function buildStallActionGroundingBlock(
  transcript: TranscriptMessage[],
  speaker: string = "CONSULTANT",
): string {
  const coverage = deriveStallActionCoverage(transcript);
  if (coverage.length === 0) return "";

  // A single turn may validate and ask a diagnostic question. Grouping those
  // categories preserves every grounded action while avoiding multiple copies
  // of a long spoken turn in the scoring prompt.
  const actionsByTurn = new Map<number, StallActionCoverage[]>();
  for (const action of coverage) {
    actionsByTurn.set(action.turn, [...(actionsByTurn.get(action.turn) ?? []), action]);
  }
  const lines = Array.from(actionsByTurn.values()).map((actions) => {
    const [first] = actions;
    return `- Turn ${first.turn}: ${actions.map((action) => action.label).join("; ")} — ALREADY COVERED by the ${speaker}: "${first.quote}"`;
  });

  return [
    "STALL ACTION PRE-CHECK (deterministically read from the CONSULTANT turns above; these exact actions are already in this conversation and outrank any impression that they were absent):",
    ...lines,
    "Never say an action listed above was missing, never recommend a materially equivalent action as though the consultant did not take it, and never use a listed turn as evidence of a different action that its exact quote does not support (for example, do not call a diagnostic question a cost summary). You may coach a meaningfully deeper, better-timed, or different next action only if you first acknowledge the covered action, cite its turn, and explain the specific additional work that remains.",
  ].join("\n");
}
