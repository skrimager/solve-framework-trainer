// Universal, deterministic conversation state for the simulated customer.
//
// Every scenario inherits this. Nothing here is per-scenario, and nothing here
// asks a model what happened: each fact is derived from the transcript's own
// text by explicit patterns, so the state block appended to the prompt can never
// assert something the conversation does not support. That is the same discipline
// buildTurnStateBlock already followed for "what did the consultant just say" and
// "what have you already said"; this module extends it to the four state
// questions that decide whether a conversation can actually reach an end:
//
//   Rule 2  Has the rep already redirected this topic away? -> safety-net reminder to stop asking.
//   Rule 3  Which concrete numbers/answers has the rep already given? -> never
//           ask for them again.
//   Rule Q  Which factual questions has the customer asked and received a
//           specific answer to? -> accept that answer rather than asking the
//           same question again in slightly different words.
//   Rule 4  Has the rep established who decides and pays? -> honor it, and never
//           spring a brand-new absent decision maker as a blocker.
//   Rule 5  Has the customer already had its one "what else do you have" round?
//   Rule 6  Has the customer already accepted a proposed solution? -> the
//           conversation is allowed to conclude instead of growing new demands.
//   Rule D  Has the rep already MET a number the customer named (including by
//           covering a trivial gap and saying so)? -> stop arguing about it.
//
// It also derives one TURN-scoped fact, kept separate from the state above
// because it is about the latest exchange rather than the whole conversation:
//
//   Rule G  Did the rep just ask something directly (and did they narrow, or
//           redirect a premature topic while doing it)? -> answer it.
//
// Detection is intentionally conservative in both directions. A missed signal
// only means the customer behaves as it did before this module existed, which is
// the pre-existing behavior. A false positive would put words in the customer's
// mouth, so every pattern requires an explicit lexical marker rather than a guess.

import type { TranscriptMessage } from "@shared/schema";

// Topics that genuinely belong to another department in these role-plays. The rep
// is being graded on discovery, not on quoting warranty terms or loan APRs, so
// redirecting one of these is CORRECT behavior and the customer must eventually
// accept the redirect instead of grinding the conversation to a halt on it.
export type DeflectableTopic = "warranty" | "financing" | "loanTerms" | "paymentSpecifics";

// Human-readable name used in the prompt text for each topic.
const TOPIC_LABEL: Record<DeflectableTopic, string> = {
  warranty: "warranty or service coverage",
  financing: "financing, credit, or lender questions",
  loanTerms: "loan terms",
  paymentSpecifics: "specific payment or deposit mechanics",
};

// Lexical markers for each topic. Matched case-insensitively against whole words
// so "finance" does not fire on "financially independent" style near-misses any
// more than necessary.
export const TOPIC_PATTERNS: Record<DeflectableTopic, RegExp[]> = {
  warranty: [/\bwarrant(?:y|ies)\b/i, /\bservice contract\b/i, /\bextended coverage\b/i, /\bservice plan\b/i],
  financing: [/\bfinanc(?:e|ing|ed)\b/i, /\bapr\b/i, /\binterest rate\b/i, /\bcredit (?:score|check|approval)\b/i, /\blender\b/i, /\bpre-?approv/i],
  loanTerms: [/\bloan\b/i, /\bterm length\b/i, /\bmonth (?:term|loan)\b/i, /\b\d{2}\s*month(?:s)?\b/i, /\bamortiz/i, /\bpayoff\b/i],
  paymentSpecifics: [/\bmonthly payment\b/i, /\bdown payment\b/i, /\bdeposit\b/i, /\bpayment plan\b/i, /\btrade-?in value\b/i],
};

// Phrases in which a rep hands a topic off to whoever actually owns it, or parks
// it until later. Any one of these alongside a topic marker is a redirect.
const REDIRECT_MARKERS: RegExp[] = [
  /\b(?:finance|warranty|service|business|insurance)\s+(?:department|team|office|manager|specialist)\b/i,
  /\banother department\b/i,
  /\bnot (?:really )?my (?:department|area)\b/i,
  /\bsomeone (?:else|who)\b.{0,40}\b(?:handle|walk|go over|cover)/i,
  /\b(?:they|he|she)(?:'ll| will| can)\b.{0,40}\b(?:handle|walk you|go over|cover)\b/i,
  /\bhand(?:s|ed)? (?:that|you) (?:off|over)\b/i,
  /\bhandle(?:s|d)? (?:all of )?that\b/i,
  /\bget (?:you )?(?:to|with) (?:them|the)\b/i,
  /\bonce we\b/i,
  /\bafter we\b/i,
  /\bbefore we (?:get|dig) into\b/i,
  /\bfirst,? (?:let'?s|i'?d like|i want)\b/i,
  /\blet'?s (?:first|start|focus|come back|circle back)\b/i,
  /\bcome back to (?:that|it)\b/i,
  /\bcircle back\b/i,
  /\bpark(?:ing)? that\b/i,
  /\bset that (?:aside|to the side)\b/i,
  /\bnail down\b/i,
];

// A customer line counts as ASKING about a topic when it carries a topic marker
// and reads as a request rather than a statement.
const ASK_MARKERS: RegExp[] = [
  /\?/,
  /\bwhat(?:'s| is| are| about)\b/i,
  /\bhow (?:much|long|does|do|would|about)\b/i,
  /\bcan you (?:tell|explain|give)\b/i,
  /\bi (?:want|need) to know\b/i,
  /\btell me about\b/i,
  /\bwhat kind of\b/i,
];

// Number of rep redirects retained for the deterministic safety-net. The
// reactive-only prompt now requires the customer to stop after the FIRST proper
// redirect; this threshold remains only to catch a model failure that made an
// impermissible callback anyway.
export const DEFLECTION_STOP_THRESHOLD = 2;

// The rep asking who makes or funds the decision. This is the discovery move the
// scenario must then honor: if the rep asked and the customer answered, a
// previously unmentioned absent decision maker can never appear later as a
// blocker.
const DECISION_MAKER_QUESTION_PATTERNS: RegExp[] = [
  /\bwho(?:'s| is| else| will| would| are)\b.{0,60}\b(?:decid|deciding|decision|involved|sign|paying|pay for|buying|purchas)/i,
  /\banyone else\b.{0,50}\b(?:involved|decision|deciding|weigh|say|part of)/i,
  /\bare you the (?:one|only|main|final)\b/i,
  /\bis (?:this|it) (?:just|only) you\b/i,
  /\bjust you\b.{0,30}\b(?:decid|buying|paying|on this)/i,
  /\bwill (?:anyone|someone|somebody) else\b/i,
  /\bwho(?:'s| is) (?:going to be )?(?:the )?(?:main|primary) driver\b/i,
  /\bwhose name\b.{0,30}\b(?:on|title|loan|paperwork)\b/i,
  /\b(?:you|who)(?:'re| are|'s| is)\b.{0,30}\bwriting the check\b/i,
];

// The customer asking to be shown different options. Allowed exactly once.
const ALTERNATIVES_REQUEST_PATTERNS: RegExp[] = [
  /\bwhat else (?:do|have) you\b/i,
  /\banything else\b.{0,30}\b(?:have|show|available|like that|in that)/i,
  /\b(?:what|any) other (?:options?|choices?|models?|vehicles?|cars?|units?|homes?|properties|plans?)\b/i,
  /\bother options\b/i,
  /\bsomething else\b/i,
  /\bshow me (?:something|another|other)\b/i,
  /\bwhat (?:are|were) my options\b/i,
];

// The customer signalling that a proposed solution actually fits. Deliberately
// requires an explicit endorsement: hedges like "maybe" or "I'll think about it"
// must NOT count, or the conversation would be declared over while the rep still
// has real work to do.
const SOLUTION_ACCEPTED_PATTERNS: RegExp[] = [
  /\bthat (?:sounds|seems|feels) (?:good|great|right|perfect|about right|like a fit|like what)\b/i,
  /\bthat (?:would )?work(?:s)?(?: for (?:me|us))?\b/i,
  /\bthat(?:'s| is) (?:exactly )?what (?:i|we) (?:want|need|were looking for)\b/i,
  /\bthat(?:'s| is) (?:the one|it)\b/i,
  /\bthat fits\b/i,
  /\bi(?:'ll| will) take (?:it|that)\b/i,
  /\blet'?s (?:do|go with) (?:it|that|the)\b/i,
  /\bi(?:'m| am) (?:happy|comfortable|good) with (?:that|it|this)\b/i,
  /\bi (?:like|love) that\b/i,
  /\bokay,? (?:that|this) (?:one|works|is the one)\b/i,
];

// The rep putting an actual recommendation, option, or solution in front of the
// customer. Acceptance only means something once one of these has happened, so
// "that works for me" in answer to a discovery question is never mistaken for
// accepting a solution that was never proposed.
export const PROPOSAL_MARKERS: RegExp[] = [
  /\bi(?:'d| would) recommend\b/i,
  /\bi recommend\b/i,
  /\bmy recommendation\b/i,
  /\bi(?:'d| would) suggest\b/i,
  /\bwhat i(?:'d| would) (?:do|put you in|point you to)\b/i,
  /\bbased on (?:what|everything) you(?:'ve| have)\b/i,
  /\bgiven (?:what|everything) you(?:'ve| have)\b/i,
  /\b(?:here'?s|this is) what i(?:'m| am) thinking\b/i,
  /\bi(?:'ve| have) got\b.{0,40}\b(?:that|which|for you)\b/i,
  /\bi think (?:the|this|that)\b.{0,40}\b(?:would|is|fits|makes sense)\b/i,
  /\blet(?:'s| us) (?:look at|start with|go with|put you)\b/i,
  /\bwould (?:be|work) (?:a good|the right|perfect)\b/i,
  /\bthe (?:one|option|model|unit|plan|home|property) i(?:'d| would)\b/i,
  /\bthat would (?:cover|handle|take care of|check)\b/i,
  /\bsounds like\b.{0,40}\b(?:fit|match|right for you|what you need)\b/i,
];

// A number, price, date, or other concrete figure the rep has handed over. Once
// given, the customer knows it and can never ask for it again from scratch.
const QUOTED_FACT_PATTERN = /(\$\s?[\d,]+(?:\.\d{2})?|\b\d[\d,]*(?:\.\d+)?\s*(?:percent\b|%|miles\b|mpg\b|months?\b|weeks?\b|days?\b|years?\b|hours?\b|pounds?\b|lbs\b|tons?\b|bedrooms?\b|baths?\b|square feet\b|sq ?ft\b))/i;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function mentionsTopic(text: string, topic: DeflectableTopic): boolean {
  return matchesAny(text, TOPIC_PATTERNS[topic]);
}

// ---------------------------------------------------------------------------
// Rule D: recognizing that a number the customer named has been MET.
//
// The live failure: the customer said $14,000, the rep came back at $14,000.02
// and offered to cover the two cents, and the customer kept arguing that its
// budget had not been respected. deriveQuotedFacts already told the customer it
// knew the figure, but nothing compared that figure against what the customer
// had ASKED for, so a met need was indistinguishable from an unmet one.
//
// Comparison is done on parsed amounts rather than left to the model, so the
// state block can only ever assert "met" about a number pair the transcript
// actually contains.
// ---------------------------------------------------------------------------

// Written-out numbers, needed because a voice transcript frequently renders
// "fourteen thousand" rather than "$14,000".
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

// Word-number sources, built from the map above so the two cannot drift. Longest
// alternatives first so "nineteen" is never matched as "nine".
const WORD_KEYS_BY_LENGTH = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length);
const TENS_WORDS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ONES_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
// "twenty five" / "twenty-five" as a compound, or any single word-number.
const WORD_NUMBER_SOURCE =
  `(?:(?:${TENS_WORDS.join("|")})[\\s-](?:${ONES_WORDS.join("|")})|${WORD_KEYS_BY_LENGTH.join("|")})`;

// What may FOLLOW an amount and disqualify it from being a comparable total.
// Applied to the text after the match rather than as a lookahead: a lookahead
// lets the engine backtrack the captured digits to make itself succeed, which is
// how "$450 a month" was parsed as 45.
//
// A per-month figure is a payment, not a purchase total.
const PER_MONTH_TAIL = /^(?:\s*(?:a|per|\/)\s*month\b|\s*monthly\b|\s*\/\s*mo\b)/i;
// A unit that proves the quantity is not money at all, so "22 thousand miles"
// and "two thousand square feet" never enter the comparison.
const NON_MONEY_TAIL =
  /^\s*(?:miles?|mpg|square|sq|feet|ft|months?|weeks?|days?|years?|hours?|pounds?|lbs|acres?|bedrooms?|baths?)\b/i;

// Each money form, with the multiplier its capture carries and the trailing text
// that disqualifies it.
const MONEY_PATTERNS: { pattern: RegExp; scale: number; rejectTails: RegExp[] }[] = [
  { pattern: /\$\s?([\d,]+(?:\.\d{1,2})?)/g, scale: 1, rejectTails: [PER_MONTH_TAIL] },
  {
    pattern: /\b([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks)\b/gi,
    scale: 1,
    rejectTails: [PER_MONTH_TAIL],
  },
  // "fourteen thousand", "14 thousand", "14k", "fourteen grand", "twenty five grand".
  {
    pattern: new RegExp(String.raw`\b(${WORD_NUMBER_SOURCE}|[\d,]+(?:\.\d+)?)\s*(?:thousand|grand|k)\b`, "gi"),
    scale: 1000,
    rejectTails: [PER_MONTH_TAIL, NON_MONEY_TAIL],
  },
];

function parseNumberToken(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase();
  if (/^[\d,]+(?:\.\d+)?$/.test(cleaned)) {
    const n = Number(cleaned.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  let total = 0;
  for (const word of cleaned.split(/[\s-]+/)) {
    const value = WORD_NUMBERS[word];
    if (value === undefined) return null;
    total += value;
  }
  return total > 0 ? total : null;
}

// Every money amount a line names, in dollars. Non-money quantities and monthly
// payments are excluded.
export function parseMoneyAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const { pattern, scale, rejectTails } of MONEY_PATTERNS) {
    // These patterns are module-level and shared, so lastIndex is reset up front.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const tail = text.slice(match.index + match[0].length);
      if (rejectTails.some((re) => re.test(tail))) continue;
      const n = parseNumberToken(match[1]);
      if (n !== null) amounts.push(n * scale);
    }
  }
  return amounts;
}

// A customer line that names a number as a target or a ceiling, rather than just
// mentioning one in passing.
const BUDGET_STATEMENT_MARKERS: RegExp[] = [
  /\bmy budget\b/i,
  /\bbudget (?:is|of|around|at|would be)\b/i,
  /\b(?:can'?t|cannot|can not|won'?t|not going to) (?:go|spend|do|be) (?:over|above|past|beyond|more than|higher than)\b/i,
  /\b(?:keep|keeping|stay|staying|come in|be) (?:it |them )?(?:under|below|at or under|within|inside)\b/i,
  /\b(?:no|not) more than\b/i,
  /\bmax(?:imum)?\b/i,
  /\bceiling\b/i,
  /\bthat'?s (?:my|the) (?:limit|max|number|ceiling|budget)\b/i,
  /\ball i(?:'ve| have)? (?:got|can do|can swing)\b/i,
  /\bi (?:told|said) you\b.{0,30}\bbudget\b/i,
  /\bneed(?:s)? to (?:be|come in|land) (?:at|under|below)\b/i,
  /\blooking to (?:spend|stay)\b/i,
  /\bup to\b/i,
];

// The rep explicitly absorbing a small remainder, which is what turns a
// near-miss into a met number.
const GAP_CLOSING_MARKERS: RegExp[] = [
  /\b(?:i'?ll|i will|we'?ll|we will|let me|let us) (?:just )?(?:cover|eat|absorb|waive|pick up|take care of|knock off|comp)\b/i,
  /\bcover the (?:difference|gap|rest|remainder|two cents|change)\b/i,
  /\bon (?:me|us|the house)\b/i,
  /\bcall it even\b/i,
  /\b(?:round|rounding) (?:that|it) (?:down|off)\b/i,
  /\bdon'?t worry about the\b/i,
  /\bthat(?:'s| is) my treat\b/i,
];

// How far over a stated number still counts as trivially met when the rep says
// they will absorb it: half a percent of what the customer asked for ($70 on a
// $14,000 budget). Anything larger is a real gap the customer is entitled to
// keep pressing on, so difficulty is untouched.
export const TRIVIAL_GAP_FRACTION = 0.005;
// A quote must be in the same ballpark as the stated number to be comparable to
// it at all. Without this floor a $500 deposit or a $99 fee would satisfy a
// $14,000 budget simply by being smaller than it.
export const COMPARABLE_QUOTE_FRACTION = 0.5;

export interface MetNeedState {
  // The customer's own line naming the number.
  statement: string;
  statedAmount: number;
  // The rep's line that met it.
  quote: string;
  quotedAmount: number;
  // True when the quote came in slightly over and the rep said they would
  // absorb the remainder.
  gapClosed: boolean;
}

function formatAmount(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// The most recent number the customer named as a target/ceiling, matched against
// the most recent rep quote that satisfies it. Returns null unless the
// transcript contains both, so a conversation where the budget genuinely has not
// been met produces no state line and the customer keeps pressing exactly as
// before.
function deriveMetNeed(transcript: TranscriptMessage[]): MetNeedState | null {
  let statement: string | null = null;
  let statedAmount = 0;
  let met: MetNeedState | null = null;

  for (const m of transcript) {
    const text = m.content.trim();
    if (!text) continue;

    if (m.role === "customer") {
      if (!matchesAny(text, BUDGET_STATEMENT_MARKERS)) continue;
      const amounts = parseMoneyAmounts(text);
      if (amounts.length === 0) continue;
      // The largest amount in the line is the ceiling, which makes a range
      // ("twelve to fourteen thousand") resolve to the number that matters.
      statement = text;
      statedAmount = Math.max(...amounts);
      met = null;
      continue;
    }

    if (!statement) continue;
    const closesGap = matchesAny(text, GAP_CLOSING_MARKERS);
    for (const quotedAmount of parseMoneyAmounts(text)) {
      if (quotedAmount < statedAmount * COMPARABLE_QUOTE_FRACTION) continue;
      const over = quotedAmount - statedAmount;
      const meetsIt = over <= 0 || (closesGap && over <= statedAmount * TRIVIAL_GAP_FRACTION);
      if (!meetsIt) continue;
      met = { statement, statedAmount, quote: text, quotedAmount, gapClosed: over > 0 };
    }
  }

  return met;
}

export interface DeflectedTopicState {
  topic: DeflectableTopic;
  label: string;
  // How many times the rep has redirected this topic away.
  redirectCount: number;
  // True once the rep has redirected it DEFLECTION_STOP_THRESHOLD times, at
  // which point the customer must never raise it again.
  closed: boolean;
}

export interface DecisionMakerState {
  // The rep's question that established the decision structure.
  question: string;
  // The customer's own answer to it, which is now binding on the scenario.
  answer: string;
}

export interface SequencedTopicState {
  // The customer's own words for what they asked about, quoted back into the
  // prompt. There is no fixed vocabulary here: whatever they raised is the
  // label.
  label: string;
  // Normalized content words, used to recognize the same subject when it comes
  // back worded differently ("safety rating" / "safety ratings").
  keywords: string[];
  // How many times the rep has proposed handling this subject later.
  redirectCount: number;
  // True once the rep has sequenced it SEQUENCING_STOP_THRESHOLD times.
  closed: boolean;
}

export interface ConversationState {
  deflectedTopics: DeflectedTopicState[];
  sequencedTopics: SequencedTopicState[];
  decisionMaker: DecisionMakerState | null;
  // How many separate times the customer has asked to be shown other options.
  alternativesRequests: number;
  // True once the customer has already had its one alternatives round answered.
  alternativesRoundSpent: boolean;
  // The customer's own line accepting a proposed solution, if any.
  acceptedSolutionLine: string | null;
  // Concrete figures the rep has already provided.
  quotedFacts: string[];
  // Factual questions the customer asked that the consultant answered
  // specifically, or answered vaguely enough to permit one clarification.
  answeredCustomerQuestions: AnsweredCustomerQuestionState[];
  // A number the customer named that the rep has since met, if any.
  metNeed: MetNeedState | null;
}

// Counts, per topic, how many times the rep redirected it. A redirect only
// counts when the customer had actually raised the topic beforehand, so a rep
// mentioning "we'll get to financing later" unprompted is not scored as having
// shut down a question nobody asked.
//
// A real redirect usually does NOT repeat the topic word ("that's handled by our
// service department"), so an outstanding ask is attributed to the rep's next
// reply. `pending` therefore holds only the topics asked since the rep last
// spoke, and is cleared on every rep turn: if they answered instead of
// redirecting, the topic is no longer outstanding.
function deriveDeflectedTopics(transcript: TranscriptMessage[]): DeflectedTopicState[] {
  const topics = Object.keys(TOPIC_PATTERNS) as DeflectableTopic[];
  const everAsked = new Set<DeflectableTopic>();
  const pending = new Set<DeflectableTopic>();
  const redirectCounts = new Map<DeflectableTopic, number>();

  for (const m of transcript) {
    const text = m.content.trim();
    if (!text) continue;

    if (m.role === "customer") {
      if (matchesAny(text, ASK_MARKERS)) {
        for (const topic of topics) {
          if (mentionsTopic(text, topic)) {
            everAsked.add(topic);
            pending.add(topic);
          }
        }
      }
      continue;
    }

    if (matchesAny(text, REDIRECT_MARKERS)) {
      const redirected = new Set<DeflectableTopic>(pending);
      // A later reply that names the topic outright still counts, even if the
      // customer's ask was several turns back.
      for (const topic of topics) {
        if (everAsked.has(topic) && mentionsTopic(text, topic)) redirected.add(topic);
      }
      for (const topic of topics) {
        if (!redirected.has(topic)) continue;
        redirectCounts.set(topic, (redirectCounts.get(topic) ?? 0) + 1);
      }
    }
    pending.clear();
  }

  return topics
    .filter((topic) => (redirectCounts.get(topic) ?? 0) > 0)
    .map((topic) => {
      const redirectCount = redirectCounts.get(topic)!;
      return {
        topic,
        label: TOPIC_LABEL[topic],
        redirectCount,
        closed: redirectCount >= DEFLECTION_STOP_THRESHOLD,
      };
    });
}

// ---------------------------------------------------------------------------
// Rule S: the rep sequencing a topic for later, on ANY subject.
//
// The live failure: the customer asked about safety ratings, the rep said "let's
// make sure we find the right vehicle for you first" and asked a real discovery
// question, and the customer re-asked about safety ratings verbatim on every
// following turn. Rule 2 above is the mechanism that would have stopped it, but
// it can only ever fire for the four DeflectableTopic values, and safety is not
// one of them, so no state was produced and the model had no memory of the
// redirect.
//
// Adding `safety` as a fifth enum value would have fixed exactly this
// transcript and left the next unhardcoded subject broken. It is also the wrong
// semantics: the four topics above mean "this belongs to another department and
// the rep is right to hand it off". Sequencing means the opposite, that the
// topic belongs to THIS conversation, just later, once discovery has earned it.
//
// So this mechanism carries no topic vocabulary at all. The subject is read out
// of the customer's own question at runtime, which is what makes it work for
// safety ratings, tow capacity, paint colors, or anything else nobody thought
// to list. What it requires instead is stronger evidence per turn than Rule 2
// does: the rep must DEFER the topic and pivot to discovery in the same reply,
// so a bare brush-off is never mistaken for skilled sequencing.
//
// Deferral is recognized two ways, because reps only sometimes say it as an
// order. The first version of this rule only understood ordering adverbs
// ("first", "before we", "once we") and missed the reported transcript
// entirely, which stated the same move as a CONDITION and never used one:
// "if it's not the right vehicle the safety features on this one doesn't
// matter". Both forms are sequencing; only one of them says "first".
// ---------------------------------------------------------------------------

// Number of times the rep may sequence the SAME subject retained for the
// deterministic safety-net. Reactive-only behavior forbids an independent
// callback after the first proper sequencing; the second count only catches a
// failed generation that violated that primary rule.
export const SEQUENCING_STOP_THRESHOLD = 2;

// Ordering phrases: the rep putting a topic later in the conversation rather
// than handing it to someone else. This is a separate list from
// REDIRECT_MARKERS, which is mostly about department handoff and stays
// untouched, though the ordering phrases the two have in common are repeated
// here so sequencing does not depend on that list's shape.
//
// The trailing-"first" forms are what the reported transcript actually used
// ("let's make sure we find the right vehicle for you first"), and no existing
// marker matched it.
const SEQUENCING_MARKERS: RegExp[] = [
  /\blet'?s (?:first|start|focus|come back|circle back)\b/i,
  /\bfirst,? (?:let'?s|i'?d like|i want|i need)\b/i,
  /\b(?:find|figure out|nail down|pin down|sort out|lock in|settle|get|know|understand)\b[^.!?]{0,60}\bfirst\b/i,
  /\bonce we\b/i,
  /\bafter we\b/i,
  /\bbefore we (?:get|dig|talk|go|jump|move)\b/i,
  /\bwe(?:'ll| will| can) (?:get|come|circle) back to\b/i,
  /\bcome back to (?:that|it|this)\b/i,
  /\bcircle back\b/i,
  /\bpark(?:ing)? that\b/i,
  /\bset that (?:aside|to the side)\b/i,
  /\bnail down\b/i,
  /\bthen (?:we'?ll|we can|i'?ll|i can)\b[^.!?]{0,60}\b(?:cover|go over|get into|talk about|look at|come back)\b/i,
  /\bstart(?:ing)? with\b/i,
];

// The same move stated as a condition instead of an order: the topic is not
// refused and not handed off, it is declared not-yet-meaningful until something
// else is settled. This is how the reported transcript said it, and how reps
// tend to say it out loud, where ordering adverbs are rare and run-on speech
// with no punctuation is the norm.
//
// These are deliberately about the SHAPE of the argument (a conditional or
// temporal clause tied to an assertion of irrelevance, or making sure the right
// option is identified before its details are worth discussing) rather than
// about any topic, so they carry no more vocabulary than the ordering list does.
const RELEVANCE_CONDITIONING_MARKERS: RegExp[] = [
  // "if it's not the right vehicle the safety features ... doesn't matter"
  /\b(?:if|unless|until)\b[^.!?]{0,80}\b(?:do(?:es)?n'?t|do(?:es)? not|won'?t|will not|wouldn'?t)\s+(?:really\s+|even\s+)?(?:matter|help|mean|count)\b/i,
  // the same sentence with its halves the other way round
  /\b(?:do(?:es)?n'?t|do(?:es)? not|won'?t|will not|wouldn'?t)\s+(?:really\s+|even\s+)?(?:matter|help|mean|count)\b[^.!?]{0,80}\b(?:if|unless|until|once|when)\b/i,
  // "there's no point going through specs until we know what you need"
  /\b(?:no|not much|little)\s+(?:point|sense|use|value)\b[^.!?]{0,60}\b(?:until|unless|before|if|till)\b/i,
  // "that only matters once we've picked something"
  /\bonly\s+(?:matters?|helps?|counts?)\b[^.!?]{0,60}\b(?:once|after|when|if)\b/i,
  // establishment-first framing: pinning down the RIGHT option is the
  // precondition, which is sequencing even with no ordering word present
  /\b(?:make sure|figure out|find out|know|establish|land on|settle on)\b[^.!?]{0,40}\bthe right\b/i,
];

// Rule 2's ASK_MARKERS assume tidy text: "can you tell", "tell me about", and a
// question mark. Speech interposes words and drops punctuation, so the reported
// customer line ("Can you please tell me more about the safety features can you
// make sure that you can give me information on the safety ratings") matched
// none of them and Rule S never even looked at the rep's reply. These are the
// same requests with the adjacency relaxed and the question mark optional.
//
// Kept as a separate list rather than widening ASK_MARKERS, so the
// department-handoff rule's inputs and behavior are untouched.
const SOFT_ASK_MARKERS: RegExp[] = [
  ...ASK_MARKERS,
  /\b(?:can|could|would) you\b[^.!?]{0,24}\b(?:tell|explain|give|show|walk)\b/i,
  /\btell me\b[^.!?]{0,16}\babout\b/i,
  /\b(?:want|need|like|love)\s+to\s+(?:know|hear|see|understand)\b/i,
  /\b(?:curious|wondering)\b/i,
  /\bgive me\b[^.!?]{0,24}\b(?:information|info|details|idea|sense|rundown)\b/i,
];

// How the customer names what they are asking about. Each captures the subject
// itself rather than testing for a known topic, which is the whole point: the
// vocabulary comes from the customer, not from this file.
const SUBJECT_CAPTURE_PATTERNS: RegExp[] = [
  /\b(?:tell me|talk|hear|know|curious|wondering|asking)\b[^?.!]{0,24}\babout\s+([^?.!,;]{2,60})/i,
  /\bwhat(?:'s| is| are)\s+(?:the|your|its|their)\s+([^?.!,;]{2,60})/i,
  // "What towing capacity does it have?" / "What interest rate is this?"
  // are common factual asks that do not include "the" after what.
  /\bwhat\s+([^?.!,;]{2,60})/i,
  /\bhow(?:'s| is| are)\s+(?:the|its|their)\s+([^?.!,;]{2,60})/i,
  /\bwhat about\s+([^?.!,;]{2,60})/i,
  /\bhow about\s+([^?.!,;]{2,60})/i,
  /\bwhat kind of\s+([^?.!,;]{2,60})/i,
  // "How much can it tow?" has its subject after "it", rather than directly
  // after "how much".
  /\bhow (?:much|many)\s+(?:can|does|do|would|will)\s+(?:it|this|that|they|we)\s+([^?.!,;]{2,60})/i,
  /\bhow (?:much|many)\s+([^?.!,;]{2,60})/i,
  /\bdoes it (?:have|come with|get)\s+([^?.!,;]{2,60})/i,
  /\b(?:can|could|will|would) (?:it|this|that|they|we)\s+([^?.!,;]{2,60})/i,
  /\bis (?:it|this|that|the)\s+([^?.!,;]{2,60})/i,
];

// Where a captured phrase stops being the subject and starts being the rest of
// the sentence: "the safety rating on this one" is about the safety rating.
const SUBJECT_TAIL_BREAK =
  /\s+(?:on|in|for|with|at|like|that|this|these|those|here|there|though|but|when|if|as|does|do|did|is|are|was|were|can|could|will|would|should|has|have|had)\s+/i;

const SUBJECT_LEADING_FILLER = /^(?:the|a|an|your|our|its|their|his|her|any|some|more|other|of)\s+/i;

// Words that carry no subject on their own, so "tell me about it" names nothing
// and produces no tracked subject at all.
const SUBJECT_STOPWORDS = new Set([
  "it", "this", "that", "these", "those", "one", "ones", "thing", "things", "stuff",
  "here", "there", "you", "your", "yours", "my", "me", "mine", "we", "us", "our",
  "they", "them", "their", "the", "a", "an", "and", "or", "but", "of", "to", "for",
  "on", "in", "at", "with", "about", "more", "much", "many", "some", "any", "other",
  "is", "are", "was", "were", "be", "do", "does", "did", "get", "got", "have", "has",
  "know", "tell", "like", "look", "really", "just", "so", "then", "now", "what",
  "how", "why", "when", "which", "who", "whole", "bit", "lot",
]);

// Crude singularization, enough to tie "ratings" to "rating" without pulling in
// a stemmer. "ss" endings are left alone so "business" does not become "busines".
function normalizeKeyword(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Enough stemming to recognize "tow" / "towing" as the same factual
  // subject. This is intentionally small and only used for matching a
  // customer's own rephrased question or the consultant's answer.
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export interface AskedSubject {
  label: string;
  keywords: string[];
}

// What the customer's line is asking ABOUT, in their own words. Null when the
// line names nothing concrete, which keeps the mechanism conservative: an
// undetected subject just means the pre-existing behavior.
export function extractAskedSubject(text: string): AskedSubject | null {
  for (const pattern of SUBJECT_CAPTURE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    let phrase = match[1].split(SUBJECT_TAIL_BREAK)[0].trim();
    while (SUBJECT_LEADING_FILLER.test(phrase)) {
      phrase = phrase.replace(SUBJECT_LEADING_FILLER, "").trim();
    }
    if (!phrase) continue;

    const keywords = Array.from(
      new Set(
        phrase
          .split(/\s+/)
          .map(normalizeKeyword)
          .filter((w) => w.length > 1 && !SUBJECT_STOPWORDS.has(w)),
      ),
    );
    if (keywords.length === 0) continue;

    return { label: phrase, keywords };
  }
  return null;
}

// True when the line belongs to one of the four department-handoff topics. Those
// are Rule 2's territory and are deliberately never tracked here, so the two
// mechanisms cannot both claim the same ask or double up their prompt lines.
function isDepartmentTopic(text: string): boolean {
  return (Object.keys(TOPIC_PATTERNS) as DeflectableTopic[]).some((topic) =>
    mentionsTopic(text, topic),
  );
}

// A rep reply that sequences rather than dodges: it names an order AND asks a
// real question of its own. The question is what separates "let's come back to
// that once we know what you need, what are you driving today?" from "let's come
// back to that", which is a brush-off the customer should not have to accept.
function isSequencingRedirect(text: string): boolean {
  const defers =
    matchesAny(text, SEQUENCING_MARKERS) || matchesAny(text, RELEVANCE_CONDITIONING_MARKERS);
  return defers && extractAsks(text).length > 0;
}

function mentionsKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => new RegExp(`\\b${k}(?:s|ing|ed)?\\b`, "i").test(text));
}

// Counts, per subject the customer raised, how many times the rep proposed
// handling it later. Same accounting shape as deriveDeflectedTopics: `pending`
// holds subjects asked since the rep last spoke and is cleared on every rep
// turn, so a rep who simply answered has not redirected anything.
function deriveSequencedTopics(transcript: TranscriptMessage[]): SequencedTopicState[] {
  const tracked: { label: string; keywords: string[]; redirectCount: number }[] = [];
  const pending = new Set<(typeof tracked)[number]>();

  for (const m of transcript) {
    const text = m.content.trim();
    if (!text) continue;

    if (m.role === "customer") {
      if (!matchesAny(text, SOFT_ASK_MARKERS) || isDepartmentTopic(text)) continue;
      const subject = extractAskedSubject(text);
      if (!subject) continue;
      // The same subject worded differently is the same subject, so a later ask
      // adds to the existing entry instead of starting a second one.
      let entry = tracked.find((e) => e.keywords.some((k) => subject.keywords.includes(k)));
      if (entry) {
        entry.keywords = Array.from(new Set([...entry.keywords, ...subject.keywords]));
      } else {
        entry = { label: subject.label, keywords: subject.keywords, redirectCount: 0 };
        tracked.push(entry);
      }
      pending.add(entry);
      continue;
    }

    if (isSequencingRedirect(text)) {
      const redirected = new Set(pending);
      // A reply that names the subject outright still counts, even when the ask
      // was several turns back ("then we'll cover safety ratings").
      for (const entry of tracked) {
        if (mentionsKeyword(text, entry.keywords)) redirected.add(entry);
      }
      redirected.forEach((entry) => {
        entry.redirectCount += 1;
      });
    }
    pending.clear();
  }

  return tracked
    .filter((e) => e.redirectCount > 0)
    .map((e) => ({
      label: e.label,
      keywords: e.keywords,
      redirectCount: e.redirectCount,
      closed: e.redirectCount >= SEQUENCING_STOP_THRESHOLD,
    }));
}

// The rep's decision-maker question plus the customer's next line, which is the
// answer that becomes binding. Returns null when the rep never asked (in which
// case the customer remains free to surface a decision maker later, which is
// realistic: the rep simply did not do that discovery).
function deriveDecisionMaker(transcript: TranscriptMessage[]): DecisionMakerState | null {
  for (let i = 0; i < transcript.length; i++) {
    const m = transcript[i];
    if (m.role !== "consultant") continue;
    const question = m.content.trim();
    if (!matchesAny(question, DECISION_MAKER_QUESTION_PATTERNS)) continue;
    const reply = transcript.slice(i + 1).find((n) => n.role === "customer" && n.content.trim().length > 0);
    if (reply) return { question, answer: reply.content.trim() };
  }
  return null;
}

function countAlternativesRequests(transcript: TranscriptMessage[]): number {
  return transcript.filter(
    (m) => m.role === "customer" && matchesAny(m.content, ALTERNATIVES_REQUEST_PATTERNS),
  ).length;
}

// True when the customer asked for other options AND the rep replied after that
// ask, i.e. the one allowed alternatives round has actually been played out.
function isAlternativesRoundSpent(transcript: TranscriptMessage[]): boolean {
  const askIndex = transcript.findIndex(
    (m) => m.role === "customer" && matchesAny(m.content, ALTERNATIVES_REQUEST_PATTERNS),
  );
  if (askIndex === -1) return false;
  return transcript
    .slice(askIndex + 1)
    .some((m) => m.role === "consultant" && m.content.trim().length > 0);
}

// The customer's line accepting a solution, but ONLY once the rep has actually
// put one in front of them. Order matters: an agreeable answer to a discovery
// question is not acceptance of a recommendation that does not exist yet.
function deriveAcceptedSolutionLine(transcript: TranscriptMessage[]): string | null {
  let proposed = false;
  for (const m of transcript) {
    const text = m.content.trim();
    if (!text) continue;
    if (m.role === "consultant") {
      if (matchesAny(text, PROPOSAL_MARKERS)) proposed = true;
      continue;
    }
    if (proposed && matchesAny(text, SOLUTION_ACCEPTED_PATTERNS)) return text;
  }
  return null;
}

// True when the rep proposed a solution AND the customer then said it fits.
//
// This is the deterministic half of Rule 8: an accepted engineered solution IS a
// successful outcome, so the "has the consultant reached a terminal point" gate
// must never answer "no solution presented yet" for a conversation whose own text
// shows the customer accepting one. Derived from the transcript rather than asked
// of a model, so that contradiction is structurally impossible.
export function hasCustomerAcceptedProposal(transcript: TranscriptMessage[]): boolean {
  return deriveAcceptedSolutionLine(transcript) !== null;
}

function deriveQuotedFacts(transcript: TranscriptMessage[]): string[] {
  return transcript
    .filter((m) => m.role === "consultant" && QUOTED_FACT_PATTERN.test(m.content))
    .map((m) => m.content.trim());
}

// ---------------------------------------------------------------------------
// Rule Q: a factual question that has already received a real answer.
//
// Quoted facts above remember figures the consultant said, but they do not
// establish what customer question that figure answered. That gap is what lets a
// customer hear "12,000 to 14,000 pounds" and nevertheless ask another version
// of "what can it tow?" on the next turn. This mirror-image state keeps the
// customer's own factual ask attached to the consultant's immediate response.
//
// Detection stays deliberately conservative. It only closes a question when the
// response contains an explicit factual shape (a number/range, a clear yes/no,
// or a named feature) and either names the question's subject or is a direct
// yes/no reply. A vague or evasive reply leaves room for exactly one
// clarification; it is never treated as a specific answer.
// ---------------------------------------------------------------------------

export interface AnsweredCustomerQuestionState {
  // The customer's own words for the factual subject, so this works across every
  // vertical rather than through a vocabulary of vehicle-only topics.
  label: string;
  keywords: string[];
  question: string;
  answer: string;
  // "answered" means the consultant supplied a concrete fact. "vague" means
  // the answer was non-specific or evasive and the customer may clarify once.
  status: "answered" | "vague";
  // Once the customer has used its one clarification after a vague answer, the
  // topic closes even if the follow-up response remained vague.
  clarificationUsed: boolean;
}

const FACTUAL_QUESTION_MARKERS: RegExp[] = [
  /\?/,
  /\b(?:what|which|how|can|could|does|do|did|is|are|will|would|has|have)\b/i,
];

const SPECIFIC_FACT_MARKERS: RegExp[] = [
  QUOTED_FACT_PATTERN,
  // A spoken range may have the unit only after the second figure, e.g.
  // "12,000 to 14,000 pounds." The quoted-fact pattern still sees the latter
  // figure, but naming the full range here makes the intended evidence clear.
  /\b\d[\d,]*(?:\.\d+)?\s*(?:to|-)\s*\d[\d,]*(?:\.\d+)?\s*(?:percent|%|miles|mpg|months?|weeks?|days?|hours?|pounds?|lbs|tons?|years?)\b/i,
  /^(?:yes|no)\b/i,
  /\b(?:yes|no),?\s+(?:it|we|that|they)\b/i,
  /\b(?:it|we|that|they)\s+(?:does|do|is|are|has|have|can|cannot|can'?t|doesn'?t|don'?t)\b/i,
  // A factual feature answer must actually name a feature after the verb. This
  // avoids counting "it has what you need" as a real answer.
  /\b(?:comes? with|includes?|is equipped with|has)\s+(?:the |a |an |standard |factory )?[a-z0-9][a-z0-9 -]{2,}\b/i,
];

const VAGUE_FACT_REPLY_MARKERS: RegExp[] = [
  /\b(?:not sure|don'?t know|do not know|not certain|hard to say)\b/i,
  /\b(?:need|have) to (?:check|confirm|verify|look up|find out|get)\b/i,
  /\b(?:let me|i can) (?:check|confirm|verify|look up|find out|get)\b/i,
  /\b(?:cannot|can'?t|unable to) (?:check|confirm|verify|say|tell|give)\b/i,
  /\b(?:it|that) (?:depends|varies|should be|might be|could be|probably)\b/i,
  /\b(?:generally|usually|typically|more or less|somewhere around)\b/i,
];

function subjectsOverlap(left: AskedSubject, right: AskedSubject): boolean {
  return left.keywords.some((keyword) => right.keywords.includes(keyword));
}

function isFactualCustomerQuestion(text: string): AskedSubject | null {
  if (!matchesAny(text, FACTUAL_QUESTION_MARKERS)) return null;
  return extractAskedSubject(text);
}

function isSpecificFactualAnswer(answer: string, subject: AskedSubject): boolean {
  const hasSpecificFact = matchesAny(answer, SPECIFIC_FACT_MARKERS);
  if (!hasSpecificFact) return false;

  const directBinaryReply =
    /^(?:yes|no)\b/i.test(answer.trim()) ||
    /\b(?:it|we|that|they)\s+(?:does|do|is|are|has|have|can|cannot|can'?t|doesn'?t|don'?t)\b/i.test(answer);
  return directBinaryReply || mentionsKeyword(answer, subject.keywords);
}

function isVagueFactualAnswer(answer: string, subject: AskedSubject): boolean {
  // A question-only discovery pivot is handled by the existing sequencing and
  // direct-question rules. It is not a vague factual answer that invites a
  // clarification loop.
  if (isSequencingRedirect(answer)) return false;
  if (answer.includes("?") && !matchesAny(answer, SPECIFIC_FACT_MARKERS)) return false;
  return matchesAny(answer, VAGUE_FACT_REPLY_MARKERS) || mentionsKeyword(answer, subject.keywords);
}

function deriveAnsweredCustomerQuestions(transcript: TranscriptMessage[]): AnsweredCustomerQuestionState[] {
  const tracked: AnsweredCustomerQuestionState[] = [];
  let pending: { entry: AnsweredCustomerQuestionState; subject: AskedSubject } | null = null;

  for (const message of transcript) {
    const text = message.content.trim();
    if (!text) continue;

    if (message.role === "customer") {
      const subject = isFactualCustomerQuestion(text);
      if (!subject) {
        pending = null;
        continue;
      }

      const existing = tracked.find((entry) => subjectsOverlap(entry, subject));
      if (existing) {
        if (existing.status === "vague") {
          existing.clarificationUsed = true;
          pending = { entry: existing, subject };
        } else {
          // This is precisely the loop we are preventing. The topic was already
          // concretely answered, so preserve that binding fact even if the
          // consultant's redundant reply merely says "like I said" and omits
          // the subject word.
          pending = null;
        }
      } else {
        const entry: AnsweredCustomerQuestionState = {
          label: subject.label,
          keywords: subject.keywords,
          question: text,
          answer: "",
          status: "vague",
          clarificationUsed: false,
        };
        tracked.push(entry);
        pending = { entry, subject };
      }
      continue;
    }

    if (!pending) continue;
    const { entry, subject } = pending;
    if (isSpecificFactualAnswer(text, subject)) {
      entry.answer = text;
      entry.status = "answered";
    } else if (isVagueFactualAnswer(text, subject)) {
      entry.answer = text;
      entry.status = "vague";
    } else {
      // The consultant neither answered the factual question nor gave the kind
      // of vague/dodging response this rule governs. Leave it to the existing
      // redirect/direct-question mechanisms rather than asserting a fact.
      tracked.splice(tracked.indexOf(entry), 1);
    }
    pending = null;
  }

  return tracked.filter((entry) => entry.answer.length > 0);
}

// ---------------------------------------------------------------------------
// The rep's most recent ask, and whether the customer owes it a direct answer.
//
// Everything above is CONVERSATION state: facts accumulated across the whole
// transcript that decide whether the conversation can reach an end. This is TURN
// state: it looks only at the rep's latest message and the customer line right
// before it, which is why it is derived and rendered separately rather than
// folded into ConversationState. A conversation with no live question produces
// no lines, exactly as before.
//
// The live failure: asked something specific, the customer answered with an
// unrelated concern or a non-answer, so a rep who did the skilled thing of
// narrowing a vague statement got vagueness back and the loop restarted. The
// prompt rules alone could not fix that, because a long transcript buries which
// message is the live question. Naming it explicitly, and quoting it, is what
// makes dodging impossible to justify.
// ---------------------------------------------------------------------------

// Splits on sentence terminators, keeping the terminator, so a question can be
// quoted back on its own instead of buried in the paragraph around it.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// A rep sentence that requests something without a question mark. Voice
// transcripts drop punctuation constantly, and "tell me what's on your mind" is
// as much a question as "what's on your mind?".
const IMPERATIVE_ASK_MARKERS: RegExp[] = [
  /\btell me\b/i,
  /\bwalk me through\b/i,
  /\bhelp me understand\b/i,
  /\bgive me a sense\b/i,
  /\bi(?:'d| would) (?:love|like) to (?:hear|know)\b/i,
  /\blet me know\b/i,
  // Hortative requests for information. "let's figure out exactly what you're
  // looking for" asks the customer for something just as much as "tell me what's
  // on your mind" does, and spoken redirects land in this form constantly. The
  // verb has to be about acquiring information now, which is what keeps "let's
  // come back to that" out: parking a topic is not asking for anything.
  /\blet'?s (?:figure out|find out|work out|dig into|go through|talk through|understand|hear)\b/i,
];

// The rep NARROWING: asking the customer to convert something general into a
// concrete one. This is the teachable rep skill the customer has to reward.
const NARROWING_MARKERS: RegExp[] = [
  /\bwhen you say\b[^?]{0,60}\bwhat\b/i,
  /\bwhat (?:specifically|exactly)\b/i,
  /\b(?:specifically|exactly) (?:what|which)\b/i,
  /\bspecifically\b[^?]{0,30}\b(?:concern|worr|mean|about)/i,
  /\bwhat does that (?:look like|mean)\b/i,
  /\bwhat kind of\b/i,
  /\bwhich (?:one|of those|is it|matters most|would)\b/i,
  /\bnarrow (?:it|that)\b/i,
  /\bbe (?:more )?specific\b/i,
  /\bwhat'?s on your mind\b/i,
  /\bis it\b[^?.!]{1,40}\bor\b/i,
];

// Lead-ins that make a comma-separated run read as a menu of choices rather than
// as ordinary clauses. Required alongside the commas so "Of course, nobody wants
// that, so what brings you in?" is not mistaken for an option list.
const OPTION_LEAD_IN = /\b(?:are you|is it|do you|would you|thinking|worried about|after|leaning|prefer|more of a)\b/i;

// "the transmission, the engine, the windows" / "economical, a hybrid, or fully
// electric": the rep has laid out the alternatives, so there is a specific
// available for the customer to pick. The comma is what separates a menu from a
// stray "or" ("two or three months from now" is not a list of choices).
function looksLikeOptionList(ask: string): boolean {
  if (!OPTION_LEAD_IN.test(ask)) return false;
  return /,\s*or\b/i.test(ask) || (ask.match(/,/g) ?? []).length >= 2;
}

// The customer answering in generalities. Only used to make the narrowing line
// concrete by quoting what was vague; a narrowing question still counts when
// this finds nothing.
const VAGUE_ANSWER_MARKERS: RegExp[] = [
  /\bjust (?:want|need|looking for|after)\b[^.!?]{0,30}\bsomething\b/i,
  /\bsomething (?:reliable|dependable|good|nice|decent|solid|safe|cheap|affordable|that works)\b/i,
  /\breliable\b/i,
  /\bdependable\b/i,
  /\bwon'?t break down\b/i,
  /\bgood on gas\b/i,
  /\bnothing (?:fancy|crazy|too)\b/i,
  /\bi don'?t (?:really )?know\b/i,
  /\bnot (?:really )?sure\b/i,
  /\ba good (?:deal|price|one)\b/i,
];

export interface DirectQuestionState {
  // The rep's ask sentences, quoted back verbatim.
  asks: string[];
  // True when the ask hands the customer a set of specifics to choose between,
  // or explicitly demands one.
  narrowing: boolean;
  // The customer's own general statement the narrowing responds to, if it was
  // one. Null when the customer's last line was already specific.
  vagueAnswer: string | null;
  // The topic the rep parked in this same message, if the customer had just
  // raised one that belongs elsewhere.
  redirectedTopic: string | null;
  // The subject, in the customer's own words, the rep proposed getting to later
  // in this same message while asking a discovery question of their own. Null
  // unless both halves of that are present.
  sequencedTopic: string | null;
}

function extractAsks(text: string): string[] {
  return splitSentences(text).filter(
    (s) => s.endsWith("?") || matchesAny(s, IMPERATIVE_ASK_MARKERS),
  );
}

// The live question the customer owes an answer to, or null when the rep's last
// message did not ask for anything (or the rep has not spoken yet).
export function deriveDirectQuestion(transcript: TranscriptMessage[]): DirectQuestionState | null {
  const spoken = transcript.filter((m) => m.content.trim().length > 0);
  const last = spoken.at(-1);
  // Only a question the rep has just asked is live. Once the customer has spoken
  // after it, that question has already had its turn.
  if (!last || last.role !== "consultant") return null;

  const text = last.content.trim();
  const asks = extractAsks(text);
  if (asks.length === 0) return null;

  const previous =
    spoken
      .slice(0, -1)
      .reverse()
      .find((m) => m.role === "customer")
      ?.content.trim() ?? "";

  const redirected =
    matchesAny(text, REDIRECT_MARKERS) && matchesAny(previous, ASK_MARKERS)
      ? (Object.keys(TOPIC_PATTERNS) as DeflectableTopic[]).find((topic) => mentionsTopic(previous, topic))
      : undefined;

  // Sequencing is only claimed on subjects Rule 2 does not already own, so the
  // two never both speak about the same ask.
  const sequenced =
    !redirected && matchesAny(previous, SOFT_ASK_MARKERS) && !isDepartmentTopic(previous) && isSequencingRedirect(text)
      ? extractAskedSubject(previous)
      : null;

  return {
    asks,
    narrowing: asks.some((ask) => matchesAny(ask, NARROWING_MARKERS) || looksLikeOptionList(ask)),
    vagueAnswer: matchesAny(previous, VAGUE_ANSWER_MARKERS) ? previous : null,
    redirectedTopic: redirected ? TOPIC_LABEL[redirected] : null,
    sequencedTopic: sequenced ? sequenced.label : null,
  };
}

// Renders the live ask as prompt lines. Empty array when there is no live ask, so
// a turn the rep did not end with a question is byte-identical to the previous
// behavior.
export function buildDirectQuestionLines(question: DirectQuestionState | null): string[] {
  if (!question) return [];
  const lines: string[] = [];
  const quoted = question.asks.map((a) => `"${a}"`).join(" ");

  lines.push(
    `- THE CONSULTANT JUST ASKED YOU SOMETHING DIRECTLY: ${quoted} Answering THAT is your job this turn. Your reply must contain a real, relevant answer to what they actually asked, in your own words. Do not reply with an unrelated concern, a non-answer, or a change of subject, and do not bounce the question back at them by asking them something instead. You can still be guarded about how much you give them, but stop after the relevant answer. Do not append a thought or question that starts a separate customer agenda.`,
  );
  lines.push(
    `- FINAL DIRECT-ANSWER CHECK: answer the named subject before anything else. If they ask about safety, explicitly address safety; if they ask about comfort, explicitly address comfort; if they ask new versus used, state which you prefer; if they ask budget, address budget. Do not replace that subject with your recurring opening request, price, reliability, or another motivation. A private motivation may add context only AFTER it has answered the question.`,
  );

  if (question.narrowing) {
    const vague = question.vagueAnswer
      ? ` You had been general with them ("${question.vagueAnswer}"), and they did the work of narrowing it down for you.`
      : "";
    lines.push(
      `- That question NARROWS things to a specific, and you must COMMIT to one.${vague} Name the concrete thing: the actual part, the actual situation, the actual number, the actual past experience that is behind your worry. Staying general a second time ("I just don't want any of those to happen") throws away what they just did and is the one answer you must not give here.`,
    );
  }

  if (question.redirectedTopic) {
    lines.push(
      `- You had asked about ${question.redirectedTopic}, and in this same message the consultant told you it is handled elsewhere or comes later, then steered you back to something they can work on now. Accept that redirect. Answer the question they just asked, and do not spend this turn pushing ${question.redirectedTopic} again.`,
    );
  }

  if (question.sequencedTopic) {
    lines.push(
      `- You had asked about ${question.sequencedTopic}, and in this same message the consultant proposed getting to it later, once they understand what you actually need, then asked you something to move that along. That is them doing their job well, not brushing you off. Accept it. Answer the question they just asked, in your own words and with real detail, and do not spend this turn asking about ${question.sequencedTopic} again.`,
    );
  }

  return lines;
}

export function deriveConversationState(transcript: TranscriptMessage[]): ConversationState {
  return {
    deflectedTopics: deriveDeflectedTopics(transcript),
    sequencedTopics: deriveSequencedTopics(transcript),
    decisionMaker: deriveDecisionMaker(transcript),
    alternativesRequests: countAlternativesRequests(transcript),
    alternativesRoundSpent: isAlternativesRoundSpent(transcript),
    acceptedSolutionLine: deriveAcceptedSolutionLine(transcript),
    quotedFacts: deriveQuotedFacts(transcript),
    answeredCustomerQuestions: deriveAnsweredCustomerQuestions(transcript),
    metNeed: deriveMetNeed(transcript),
  };
}

// Renders the derived state as prompt lines, to be appended to the per-turn state
// block. Returns an empty array when nothing was detected, so a conversation with
// none of these situations produces byte-identical prompts to the pre-change
// behavior.
export function buildConversationStateLines(state: ConversationState): string[] {
  const lines: string[] = [];

  for (const t of state.deflectedTopics) {
    if (t.closed) {
      lines.push(
        `- The consultant has now redirected ${t.label} away from this conversation ${t.redirectCount} times, which means it genuinely belongs to someone else. That topic is CLOSED. Do not raise it again in any form, do not hint at it, and do not treat it as an unresolved reason to hold back. Accept the redirect and put your attention on what the consultant is actually able to help you with.`
      );
    } else {
      lines.push(
        `- The consultant has redirected ${t.label} once, telling you it is handled elsewhere. The reactive-only rule means you should not raise it again on your own. This count is only a safety-net in case you already failed to follow that rule; if they redirect it again, it is closed for good and you must drop it permanently.`
      );
    }
  }

  for (const t of state.sequencedTopics) {
    if (t.closed) {
      lines.push(
        `- The consultant has now proposed handling ${t.label} later ${t.redirectCount} times, and they are right to sequence it that way. That topic is CLOSED for the rest of this conversation. Do not raise it again in any form, do not hint at it, and do not treat it as unfinished business that stops you engaging. Put your attention on the question they are actually asking you now.`
      );
    } else {
      lines.push(
        `- You asked about ${t.label} and the consultant proposed getting to it later, after they understand what you need. That is a reasonable way to run the conversation and you accept it. The reactive-only rule means you should not raise ${t.label} again on your own. This count is only a safety-net in case you already failed to follow that rule; if they sequence it again, it is closed for good and you must drop it permanently.`
      );
    }
  }

  if (state.decisionMaker) {
    lines.push(
      `- The consultant already asked who makes and funds this decision ("${state.decisionMaker.question}") and you answered: "${state.decisionMaker.answer}". That answer is now FIXED and you must honor it for the rest of the conversation. Do not contradict it, do not walk it back, and above all do not suddenly produce some other absent person whose approval is needed as a new reason you cannot move forward. If someone else is genuinely part of this, your answer above was where you said so.`
    );
  }

  if (state.alternativesRoundSpent) {
    lines.push(
      `- You have already asked to see other options and the consultant has answered you. That was your one alternatives round and it is spent. Do not ask "what else do you have" again in any wording, and do not restart discovery into a fresh round of choices. Take their honest answer at face value: either work with what is in front of you or say plainly that none of it fits.`
    );
  }

  if (state.acceptedSolutionLine) {
    lines.push(
      `- You have ALREADY said the proposed solution fits you ("${state.acceptedSolutionLine}"). That means this conversation is allowed to end, and your job now is to let it. Do not invent a new requirement, a new objection, or a new demand in order to keep it going. Wrap up the way a real person does: confirm what you understood, raise at most the ONE thing that is genuinely still open for you if there is one (for example that another person still has to see it), and let the consultant close things out.`
    );
  }

  for (const question of state.answeredCustomerQuestions) {
    if (question.status === "answered") {
      lines.push(
        `- You asked a factual question about ${question.label} ("${question.question}"), and the consultant gave you a specific, on-topic answer: "${question.answer}" That question is ANSWERED AND CLOSED. Accept it with a brief natural reaction if you reply to it (for example, "Okay, that helps" or "Got it"), then return to reacting to the subject the consultant leads next. Do NOT ask another version of ${question.label}, do not ask for the same fact again with different wording, and do not act as though you did not hear the answer.`
      );
    } else if (question.clarificationUsed) {
      lines.push(
        `- You asked about ${question.label}, and the consultant's response was vague or non-specific: "${question.answer}" You already used your ONE fair clarification on this factual point. Do not ask it again in any wording. Acknowledge the limitation if it matters, then keep responding to the subject the consultant leads or make your decision from what you have. Repeating a vague factual question over and over is not normal conversation.`
      );
    } else {
      lines.push(
        `- You asked about ${question.label}, but the consultant's response was vague or non-specific: "${question.answer}" If the consultant's current message is that vague response, you may make ONE concise clarification directly about it. Do not use it to start a separate topic. If the next response is still vague, acknowledge it and keep responding to the subject the consultant leads rather than repeating the question again.`
      );
    }
  }

  if (state.metNeed) {
    const { statement, statedAmount, quote, quotedAmount, gapClosed } = state.metNeed;
    const gapNote = gapClosed
      ? ` It came in at ${formatAmount(quotedAmount)}, a difference of ${formatAmount(quotedAmount - statedAmount)}, and they said they would absorb that themselves, so you are at your number.`
      : ` It came in at ${formatAmount(quotedAmount)}, which is inside the number you gave them.`;
    lines.push(
      `- You told the consultant your number ("${statement}", which is ${formatAmount(statedAmount)}), and they have now come back with it: "${quote}".${gapNote} THAT NEED IS MET. Acknowledge it plainly when that is responsive to the current message. Do not argue about it, do not haggle over the remainder, and never say or suggest that they missed your number or did not listen, because they did exactly what you asked. Keep any other concern internal unless the consultant's current message creates a genuine relevant opening.`
    );
  }

  if (state.quotedFacts.length > 0) {
    lines.push(
      "- Concrete numbers and answers the consultant has ALREADY given you. You know these. Never ask for any of them again as though you had not heard them; react to them instead:"
    );
    for (const fact of state.quotedFacts) lines.push(`  - "${fact}"`);
  }

  return lines;
}

// The normal state line says a factual subject is closed in the customer's own
// words. A small number of product questions name one practical capability with
// several interchangeable surface forms, though: "towing package", "tow
// rating", and "features for towing" are not three independent discovery
// topics. The live model was rationalizing its way around the general closure
// instruction by picking one of those neighboring forms. This deliberately
// narrow detector is only used to make the prompt's final gate concrete; it
// does not change which questions are considered answered.
function isTowingCapabilityQuestion(question: AnsweredCustomerQuestionState): boolean {
  return /\b(?:towing|tow|trailer|hauling)\s+(?:package|capacity|rating|range|feature|features|option|options|configuration|configurations|spec|specs|specification|specifications|performance)\b/i.test(
    question.question,
  ) || /\b(?:towing|tow)\s+(?:package|capacity|rating|range)\b/i.test(question.label);
}

// A final, volatile-tail gate rather than another stable-prefix aspiration. It
// sits immediately before generation, after both the transcript and the
// ordinary state recap, so it is difficult to overlook or reinterpret when a
// persona is inclined to "push for specifics." It only applies to questions
// proven answered by deriveAnsweredCustomerQuestions.
export function buildFinalAnsweredQuestionGate(state: ConversationState): string[] {
  const closed = state.answeredCustomerQuestions.filter((question) => question.status === "answered");
  if (closed.length === 0) return [];

  const lines = [
    "- FINAL ANSWERED-QUESTION GATE — apply this immediately before writing your line. A factual question listed below has already received a specific answer. You may briefly acknowledge it, but your reply MUST NOT contain a question seeking that fact, a detail/subpart of it, an explanation of it, or a differently worded version of it. Do not turn a closed question into a supposedly new question by starting with \"what about\", \"can you tell me\", \"does it have\", \"what comes with\", or \"how much\".",
  ];

  for (const question of closed) {
    lines.push(
      `  - CLOSED FACT: ${question.label}. The answer you already received is "${question.answer}". Treat every narrower, broader, or rephrased request for that same fact as CLOSED too.`,
    );
    if (isTowingCapabilityQuestion(question)) {
      lines.push(
        "  - TOWING-CAPABILITY BOUNDARY: towing capacity/rating/range, the towing package, towing features/options/configurations/specifications, trailer or hauling performance, and stability/control while towing are ONE closed practical subject here. They are not separate follow-ups. Do NOT ask, for example, \"What comes with the towing package?\", \"What towing features or specs does it have?\", \"How does it perform with a load?\", or \"What helps with stability when towing?\" Acknowledge the stated range and continue responding only to what the consultant leads next.",
      );
    }
  }
  return lines;
}

function questionContexts(text: string): string[] {
  // Keep the check scoped to what the customer is actually asking. A line such
  // as "I use it for hauling; what is the fuel economy?" should not be rejected
  // merely because its explanatory sentence contains "hauling."
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.flatMap((sentence, index) =>
    sentence.includes("?") ? [[sentences[index - 1], sentence].filter(Boolean).join(" ")] : [],
  );
}

function isTowingCapabilityRepeat(question: string): boolean {
  const lower = question.toLowerCase();
  // "Fuel economy when not towing" is an independent concern. The other
  // patterns are capability/package variants explicitly closed by the prompt
  // boundary above.
  if (/\b(?:not|without)\s+towing\b/.test(lower)) return false;
  return (
    /\b(?:payload|trailer|trailering)\b/.test(lower) ||
    /\b(?:towing|tow|hauling|haul)\b[\s\S]{0,80}\b(?:package|capacity|rating|range|feature|option|configuration|spec|performance|perform|handle|load|stability|control|ride quality|comfort)\b/.test(lower) ||
    /\b(?:package|capacity|rating|range|feature|option|configuration|spec|performance|perform|handle|load|stability|control|ride quality|comfort)\b[\s\S]{0,80}\b(?:towing|tow|hauling|haul)\b/.test(lower)
  );
}

// Deterministic backstop for the final prompt gate. The model still writes the
// response; this function only recognizes a question that the transcript
// already proves is closed so the caller can request one clean revision instead
// of allowing an intermittent prompt-adherence miss to reach the trainee.
export function repeatsClosedAnsweredQuestion(state: ConversationState, reply: string): boolean {
  const closed = state.answeredCustomerQuestions.filter((question) => question.status === "answered");
  if (closed.length === 0) return false;
  const questions = questionContexts(reply);

  return closed.some((closedQuestion) =>
    questions.some((question) => {
      if (isTowingCapabilityQuestion(closedQuestion) && isTowingCapabilityRepeat(question)) return true;
      const subject = extractAskedSubject(question);
      return subject ? subject.keywords.some((keyword) => closedQuestion.keywords.includes(keyword)) : false;
    }),
  );
}
