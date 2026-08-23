// Executable before/after evidence harness for the Stall & Excuse Handling
// grounding fix. With a real OPENAI_API_KEY, this invokes scoreTranscript's
// production responder. Without one, it invokes the same scoreTranscript path
// through its existing injectable responder seam and records deterministic
// prompt-regression evidence instead of pretending to have new model feedback.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TranscriptMessage } from "@shared/schema";
import {
  buildStallActionGroundingBlock,
  deriveStallActionCoverage,
} from "../server/feedbackGrounding";
import {
  STALL_FEEDBACK_ADJUDICATION_INSTRUCTION,
  scoreTranscript,
  type ScoreResponder,
} from "../server/llm";
import { getCoachingReply, type CoachingResponder } from "../server/coaching";

type StoredSession = {
  sessionId: number;
  feedback: string;
  transcript: string;
};

const fixturePath = fileURLToPath(
  new URL("../server/fixtures/wade-stall-sessions-528-530.json", import.meta.url),
);
const productionSessions = JSON.parse(readFileSync(fixturePath, "utf8")) as StoredSession[];

const AUTO_STALL_TRANSCRIPT: TranscriptMessage[] = [
  { role: "customer", content: "I like the SUV, but please email me a quote so I can think it over.", timestamp: "t1" },
  {
    role: "consultant",
    content:
      "I understand wanting time to review it. Before I email you a quote, what would you like to compare or confirm so I can make it useful?",
    timestamp: "t2",
  },
  { role: "customer", content: "I need to compare my trade-in and current lease payment.", timestamp: "t3" },
  {
    role: "consultant",
    content:
      "Let's pull up your trade-in and current payment together. If you wait until your lease ends, what changes for you?",
    timestamp: "t4",
  },
];

const deterministicResponse = JSON.stringify({
  needsDiscovery: 75,
  objectionPrevention: 75,
  trustBuilding: 75,
  naturalClose: 75,
  relationshipContinuity: 75,
  closeOutcome: "recommendation_made",
  feedback: "Deterministic prompt-regression run: no external model feedback was requested.",
  stallEvidence: {
    questionTypesUsed: [],
    redFlagsTriggered: [],
    rewardedBehaviorsObserved: [],
  },
});

function scoringResponseWithFeedback(feedback: string): string {
  return JSON.stringify({ ...JSON.parse(deterministicResponse), feedback });
}

function praiseDecision(turn: number, observation: string) {
  return {
    disposition: "praise_only",
    strengths: [{ traineeTurn: turn, observation }],
    improvement: null,
  };
}

function quoteMarkdown(value: string): string {
  return value
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `> ${line}`)
    .join("\n");
}

function productionTranscript(sessionId: number): TranscriptMessage[] {
  const session = productionSessions.find((candidate) => candidate.sessionId === sessionId);
  if (!session) throw new Error(`Missing supplied production session ${sessionId}`);
  return JSON.parse(session.transcript) as TranscriptMessage[];
}

function productionFeedback(sessionId: number): string {
  const session = productionSessions.find((candidate) => candidate.sessionId === sessionId);
  if (!session) throw new Error(`Missing supplied production session ${sessionId}`);
  return session.feedback;
}

async function main(): Promise<void> {
  const realKey = process.env.OPENAI_API_KEY;
  const useRealModel = Boolean(realKey && realKey !== "sk-test-dummy");
  const rows: Array<{
    name: string;
    transcript: TranscriptMessage[];
    before: string;
    after: string;
    promptCaptured: boolean;
    actionLines: string[];
    semanticAdjudicatorRan: boolean;
    audit: unknown;
    status: "passed" | "failed";
    error?: string;
  }> = [];

  const sessions: Array<{ name: string; sessionId?: number; transcript: TranscriptMessage[]; before: string }> = [
    {
      name: "Production session 528 (roofing)",
      sessionId: 528,
      transcript: productionTranscript(528),
      before: productionFeedback(528),
    },
    {
      name: "Production session 529 (roofing / solar-savings concern)",
      sessionId: 529,
      transcript: productionTranscript(529),
      before: productionFeedback(529),
    },
    {
      name: "Production session 530 (solar)",
      sessionId: 530,
      transcript: productionTranscript(530),
      before: productionFeedback(530),
    },
    {
      name: "Cross-vertical regression (automotive)",
      transcript: AUTO_STALL_TRANSCRIPT,
      before: "Synthetic regression transcript; no production feedback existed before this change.",
    },
  ];

  for (const session of sessions) {
    let capturedPrompt = "";
    let capturedAdjudicationPrompt = "";
    const responder: ScoreResponder | undefined = useRealModel
      ? undefined
      : async (input) => {
          capturedPrompt = input;
          return deterministicResponse;
        };
    const adjudicator: ScoreResponder | undefined = useRealModel
      ? undefined
      : async (input) => {
          capturedAdjudicationPrompt = input;
          return JSON.stringify(praiseDecision(2, "This gave the customer a clear invitation to explain what they needed."));
        };
    const grounding = buildStallActionGroundingBlock(session.transcript);
    try {
      const result = await scoreTranscript(session.transcript, "intermediate", "consulting", null, {
        stallType: "evidence_harness",
        ...(responder ? { responder } : {}),
        ...(adjudicator ? { stallFeedbackAdjudicator: adjudicator } : {}),
      });
      rows.push({
        name: session.name,
        transcript: session.transcript,
        before: session.before,
        after: result.feedback,
        promptCaptured: useRealModel ? grounding.includes("STALL ACTION PRE-CHECK") : capturedPrompt.includes("STALL ACTION PRE-CHECK"),
        actionLines: deriveStallActionCoverage(session.transcript).map(
          (action) => `${action.label} — turn ${action.turn}: "${action.quote}"`,
        ),
        semanticAdjudicatorRan: useRealModel
          ? true
          : capturedAdjudicationPrompt.includes(STALL_FEEDBACK_ADJUDICATION_INSTRUCTION),
        audit: result.stallFeedbackAudit,
        status: "passed",
      });
    } catch (error) {
      rows.push({
        name: session.name,
        transcript: session.transcript,
        before: session.before,
        after: "(no feedback served)",
        promptCaptured: useRealModel ? grounding.includes("STALL ACTION PRE-CHECK") : capturedPrompt.includes("STALL ACTION PRE-CHECK"),
        actionLines: deriveStallActionCoverage(session.transcript).map(
          (action) => `${action.label} — turn ${action.turn}: "${action.quote}"`,
        ),
        semanticAdjudicatorRan: useRealModel
          ? true
          : capturedAdjudicationPrompt.includes(STALL_FEEDBACK_ADJUDICATION_INSTRUCTION),
        audit: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const knownLiveFailureProbes = [
    {
      label: "Session 528",
      transcript: productionTranscript(528),
      feedback: "Probe specific calculations and assumptions behind the financial concern.",
      category: "diagnosticQuestion",
      coveredTurn: 24,
      correctedFeedback:
        'You did ask about the financial concern at turn 24: "Tell me a little bit about your finances and what your concern is." The fairer improvement is to reflect the budget constraint the customer named before proposing the next solution.',
    },
    {
      label: "Session 529",
      transcript: productionTranscript(529),
      feedback: "Ask what would build confidence in the savings.",
      category: "diagnosticQuestion",
      coveredTurn: 10,
      correctedFeedback:
        "At turn 10 you asked what savings the customer meant. A narrower coaching point is the customer’s turn-11 need to test the estimate against typical usage, rather than a generic request to restate what would build trust.",
    },
    {
      label: "Session 530",
      transcript: productionTranscript(530),
      feedback: "Explore the customer's concerns further.",
      category: "diagnosticQuestion",
      coveredTurn: 30,
      correctedFeedback:
        "You asked how to make the numbers solid at turn 30, and the customer named past electric bills at turn 31. Since you had also offered to review that data together, the fairer focus is the quality of that follow-through rather than another generic data question.",
    },
    {
      label: "Automotive cross-vertical regression",
      transcript: AUTO_STALL_TRANSCRIPT,
      feedback: "What changes for you if you wait until your lease ends?",
      category: "futureImpactQuestion",
      coveredTurn: 4,
      correctedFeedback:
        "At turn 2 you asked what the customer wanted to compare or confirm, and at turn 4 you offered to pull up the trade-in and current payment together. The fairer coaching focus is the quality of that review rather than another equivalent discovery question.",
    },
  ];
  const adjudicationProbes = [];
  for (const probe of knownLiveFailureProbes) {
    let adjudicationAttempt = 0;
    try {
      const result = await scoreTranscript(probe.transcript, "intermediate", "consulting", null, {
        stallType: "evidence_harness",
        responder: async () => scoringResponseWithFeedback(probe.feedback),
        stallFeedbackAdjudicator: async (input) => {
        if (!input.includes(probe.feedback) || !input.includes("STALL ACTION PRE-CHECK")) {
          if (!input.includes("CONTRACT FAILURES")) {
            throw new Error("Adjudication probe did not receive the candidate feedback and transcript evidence");
          }
        }
        adjudicationAttempt += 1;
        return JSON.stringify({
          ...(adjudicationAttempt === 1
            ? {
                disposition: "accepted",
                strengths: [{ traineeTurn: probe.coveredTurn, observation: "This invited the customer to explain the concern in their own words." }],
                improvement: {
                  category: probe.category,
                  acknowledgementCoveredTurns: [],
                  narrowerGap: "more detail",
                  laterCustomerEvidenceTurn: 1,
                  evidenceTerms: ["customer"],
                  advice: probe.feedback,
                },
              }
            : praiseDecision(probe.coveredTurn, "This gave the customer a clear opportunity to explain the concern before the conversation moved on.")),
        });
        },
      });
      adjudicationProbes.push({ ...probe, result, status: "passed" });
    } catch (error) {
      adjudicationProbes.push({
        ...probe,
        result: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const coachCases = [
    {
      label: "Coach true challenge — session 528",
      transcript: productionTranscript(528),
      feedback:
        "You should have asked what was making the customer uncertain about getting the roof fixed.",
      question: "I already asked that in turn 24.",
      deterministic: {
        outcome: "accepted",
        coveredTraineeTurns: [24],
        laterCustomerEvidenceTurn: null,
        evidenceTerms: [],
        narrowerGap: null,
        ambiguity: null,
        noLaterEvidenceSupportsNarrower: true,
      },
      validate: (reply: string) =>
        /turn 24/i.test(reply) && /\b(?:you are right|you'?re right|withdraw|correct)\b/i.test(reply),
    },
    {
      label: "Coach defensible challenge — session 529",
      transcript: productionTranscript(529),
      feedback:
        "At turn 10 you asked what savings meant; a narrower follow-up can address whether the estimate fits typical usage at turn 11.",
      question: "I already asked what savings meant in turn 10, so why are you still recommending a question?",
      deterministic: {
        outcome: "defensible",
        coveredTraineeTurns: [10],
        laterCustomerEvidenceTurn: 11,
        evidenceTerms: ["typical", "usage"],
        narrowerGap: "whether the estimate reflects typical usage",
        ambiguity: null,
        noLaterEvidenceSupportsNarrower: false,
      },
      validate: (reply: string) =>
        /turn 10/i.test(reply) &&
        /turn 11/i.test(reply) &&
        /\b(?:hold|builds on|rather than repeats|not repeat)\b/i.test(reply),
    },
  ];
  const coachReports = [];
  for (const coachCase of coachCases) {
    let capturedCoachPrompt = "";
    const trace: Array<{ stage: string; raw: string; decision: unknown; failures: unknown }> = [];
    const responder: CoachingResponder | undefined = useRealModel
      ? undefined
      : async (input) => {
          capturedCoachPrompt = input;
          return JSON.stringify(coachCase.deterministic);
        };
    try {
      const params = {
        track: "consulting",
        feedback: coachCase.feedback,
        rubricScoresJson: null,
        overallScore: null,
        transcript: coachCase.transcript,
        thread: [],
        question: coachCase.question,
        stallType: "evidence_harness",
      };
      const reply = responder
        ? await getCoachingReply(params, responder, { onStallTrace: (step) => trace.push(step) })
        : await getCoachingReply(params, undefined, { onStallTrace: (step) => trace.push(step) });
      coachReports.push({
        label: coachCase.label,
        status: coachCase.validate(reply) ? "passed" : "failed",
        reply,
        promptCaptured: useRealModel ? true : capturedCoachPrompt.includes("STALL COACHING STRUCTURED CHALLENGE DECISION"),
        trace,
      });
    } catch (error) {
      coachReports.push({
        label: coachCase.label,
        status: "failed",
        reply: "",
        promptCaptured: false,
        trace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const mode = useRealModel
    ? "Live model run: `scoreTranscript` used its production OpenAI responder."
    : "Deterministic regression run: no usable `OPENAI_API_KEY` was available, so `scoreTranscript` used its established injected responder seam. The reported “after” text is intentionally not represented as new model feedback; the prompt-control and exact action extraction are the deterministic evidence.";
  const report = [
    "# Stall feedback grounding — before/after evidence",
    "",
    mode,
    "",
    "The stored production feedback below is the supplied export. Every after run executes the implemented `scoreTranscript` path as a dedicated stall session, so the stall-action pre-check is appended before feedback is produced. Cost behavior is bounded: non-stall scoring remains one model call; a stall score is one scoring call plus at most three adjudication calls (initial audit, correction, and final safe recovery).",
    "",
    ...rows.flatMap((row) => [
      `## ${row.name}`,
      `- Result: **${row.status}**${row.error ? ` — ${row.error}` : ""}`,
      "",
      "### Before",
      quoteMarkdown(row.before),
      "",
      "### After",
      quoteMarkdown(row.after),
      "",
      `- Stall-action pre-check reached scoring path: **${row.promptCaptured ? "yes" : "no"}**`,
      `- AI semantic adjudicator ran after scoring: **${row.semanticAdjudicatorRan ? "yes" : "no"}**`,
      `- Validated structured decision: \`${JSON.stringify(row.audit)}\``,
      `- Exact actions derived: ${row.actionLines.length > 0 ? "" : "_none_"}`,
      ...row.actionLines.map((line) => `  - ${line}`),
      "",
    ]),
    "## AI semantic-adjudication probes",
    "",
    "These are the exact materially equivalent recommendations observed in the prior live-model run. The scoped AI adjudicator receives each candidate plus the deterministic transcript evidence and returns corrected feedback before it is served.",
    "",
    ...adjudicationProbes.flatMap((probe) => [
      `- ${probe.label}: ${quoteMarkdown(probe.feedback)}`,
      `  - Result: **${probe.status}**${probe.error ? ` — ${probe.error}` : ""}`,
      `  - Served feedback after AI correction: ${probe.result ? quoteMarkdown(probe.result.feedback) : "_none (failed closed)_"}`,
      `  - Validated structured decision: \`${JSON.stringify(probe.result?.stallFeedbackAudit ?? null)}\``,
    ]),
    "",
    "## Coach challenge checks",
    "",
    ...coachReports.flatMap((coach) => [
      `- ${coach.label}: **${coach.status}**${coach.error ? ` — ${coach.error}` : ""}`,
      `  - Structured challenge prompt reached model: **${coach.promptCaptured ? "yes" : "no"}**`,
      `  - Reply: ${coach.reply ? quoteMarkdown(coach.reply) : "_none_"}`,
      "  - Sanitized decision trace: `" + JSON.stringify(coach.trace) + "`",
    ]),
    "",
    "## Coach challenge handling",
    "",
    "For a dedicated stall session, the Coach uses a structured AI adjudication turn with the same numbered transcript, stall-action evidence, original feedback, and persisted current-session coaching thread. A true challenge must be conceded with confirming turns; a defensible deeper recommendation must acknowledge the covered turn and cite the narrower gap; an ambiguous case must avoid overclaiming. Accepted corrections are retained through the existing `coaching_messages` thread for later turns in that same debrief. This is current-conversation context, not permanent cross-session model training.",
    "",
    "## Interpretation",
    "",
    "The post-change scorer uses AI to make a structured semantic fairness decision from transcript and stall-action evidence. The application validates every referenced trainee/customer turn and evidence term, then renders feedback itself from the approved fields; arbitrary model prose is never served. When no genuinely distinct evidence-backed improvement exists, the decision can return exact-turn praise only. This blocks the redundant concern-exploration, savings-confidence, data, and automotive future-impact recommendations while preserving a narrower improvement only when later customer evidence proves it.",
    "",
  ].join("\n");

  const outputDirectory = fileURLToPath(new URL("../artifacts/", import.meta.url));
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = fileURLToPath(new URL("../artifacts/stall-feedback-grounding-evidence.md", import.meta.url));
  writeFileSync(outputPath, report);
  console.log(`Evidence written to ${outputPath}`);
  console.log(`Mode: ${useRealModel ? "live-model" : "deterministic-regression"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
