// Real-model evidence harness for Message Coach intent fidelity.
//
// Run:
//   OPENAI_API_KEY=<real key> npx tsx scripts/message_coach_intent_evidence.ts
//
// This calls the production scoreOutreachMessage path with a no-op cache and
// prints the original, model-inferred intent, final rewrite, and the result of
// the production fidelity gate. It never substitutes canned model output.

import OpenAI from "openai";
import { appendFileSync, writeFileSync } from "node:fs";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { InsertScoreCache, ScoreCache } from "@shared/schema";
import type {
  CoachScoreResult,
  MessageCoachTraceEvent,
  MessageCoachResponder,
  ScoreCacheStore,
} from "../server/messageCoach";
import {
  preservesContingentPromotionCommissionPartnership,
  preservesDemoReviewInvitation,
  preservesMultiOfficeCoordinationContext,
  preservesTeachingPracticeMechanism,
} from "./message_coach_intent_evidence_assertions";

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey || apiKey === "sk-test-dummy" || apiKey.startsWith("dummy")) {
  console.log(
    "SKIPPED: OPENAI_API_KEY is not a real model credential. No live evidence was fabricated.",
  );
  process.exit(0);
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const proxiedFetch = dispatcher
  ? ((url: any, init: any = {}) =>
      undiciFetch(url, { ...init, dispatcher }) as any)
  : undefined;
const client = new OpenAI(proxiedFetch ? { fetch: proxiedFetch } : {});
const model = process.env.OPENAI_MESSAGE_COACH_MODEL || "gpt-4o";
const tracePath =
  process.env.MESSAGE_COACH_EVIDENCE_TRACE ||
  "message_coach_intent_evidence_trace.jsonl";
let activeCase = "";
let modelCall = 0;

function sanitizeString(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[redacted-phone]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]");
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitize(item),
      ]),
    );
  }
  return value;
}

function record(event: unknown): void {
  const sanitized = sanitize(event);
  appendFileSync(tracePath, JSON.stringify(sanitized) + "\n", "utf8");
  console.log("\nTRACE:\n" + JSON.stringify(sanitized, null, 2));
}

const responder: MessageCoachResponder = async (input, promptCacheKey) => {
  const response = await client.responses.create({
    model,
    input,
    prompt_cache_key: promptCacheKey,
    temperature: 0,
  });
  const raw = response.output_text || "";
  record({
    case: activeCase,
    stage: "model_raw_output",
    call: ++modelCall,
    promptCacheKey,
    raw,
  });
  return raw;
};

function noCache(): ScoreCacheStore {
  return {
    async getScoreCacheEntry(): Promise<ScoreCache | undefined> {
      return undefined;
    },
    async createScoreCacheEntry(entry: InsertScoreCache): Promise<ScoreCache> {
      return { id: 0, ...entry } as ScoreCache;
    },
  };
}

const cases = [
  {
    label: "Exact partnership and platform-demo email",
    industry: "Consulting",
    original: `Good Morning.

I would love to share a platform I built that can dramatically help teams understand and practice exactly what you’re teaching.  I believe it is a great tool that could impact and empower your business and I can give you a quick demonstration of how it works and the amazing benefits and how it ties together your message.
If you like it, I would be willing to advertise your services on the platform and pay a commission for any subscribers that use the platform.`,
  },
  {
    label: "Cold outbound SMS",
    industry: "Business Services",
    original:
      "Hi Maya, noticed your team opened a second location. How are handoffs going between the two offices?",
  },
  {
    label: "Concise explicit cold-outbound email",
    industry: "Business Services",
    original:
      "Hi Maya, I’m emailing because I noticed your team opened a second location. Where are handoffs breaking down between the two offices?",
  },
  {
    label: "Existing-customer follow-up email",
    industry: "Software",
    original:
      "Hi Jordan, following up on yesterday’s call. I’m sending the revised rollout plan with the two-week pilot you requested. Can you confirm whether Tuesday still works for the kickoff?",
  },
  {
    label: "Candidate outreach email",
    industry: "Recruiting",
    original:
      "Hi Priya, your experience leading enterprise onboarding at Acme stood out. We’re hiring a Customer Success Director, and I’d like to invite you to a 20-minute introductory call about the role next week.",
  },
] as const;

function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Independent evidence assertion failed: ${message}`);
}

function assertCaseEvidence(
  label: string,
  result: CoachScoreResult,
  traceEvents: MessageCoachTraceEvent[],
): void {
  const rewrite = result.rewrite;
  requireEvidence(
    result.intentVerification.passes &&
      result.intentVerification.missingOrChanged.length === 0 &&
      result.intentVerification.channelMatches,
    "final production verification must be an exact fidelity pass",
  );
  const finalVerification = [...traceEvents]
    .reverse()
    .find((event) => event.stage === "verification");
  requireEvidence(finalVerification?.stage === "verification", "verification trace exists");
  for (const [name, check] of [
    ["first", finalVerification.firstCheck],
    ["second", finalVerification.secondCheck],
  ] as const) {
    requireEvidence(check.score >= 90, `${name} quality verifier cleared 90`);
    requireEvidence(check.intentVerification.passes === true, `${name} fidelity passes true`);
    requireEvidence(
      check.intentVerification.missingOrChanged.length === 0,
      `${name} fidelity omissions exactly empty`,
    );
    requireEvidence(
      check.intentVerification.channelMatches === true,
      `${name} channel matches`,
    );
  }
  requireEvidence(finalVerification.structuralFailure === null, "deterministic guards pass");
  if (label === "Exact partnership and platform-demo email") {
    requireEvidence(result.intent.messageType === "partnership_proposal", "partnership type");
    requireEvidence(result.intent.channel === "email", "email channel");
    requireEvidence(
      preservesTeachingPracticeMechanism(rewrite),
      "recipient's teaching/concepts plus understand/learn/engage and practice/apply mechanism",
    );
    requireEvidence(
      preservesDemoReviewInvitation(rewrite),
      "demo/review invitation",
    );
    requireEvidence(
      preservesContingentPromotionCommissionPartnership(rewrite),
      "contingent promotion/referral/commission partnership",
    );
    requireEvidence(!/current training setup|what challenges are your teams facing/i.test(rewrite), "no generic discovery substitution");
    requireEvidence(!/reply stop|opt out/i.test(rewrite), "no SMS opt-out in email");
  } else if (label === "Cold outbound SMS") {
    requireEvidence(result.intent.messageType === "cold_outbound", "cold-outbound type");
    requireEvidence(result.intent.channel === "sms", "SMS channel");
    requireEvidence(result.intent.requiresSmsOptOut, "SMS opt-out requirement");
    requireEvidence(/reply stop|text stop|opt out/i.test(rewrite), "STOP/opt-out present");
    requireEvidence(
      preservesMultiOfficeCoordinationContext(rewrite),
      "handoff/coordination/transfer context between offices",
    );
  } else if (label === "Concise explicit cold-outbound email") {
    requireEvidence(result.intent.messageType === "cold_outbound", "cold-outbound email type");
    requireEvidence(result.intent.channel === "email", "explicit email channel");
    requireEvidence(!result.intent.requiresSmsOptOut, "email must not require SMS opt-out");
    requireEvidence(
      preservesMultiOfficeCoordinationContext(rewrite),
      "email preserves handoff/coordination/transfer context between offices",
    );
    requireEvidence(
      !/reply stop|text stop|opt[- ]out|unsubscribe/i.test(rewrite),
      "no SMS opt-out in concise cold email",
    );
  } else if (label === "Existing-customer follow-up email") {
    requireEvidence(result.intent.messageType === "customer_follow_up", "customer-follow-up type");
    requireEvidence(/revised rollout plan/i.test(rewrite), "promised rollout plan");
    requireEvidence(/two.week pilot/i.test(rewrite), "requested pilot");
    requireEvidence(/Tuesday/i.test(rewrite), "kickoff next step");
    requireEvidence(!/reply stop|opt out/i.test(rewrite), "no SMS opt-out in customer email");
  } else if (label === "Candidate outreach email") {
    requireEvidence(result.intent.messageType === "candidate_outreach", "candidate-outreach type");
    requireEvidence(/Customer Success Director/i.test(rewrite), "specific role");
    requireEvidence(/20.minute/i.test(rewrite), "bounded call length");
    requireEvidence(/enterprise onboarding/i.test(rewrite), "candidate relevance");
    requireEvidence(!/reply stop|opt out/i.test(rewrite), "no SMS opt-out in candidate email");
  }
}

async function main(): Promise<void> {
  // Delay the production-module import until after the no-key skip above.
  // messageCoach imports application storage, which correctly requires
  // DATABASE_URL in a real run but should not prevent a credential-free skip.
  const { scoreOutreachMessage } = await import("../server/messageCoach");
  writeFileSync(tracePath, "", "utf8");
  console.log(`Message Coach intent-fidelity evidence; model=${model}; temperature=0`);
  console.log(`Sanitized trace: ${tracePath}`);
  const failures: { label: string; error: string }[] = [];
  for (const testCase of cases) {
    activeCase = testCase.label;
    modelCall = 0;
    const caseTrace: MessageCoachTraceEvent[] = [];
    console.log(`\n${"=".repeat(88)}\nCASE: ${testCase.label}`);
    console.log("\nORIGINAL:\n" + testCase.original);
    try {
      const result = await scoreOutreachMessage(testCase.original, testCase.industry, {
        responder,
        rewriteResponder: responder,
        cache: noCache(),
        trace: (event) => {
          caseTrace.push(event);
          record({ case: activeCase, ...event });
        },
      });
      assertCaseEvidence(testCase.label, result, caseTrace);
      console.log("\nINFERRED INTENT:\n" + JSON.stringify(result.intent, null, 2));
      console.log("\nFINAL REWRITE:\n" + result.rewrite);
      console.log(
        "\nVERIFICATION RESULT:\n" + JSON.stringify(result.intentVerification, null, 2),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ label: testCase.label, error: message });
      record({ case: activeCase, stage: "case_failure", error: message });
      console.error(`\nCASE FAILED: ${message}`);
      // Continue so one failure never hides evidence from contrasting cases.
    }
  }
  if (failures.length > 0) {
    console.error("\nLIVE HARNESS FAILURES:\n" + JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    console.log("\nAll live evidence cases passed.");
  }
}

main().catch((error) => {
  console.error("LIVE HARNESS FAILED:", error);
  process.exit(1);
});
