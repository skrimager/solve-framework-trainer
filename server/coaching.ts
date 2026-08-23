import { createHash } from "node:crypto";
import type { TranscriptMessage } from "@shared/schema";
import {
  ACCEPTED_SOLUTION_RULES,
  GRACEFUL_RELEASE_RULES,
  SPEAKER_ATTRIBUTION_RULES,
  STALL_DIAGNOSIS_RULES,
  TIMING_FEEDBACK_RULES,
  TRANSCRIPT_FIDELITY_RULES,
  renderTranscriptForScoring,
  sharedModelResponder,
  transcriptHeaderForScoring,
} from "./llm";
import { buildStallActionGroundingBlock, buildTimingGroundingBlock, numberedTurns } from "./feedbackGrounding";

// Mirrors llm.ts cacheKeyForPrefix — routes turns that share the same stable
// prefix (same session's feedback/transcript context) to the same cache.
function cacheKeyForPrefix(stablePrefix: string): string {
  return createHash("sha256").update(stablePrefix).digest("hex").slice(0, 32);
}

// One turn in the trainee <-> SOLVE Coach follow-up thread.
export type CoachingThreadMessage = { role: "trainee" | "coach"; content: string };

export type CoachingPromptParams = {
  track: string; // 'consulting' | 'leadership' — which rubric framing to coach from
  feedback: string; // the narrative rubric feedback already shown for this attempt
  rubricScoresJson: string | null; // per-dimension scores JSON (as stored on the session)
  overallScore: number | null; // 0-100 overall for this attempt
  transcript: TranscriptMessage[]; // the trainee's actual scenario transcript
  thread: CoachingThreadMessage[]; // prior Q&A turns for THIS attempt (oldest-first)
  question: string; // the trainee's new follow-up question / pushback
  // Set only for dedicated Stall & Excuse Handling scenarios. The existing
  // persisted coaching thread then becomes the current-conversation memory for
  // adjudicated corrections; no cross-session training is implied.
  stallType?: string | null;
};

// The SOLVE Coach persona + rules. This is the byte-stable system block that
// leads every coaching prompt. It encodes the three product requirements that
// can't be left to the model's defaults:
//   1. Redundancy awareness — recognize when the trainee is re-asking the same
//      thing or the thread is going in circles, and redirect them to practice
//      live in another scenario rather than re-explaining endlessly.
//   2. Conditional transcript access — the Coach HAS the trainee's transcript
//      and should quote specific lines when the question calls for it, but should
//      answer general "why does this matter" questions from the framework without
//      forcing quotes in.
//   3. Discovery-training language only — never "sales" or "AI roleplay" framing.
export const COACHING_SYSTEM = `You are SOLVE Coach, a warm, encouraging discovery-training coach. A trainee has just finished a discovery-training scenario and read their rubric feedback. Now they can ask you follow-up questions or push back on the feedback, and you answer conversationally like a supportive human coach in a one-on-one debrief.

Ground rules (follow every turn):
- This is discovery-training / discovery-architecture practice. Coach uncovering real needs, building trust, and understanding — never persuasion or pressure tactics. NEVER use the words "sales", "selling", or "AI roleplay"; talk about discovery, conversations, and practice scenarios instead.
- Keep replies short and conversational — usually two to four sentences. This is a debrief chat, not an essay.
- Be specific and diagnostic. Tie your coaching to the discovery framework the trainee is being scored on (uncovering the real underlying need, preventing objections through early discovery, building trust independent of the outcome, natural next steps in the client's own words, and preserving the relationship).

${SPEAKER_ATTRIBUTION_RULES}

${TRANSCRIPT_FIDELITY_RULES}

${TIMING_FEEDBACK_RULES}

${ACCEPTED_SOLUTION_RULES}

${GRACEFUL_RELEASE_RULES}

${STALL_DIAGNOSIS_RULES}

STALL AND OBJECTION DEBRIEFS: When a trainee asks about a stall, excuse, objection, price comparison, or unconsulted stakeholder, coach the diagnostic process from the shared rule above. Ground the advice in the actual transcript and the exact SOLVE moment where it appeared, whether that was during discovery or near an ending. Help the trainee make the customer a better decision-maker, not simply push for agreement.

Using the transcript (important, be judgment-based):
- You have the trainee's actual scenario transcript available below. Use it CONDITIONALLY. When the trainee's question is about what they actually said or how they could have phrased something ("what did I say", "how could I have asked that", "give me a better way to word X", before/after rewrites), quote or closely paraphrase the specific lines from their transcript and offer a concrete rewrite.
- When the question is general ("why does discovery matter", "what does trust-building mean"), answer from the framework and their feedback. Do NOT force transcript quotes in where they don't help.
- The rubric feedback above was written by the scorer, not by you, and it can contain a claim the transcript does not support. When the trainee pushes back on one ("I did ask about that, and early"), check the transcript and the timing pre-check before you answer. If they are right, say so plainly, drop the point, and coach them on something real instead of defending the feedback. Never restate a timing claim the pre-check contradicts, even to soften it.
- For dedicated stall debriefs, the current coaching thread may contain a prior correction after the trainee successfully challenged advice. Treat that correction as the settled context for this conversation: do not repeat the disproven claim later in the thread. This is conversation-level memory only, not permanent training or a claim about future sessions.

Recognizing when to redirect (important — use your own judgment, no rigid counter):
- You are not limited in how many questions you'll answer, but watch for the conversation losing value. If the trainee is re-asking something you've already covered (even reworded), or the thread has run long without new substance, or they seem to be looking for reassurance rather than a new insight, gently say so and redirect: the fastest way to improve now is to run another practice scenario and apply this live, rather than keep talking it through. Suggest that warmly, in your own words — don't lecture, and don't refuse to answer, just steer them toward practicing.`;

// Builds the full coaching prompt. STABLE-PREFIX-FIRST like llm.ts: the system
// block + this attempt's feedback/scores/transcript (invariant across the
// thread's turns) lead, then the volatile Q&A thread + newest question last, so
// the stable prefix stays cacheable turn to turn.
export function buildCoachingStablePrefix(params: CoachingPromptParams): string {
  const { track, feedback, rubricScoresJson, overallScore, transcript } = params;
  const trackLabel =
    track === "leadership" ? "conflict-management / de-escalation" : "discovery-architecture";
  // Same numbered, explicitly-labeled rendering the rubric scorer uses, so the
  // Coach cannot mistake a customer line for something the trainee said.
  const rendered = renderTranscriptForScoring(transcript, {
    customer: "CUSTOMER",
    consultant: "TRAINEE",
  });
  const transcriptText = rendered
    ? `${transcriptHeaderForScoring(transcript)}\n${rendered}`
    : "(no transcript recorded)";
  const scoresLine =
    overallScore !== null ? `Overall score: ${overallScore}/100.` : "Overall score: (not scored).";
  const rubricLine = rubricScoresJson ? `Per-dimension scores (JSON): ${rubricScoresJson}` : "";

  // What the transcript actually contains on the topics the Coach gives timing
  // advice about, so a "you should have raised that earlier" answer cannot
  // contradict the trainee's own conversation. Empty for an empty transcript.
  const timingGrounding = buildTimingGroundingBlock(transcript, "TRAINEE");
  const stallActionGrounding = params.stallType
    ? buildStallActionGroundingBlock(transcript, "TRAINEE")
    : "";

  return [
    COACHING_SYSTEM,
    `This was a ${trackLabel} scenario.`,
    `${scoresLine}${rubricLine ? `\n${rubricLine}` : ""}`,
    `Rubric feedback the trainee already saw:\n${feedback || "(no narrative feedback recorded)"}`,
    `The trainee's scenario transcript (reference it only when the question calls for it):\n${transcriptText}`,
    timingGrounding,
    stallActionGrounding,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function buildCoachingPrompt(params: CoachingPromptParams): string {
  const stablePrefix = buildCoachingStablePrefix(params);
  const threadText = params.thread
    .map((m) => `${m.role === "trainee" ? "Trainee" : "SOLVE Coach"}: ${m.content}`)
    .join("\n");
  const volatile = `Conversation so far:\n${threadText || "(this is the trainee's first follow-up)"}\n\nTrainee's new question:\n${params.question}\n\nRespond as SOLVE Coach with your next reply only — no labels, no narration.`;
  return `${stablePrefix}\n\n${volatile}`;
}

// Injectable responder so route tests can exercise the flow without hitting the
// network; production defaults to the shared OpenAI client (same call shape as
// llm.ts: client.responses.create -> output_text).
export type CoachingResponder = (input: string, cacheKey: string) => Promise<string>;

const defaultCoachingResponder: CoachingResponder = async (input, cacheKey) => {
  // Coach must use the identical credential-aware client path as scoring. This
  // matters for secure proxy credentials that authorize scoreTranscript but do
  // not support an independently constructed OpenAI client.
  return sharedModelResponder(input, cacheKey);
};

export type StallChallengeOutcome = "accepted" | "defensible" | "ambiguous" | "not_a_challenge";

// AI decides the semantic disposition; application code validates referenced
// evidence and renders the learner-facing reply, so unsupported free-form
// critiques cannot reappear after a valid concession.
export type StallChallengeDecision = {
  outcome: StallChallengeOutcome;
  coveredTraineeTurns: number[];
  laterCustomerEvidenceTurn: number | null;
  evidenceTerms: string[];
  narrowerGap: string | null;
  ambiguity: string | null;
  // Set only by the neutral verifier for accepted/defensible outcomes.
  noLaterEvidenceSupportsNarrower: boolean | null;
};

export type StallChallengeTraceStep = {
  stage: "initial" | "neutral_initial" | "correction" | "neutral_correction";
  raw: string;
  decision: StallChallengeDecision | null;
  failures: StallChallengeFailure[];
};

export type CoachingReplyOptions = {
  // Debug-only harness hook. Production routes do not pass it; it never
  // persists model raw output. The harness receives sanitized, bounded text.
  onStallTrace?: (step: StallChallengeTraceStep) => void;
};

export const STALL_CHALLENGE_ADJUDICATION_INSTRUCTION = `STALL COACHING STRUCTURED CHALLENGE DECISION:
Use semantic judgment to compare the trainee's new message, original feedback, prior coaching thread, numbered transcript, and STALL ACTION PRE-CHECK. Return a structured decision only; the application renders the final reply.
- accepted: use when the challenge is true and the challenged advice is materially equivalent to a covered action. List exact coveredTraineeTurns. Do NOT provide a narrower gap, later evidence, or a replacement critique; the application will concede and withdraw the recommendation.
- defensible: use only when the original advice is meaningfully narrower/different. List exact coveredTraineeTurns, a precise narrowerGap, a later CUSTOMER evidence turn, and 1-4 exact evidenceTerms from that customer turn. Generic "keep digging" or a paraphrase of the covered question is invalid.
- ambiguous: use only when transcript evidence is genuinely insufficient; explain the specific uncertainty in ambiguity.
- not_a_challenge: use for an ordinary follow-up, with any directly relevant covered turn if one helps.
Return ONLY JSON: {"outcome":"accepted"|"defensible"|"ambiguous"|"not_a_challenge","coveredTraineeTurns":number[],"laterCustomerEvidenceTurn":number|null,"evidenceTerms":string[],"narrowerGap":string|null,"ambiguity":string|null,"noLaterEvidenceSupportsNarrower":null}.`;

export function buildStallChallengeAdjudicationPrompt(params: CoachingPromptParams): string {
  return `${buildCoachingPrompt(params)}\n\n${STALL_CHALLENGE_ADJUDICATION_INSTRUCTION}`;
}

function extractCoachJson(raw: string): Record<string, unknown> {
  const text = raw.replace(/```(?:json)?/gi, "");
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaping) escaping = false;
        else if (char === "\\") escaping = true;
        else if (char === "\"") inString = false;
      } else if (char === "\"") inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("Stall challenge adjudicator did not return a valid top-level JSON object");
}

function parseStallChallengeDecision(raw: string): StallChallengeDecision {
  const parsed = extractCoachJson(raw);
  const outcomes: StallChallengeOutcome[] = ["accepted", "defensible", "ambiguous", "not_a_challenge"];
  if (
    !outcomes.includes(parsed.outcome as StallChallengeOutcome) ||
    !(parsed.coveredTraineeTurns === undefined || Array.isArray(parsed.coveredTraineeTurns)) ||
    !(parsed.laterCustomerEvidenceTurn === null || Number.isInteger(parsed.laterCustomerEvidenceTurn)) ||
    !(parsed.evidenceTerms === undefined || Array.isArray(parsed.evidenceTerms) || typeof parsed.evidenceTerms === "string") ||
    !(parsed.narrowerGap === null || typeof parsed.narrowerGap === "string") ||
    !(parsed.ambiguity === null || typeof parsed.ambiguity === "string") ||
    !(parsed.noLaterEvidenceSupportsNarrower === undefined || parsed.noLaterEvidenceSupportsNarrower === null || typeof parsed.noLaterEvidenceSupportsNarrower === "boolean")
  ) throw new Error("Stall challenge adjudicator returned an invalid decision shape");
  return {
    outcome: parsed.outcome as StallChallengeOutcome,
    coveredTraineeTurns: (parsed.coveredTraineeTurns as number[] | undefined) ?? [],
    laterCustomerEvidenceTurn: (parsed.laterCustomerEvidenceTurn as number | null) ?? null,
    evidenceTerms:
      typeof parsed.evidenceTerms === "string"
        ? [parsed.evidenceTerms]
        : ((parsed.evidenceTerms as string[] | undefined) ?? []),
    narrowerGap: (parsed.narrowerGap as string | null) ?? null,
    ambiguity: (parsed.ambiguity as string | null) ?? null,
    noLaterEvidenceSupportsNarrower:
      (parsed.noLaterEvidenceSupportsNarrower as boolean | null | undefined) ?? null,
  };
}

type StallChallengeFailure = { field: string; reason: string };
const GENERIC_GAP = /^(?:keep digging|dig deeper|more detail|more specific|further exploration)\.?$/i;

function normalizedTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hasNormalizedPhrase(haystack: string, phrase: string): boolean {
  const haystackTokens = normalizedTokens(haystack);
  const phraseTokens = normalizedTokens(phrase);
  if (phraseTokens.length === 0) return false;
  return haystackTokens.some((_, start) =>
    phraseTokens.every((token, offset) => haystackTokens[start + offset] === token),
  );
}

// A model sometimes labels a challenge "accepted" while simultaneously naming
// a later customer turn and concrete evidence terms. That is semantically
// contradictory: the model has identified material for a narrower, still-useful
// follow-up. Normalize the label before validation rather than allowing it to
// become an over-concession.
function normalizeContradictoryAcceptedDecision(
  decision: StallChallengeDecision,
  transcript: TranscriptMessage[],
): StallChallengeDecision {
  if (decision.outcome !== "accepted" || decision.laterCustomerEvidenceTurn === null || decision.evidenceTerms.length === 0) {
    return decision;
  }
  const customer = numberedTurns(transcript).find(
    (turn) => turn.turn === decision.laterCustomerEvidenceTurn && turn.role === "customer",
  );
  const terms = decision.evidenceTerms.map((term) => term.trim()).filter(Boolean);
  if (!customer || !terms.every((term) => hasNormalizedPhrase(customer.text, term))) return decision;
  return {
    ...decision,
    outcome: "defensible",
    noLaterEvidenceSupportsNarrower: false,
  };
}

function deriveConservativeNarrowerDecision(
  decision: StallChallengeDecision,
  transcript: TranscriptMessage[],
): StallChallengeDecision | null {
  const normalized = normalizeContradictoryAcceptedDecision(decision, transcript);
  if (
    normalized.outcome !== "defensible" ||
    normalized.coveredTraineeTurns.length === 0 ||
    normalized.laterCustomerEvidenceTurn === null ||
    normalized.evidenceTerms.length === 0
  ) {
    return null;
  }
  const terms = normalized.evidenceTerms.map((term) => term.trim()).filter(Boolean);
  const focus = terms.join(" and ");
  const constrained: StallChallengeDecision = {
    ...normalized,
    narrowerGap:
      normalized.narrowerGap && !GENERIC_GAP.test(normalized.narrowerGap.trim())
        ? normalized.narrowerGap
        : `how the customer's cited ${focus} affect the concern`,
    noLaterEvidenceSupportsNarrower: false,
  };
  return validateStallChallengeDecision(constrained, transcript, true).length === 0 ? constrained : null;
}

function validateStallChallengeDecision(
  decision: StallChallengeDecision,
  transcript: TranscriptMessage[],
  requireNeutralVerification: boolean = false,
): StallChallengeFailure[] {
  const turns = numberedTurns(transcript);
  const failures: StallChallengeFailure[] = [];
  const covered = decision.coveredTraineeTurns.map((n) => turns.find((turn) => turn.turn === n));
  if (covered.some((turn) => !turn || turn.role !== "consultant")) failures.push({ field: "coveredTraineeTurns", reason: "must cite real trainee turns" });

  if (decision.outcome === "accepted") {
    if (decision.coveredTraineeTurns.length === 0) failures.push({ field: "coveredTraineeTurns", reason: "accepted must cite the disproving turn" });
    if (decision.narrowerGap || decision.laterCustomerEvidenceTurn !== null || decision.evidenceTerms.length > 0) failures.push({ field: "accepted", reason: "accepted cannot append a replacement critique" });
    if (requireNeutralVerification && decision.noLaterEvidenceSupportsNarrower === false) failures.push({ field: "noLaterEvidenceSupportsNarrower", reason: "accepted conflicts with neutral later-evidence finding" });
    return failures;
  }
  if (decision.outcome === "defensible") {
    if (decision.coveredTraineeTurns.length === 0) failures.push({ field: "coveredTraineeTurns", reason: "defensible must acknowledge covered action" });
    if (!decision.narrowerGap || GENERIC_GAP.test(decision.narrowerGap.trim())) failures.push({ field: "narrowerGap", reason: "must name a precise narrower gap" });
    const customer = turns.find((turn) => turn.turn === decision.laterCustomerEvidenceTurn);
    if (!customer || customer.role !== "customer" || !covered.some((turn) => turn && customer.turn > turn.turn)) failures.push({ field: "laterCustomerEvidenceTurn", reason: "must cite a later customer turn" });
    const terms = decision.evidenceTerms.map((term) => term.toLowerCase().trim()).filter(Boolean);
    if (terms.length < 1 || terms.length > 4 || !customer || !terms.every((term) => hasNormalizedPhrase(customer.text, term))) failures.push({ field: "evidenceTerms", reason: "must quote normalized terms from later customer evidence" });
    if (decision.narrowerGap && terms.length > 0 && !terms.some((term) => hasNormalizedPhrase(decision.narrowerGap!, term))) failures.push({ field: "narrowerGap", reason: "must be grounded in evidence terms" });
    if (requireNeutralVerification && decision.noLaterEvidenceSupportsNarrower === true) failures.push({ field: "noLaterEvidenceSupportsNarrower", reason: "defensible conflicts with neutral no-later-evidence finding" });
    return failures;
  }
  if (decision.outcome === "ambiguous" && (!decision.ambiguity || !decision.ambiguity.trim())) failures.push({ field: "ambiguity", reason: "must state the specific uncertainty" });
  return failures;
}

export const NEUTRAL_STALL_CHALLENGE_VERIFICATION_INSTRUCTION = `NEUTRAL STALL CHALLENGE VERIFICATION:
Independently verify the proposed accepted/defensible challenge decision against the original recommendation, trainee challenge, numbered transcript, STALL ACTION PRE-CHECK, and CUSTOMER turns after the covered trainee action. Do not defer to the trainee or prior decision.
- Return accepted ONLY if no later customer evidence supports a genuinely narrower, still-useful version of the challenged coaching. Set noLaterEvidenceSupportsNarrower true.
- Return defensible when a later CUSTOMER turn names a distinct unresolved dimension. Cite the covered trainee turn, exact later customer turn, exact evidence terms, and precise narrowerGap. Set noLaterEvidenceSupportsNarrower false.
Return the same structured decision JSON shape, with no free-form reply.`;

function buildNeutralStallChallengeVerificationPrompt(
  params: CoachingPromptParams,
  proposed: StallChallengeDecision,
): string {
  return `${buildStallChallengeAdjudicationPrompt(params)}\n\n${NEUTRAL_STALL_CHALLENGE_VERIFICATION_INSTRUCTION}\n\nPROPOSED DECISION:\n${JSON.stringify(proposed)}`;
}

function renderStallChallengeDecision(decision: StallChallengeDecision, transcript: TranscriptMessage[]): string {
  const turns = numberedTurns(transcript);
  const covered = decision.coveredTraineeTurns
    .map((turn) => turns.find((item) => item.turn === turn))
    .filter((turn): turn is NonNullable<typeof turn> => Boolean(turn));
  const cited = covered.map((turn) => `turn ${turn.turn}: "${turn.text}"`).join("; ");
  if (decision.outcome === "accepted") return `You're right — ${cited}. I withdraw that recommendation because you had already covered that action.`;
  if (decision.outcome === "defensible") {
    const customer = turns.find((turn) => turn.turn === decision.laterCustomerEvidenceTurn)!;
    return `You did cover this at ${cited}. I would still hold the narrower focus on ${decision.narrowerGap}, because at turn ${customer.turn} the customer said "${customer.text}".`;
  }
  if (decision.outcome === "ambiguous") return `The transcript supports ${cited || "part of your point"}, but ${decision.ambiguity}. I would avoid drawing a firmer conclusion without that missing detail.`;
  return covered.length ? `At ${cited}, you gave the conversation a useful foundation. Let’s keep the next step tied to what the customer said there.` : "Let’s keep the next step tied to the specific concern the customer named in the transcript.";
}

function safeStallChallengeDecision(params: CoachingPromptParams): StallChallengeDecision {
  // Never over-concede on a malformed decision: neutral verification is the
  // only path that may render accepted. The safe fallback is explicitly
  // ambiguous and asks the trainee to rely on the documented transcript.
  return {
    outcome: "ambiguous",
    coveredTraineeTurns: [],
    laterCustomerEvidenceTurn: null,
    evidenceTerms: [],
    narrowerGap: null,
    ambiguity: "the structured review could not verify whether later customer evidence supports a narrower coaching point",
    noLaterEvidenceSupportsNarrower: null,
  };
}

function buildStallChallengeCorrectionPrompt(params: CoachingPromptParams, failed: StallChallengeDecision | null, failures: StallChallengeFailure[]): string {
  return `${buildStallChallengeAdjudicationPrompt(params)}\n\nYour prior decision failed validation: ${JSON.stringify(failures)}. Return a corrected structured decision only. For accepted, cite the covered trainee turn and do not add a critique. For defensible, include exact covered and later customer evidence. Prior decision: ${JSON.stringify(failed)}`;
}

export async function getCoachingReply(
  params: CoachingPromptParams,
  responder: CoachingResponder = defaultCoachingResponder,
  options: CoachingReplyOptions = {},
): Promise<string> {
  // Dedicated stall sessions use the same existing model responder, but with a
  // structured semantic-adjudication instruction. The normal route persists the
  // trainee challenge and returned correction in coaching_messages, so the
  // correction remains available in this current session's later thread turns.
  if (params.stallType) {
    const input = buildStallChallengeAdjudicationPrompt(params);
    const cacheKey = cacheKeyForPrefix(`${buildCoachingStablePrefix(params)}\n\n${STALL_CHALLENGE_ADJUDICATION_INSTRUCTION}`);
    const sanitizeRaw = (raw: string) => raw.replace(/\s+/g, " ").trim().slice(0, 2400);
    const request = async (
      stage: StallChallengeTraceStep["stage"],
      prompt: string,
      key: string,
      requireNeutralVerification: boolean = false,
    ) => {
      let raw = "";
      try {
        raw = await responder(prompt, key);
        const decision = normalizeContradictoryAcceptedDecision(
          parseStallChallengeDecision(raw),
          params.transcript,
        );
        const failures = validateStallChallengeDecision(decision, params.transcript, requireNeutralVerification);
        options.onStallTrace?.({ stage, raw: sanitizeRaw(raw), decision, failures });
        return { decision, failures };
      } catch (error) {
        const result = {
          decision: null,
          failures: [{ field: "response", reason: error instanceof Error ? error.message : String(error) }],
        };
        options.onStallTrace?.({ stage, raw: sanitizeRaw(raw), ...result });
        return result;
      }
    };
    const neutralVerify = async (decision: StallChallengeDecision) => {
      if (decision.outcome !== "accepted" && decision.outcome !== "defensible") {
        return { decision, failures: [] as StallChallengeFailure[] };
      }
      return request(
        "neutral_initial",
        buildNeutralStallChallengeVerificationPrompt(params, decision),
        cacheKeyForPrefix(`${NEUTRAL_STALL_CHALLENGE_VERIFICATION_INSTRUCTION}:${decision.outcome}`),
        true,
      );
    };

    const initial = await request("initial", input, cacheKey);
    let final = initial.decision && initial.failures.length === 0
      ? await neutralVerify(initial.decision)
      : { decision: null, failures: initial.failures };

    if (!final.decision || final.failures.length > 0) {
      const correction = await request(
        "correction",
        buildStallChallengeCorrectionPrompt(
          params,
          initial.decision,
          final.failures.length > 0 ? final.failures : initial.failures,
        ),
        cacheKeyForPrefix(`${STALL_CHALLENGE_ADJUDICATION_INSTRUCTION}:correction`),
      );
      final = correction.decision && correction.failures.length === 0
        ? correction.decision.outcome === "accepted" || correction.decision.outcome === "defensible"
          ? await request(
              "neutral_correction",
              buildNeutralStallChallengeVerificationPrompt(params, correction.decision),
              cacheKeyForPrefix(`${NEUTRAL_STALL_CHALLENGE_VERIFICATION_INSTRUCTION}:correction:${correction.decision.outcome}`),
              true,
            )
          : { decision: correction.decision, failures: [] }
        : { decision: correction.decision, failures: correction.failures };
    }

    const constrained = final.decision
      ? deriveConservativeNarrowerDecision(final.decision, params.transcript)
      : null;
    return renderStallChallengeDecision(
      final.decision && final.failures.length === 0
        ? final.decision
        : constrained ?? safeStallChallengeDecision(params),
      params.transcript,
    );
  }
  const input = buildCoachingPrompt(params);
  const cacheKey = cacheKeyForPrefix(buildCoachingStablePrefix(params));
  const raw = await responder(input, cacheKey);
  return (raw || "").trim();
}
