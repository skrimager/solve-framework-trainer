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
import { PROPOSAL_MARKERS, TOPIC_PATTERNS } from "./conversationState";

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
