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
//   Rule 2  Has the rep already redirected this topic away twice? -> stop asking.
//   Rule 3  Which concrete numbers/answers has the rep already given? -> never
//           ask for them again.
//   Rule 4  Has the rep established who decides and pays? -> honor it, and never
//           spring a brand-new absent decision maker as a blocker.
//   Rule 5  Has the customer already had its one "what else do you have" round?
//   Rule 6  Has the customer already accepted a proposed solution? -> the
//           conversation is allowed to conclude instead of growing new demands.
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
const TOPIC_PATTERNS: Record<DeflectableTopic, RegExp[]> = {
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

// Number of rep redirects on the SAME topic after which the customer must drop
// it entirely. The spec allows exactly one more ask after the first redirect, so
// the second redirect closes the topic.
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
const PROPOSAL_MARKERS: RegExp[] = [
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
const QUOTED_FACT_PATTERN = /(\$\s?[\d,]+(?:\.\d{2})?|\b\d[\d,]*(?:\.\d+)?\s*(?:percent|%|miles|mpg|months?|weeks?|days?|years?|bedrooms?|baths?|square feet|sq ?ft)\b)/i;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function mentionsTopic(text: string, topic: DeflectableTopic): boolean {
  return matchesAny(text, TOPIC_PATTERNS[topic]);
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

export interface ConversationState {
  deflectedTopics: DeflectedTopicState[];
  decisionMaker: DecisionMakerState | null;
  // How many separate times the customer has asked to be shown other options.
  alternativesRequests: number;
  // True once the customer has already had its one alternatives round answered.
  alternativesRoundSpent: boolean;
  // The customer's own line accepting a proposed solution, if any.
  acceptedSolutionLine: string | null;
  // Concrete figures the rep has already provided.
  quotedFacts: string[];
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

export function deriveConversationState(transcript: TranscriptMessage[]): ConversationState {
  return {
    deflectedTopics: deriveDeflectedTopics(transcript),
    decisionMaker: deriveDecisionMaker(transcript),
    alternativesRequests: countAlternativesRequests(transcript),
    alternativesRoundSpent: isAlternativesRoundSpent(transcript),
    acceptedSolutionLine: deriveAcceptedSolutionLine(transcript),
    quotedFacts: deriveQuotedFacts(transcript),
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
        `- The consultant has redirected ${t.label} once, telling you it is handled elsewhere. You may raise it at most ONE more time. If they redirect it again, it is closed for good and you must drop it permanently.`
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

  if (state.quotedFacts.length > 0) {
    lines.push(
      "- Concrete numbers and answers the consultant has ALREADY given you. You know these. Never ask for any of them again as though you had not heard them; react to them instead:"
    );
    for (const fact of state.quotedFacts) lines.push(`  - "${fact}"`);
  }

  return lines;
}
