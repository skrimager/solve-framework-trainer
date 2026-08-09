import { writeFile } from "node:fs/promises";

import type { Scenario, TranscriptMessage } from "@shared/schema";
import { getCustomerOpening, getCustomerReply } from "../server/llm";
import { personaCoreFor, personaOpeningCoreFor } from "../server/persona";
import { scenarios } from "../server/seed";

const OUTPUT_PATH = "/home/user/workspace/scenario_consistency_live_verification_20260809.txt";

function scenarioFor(slug: string): Scenario {
  const scenario = scenarios.find((candidate) => candidate.slug === slug);
  if (!scenario) throw new Error(`Missing scenario: ${slug}`);
  return { ...scenario, id: 1 } as Scenario;
}

function section(title: string): string {
  return `\n${"=".repeat(88)}\n${title}\n${"=".repeat(88)}\n`;
}

async function runSaasOpenings(lines: string[]): Promise<void> {
  lines.push(section("LIVE OPENINGS: ALL SaaS PRODUCT CATEGORIES"));
  lines.push(
    "Each opening below is a live getCustomerOpening() result using the production opening prompt, " +
      "including the hidden product context. The product tag is printed here only for audit review; it is not UI output.",
  );

  for (const seed of scenarios.filter((scenario) => scenario.vertical === "saas")) {
    const scenario = { ...seed, id: 1 } as Scenario;
    const opening = await getCustomerOpening(personaOpeningCoreFor(scenario), scenario.track, "");
    lines.push(`\nSlug: ${scenario.slug}`);
    lines.push(`Hidden audit tag: ${scenario.product}`);
    lines.push(`Difficulty: ${scenario.difficulty}`);
    lines.push(`Customer opening: ${opening}`);
  }
}

type ReactiveCheck = {
  slug: string;
  purpose: string;
  consultantTurns: [string, string];
};

const REACTIVE_CHECKS: ReactiveCheck[] = [
  {
    slug: "hvac-sales-competing-quotes",
    purpose:
      "Address the initial best-price request by sequencing it, then ask two new discovery questions. " +
      "The customer should answer the current question rather than independently returning to price.",
    consultantTurns: [
      "I will make sure we compare value and price once I understand the replacement correctly, so you will not be asked to decide blind. What has the current system been doing that prompted you to seek quotes?",
      "That makes sense. We can put together an apples-to-apples quote after we confirm the right size and scope. How long do you expect to stay in this home?",
    ],
  },
  {
    slug: "real-estate-first-time-buyer-anxious",
    purpose:
      "Park the customer's initial financing anxiety and move into two discovery questions. " +
      "The customer should stay responsive to the question in front of them.",
    consultantTurns: [
      "We can leave detailed financing for later, after we know what would make a home fit. Who would be living in the home, and what would daily life need from it?",
      "Thank you, that helps. I will focus the search around that routine. Which neighborhoods or commute areas should we prioritize?",
    ],
  },
  {
    slug: "employee-grievance-schedule-change-upset",
    purpose:
      "Acknowledge the schedule complaint, then seek details in two consecutive questions. " +
      "The employee should react to the current question without restarting the opening complaint.",
    consultantTurns: [
      "I am sorry the schedule change landed that way. I want to understand before we solve it: what part of the change has the biggest impact on you?",
      "I hear you. I will review the coverage issue separately; for this conversation I want to look at options. Which days or hours create the conflict?",
    ],
  },
];

async function runReactiveChecks(lines: string[]): Promise<void> {
  lines.push(section("LIVE MULTI-TURN REACTIVE-ONLY SPOT CHECKS"));
  lines.push(
    "Each scenario below is outside auto sales and SaaS. The customer gets an opening and two live replies " +
      "through the production getCustomerReply() path.",
  );

  for (const check of REACTIVE_CHECKS) {
    const scenario = scenarioFor(check.slug);
    const opening = await getCustomerOpening(personaCoreFor(scenario), scenario.track, "");
    const transcript: TranscriptMessage[] = [{ role: "customer", content: opening }];

    lines.push(`\nSlug: ${scenario.slug}`);
    lines.push(`Vertical: ${scenario.vertical}; track: ${scenario.track}; difficulty: ${scenario.difficulty}`);
    lines.push(`Audit purpose: ${check.purpose}`);
    lines.push(`Customer opening: ${opening}`);

    for (const [index, consultantTurn] of check.consultantTurns.entries()) {
      transcript.push({ role: "consultant", content: consultantTurn });
      const reply = await getCustomerReply(personaCoreFor(scenario), transcript, scenario.difficulty, 0, "");
      transcript.push({ role: "customer", content: reply.text });

      lines.push(`Consultant turn ${index + 1}: ${consultantTurn}`);
      lines.push(`Customer turn ${index + 1}: ${reply.text}`);
      lines.push(`Customer marked session-ended: ${reply.sessionEnded}`);
    }
  }
}

async function main(): Promise<void> {
  const lines = [
    "SOLVE Framework — live OpenAI scenario-consistency verification",
    `Generated: ${new Date().toISOString()}`,
    `Model override: ${process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini"}`,
    "Credential mode: OPENAI_API_KEY supplied by the approved credential proxy (key value not recorded).",
  ];

  await runSaasOpenings(lines);
  await runReactiveChecks(lines);

  await writeFile(OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");
  console.log(`Saved live verification transcript: ${OUTPUT_PATH}`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  await writeFile(
    OUTPUT_PATH,
    `SOLVE Framework — live OpenAI scenario-consistency verification\nFAILED\n${message}\n`,
    "utf8",
  );
  console.error(message);
  process.exitCode = 1;
});
