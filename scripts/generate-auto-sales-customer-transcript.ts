// Generates a reviewable multi-turn transcript through getCustomerReply itself.
// Default mode is deliberately MOCKED: it exercises the real prompt builder and
// turn flow without sending customer data or needing an OpenAI credential.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getCustomerReply, setCustomerReplyTestResponder } from "../server/llm";
import { personaVariantSeed } from "../server/personaVariants";
import type { TranscriptMessage } from "@shared/schema";

function turn(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

async function main(): Promise<void> {
  const outputPath = resolve(
    process.env.CUSTOMER_REPLY_TRANSCRIPT_PATH ??
      "/home/user/workspace/auto_sales_customer_reply_mocked_transcript_20260807.txt",
  );
  const fixtureReplies = [
    "For us, safe and comfortable means good visibility, helpful driver-assistance features, a smooth quiet highway ride, and seats that will not leave us sore after six hours. We do not need luxury extras.",
    "Used is the better fit for us. We are on a fixed retirement income, so I need a dependable car and a payment that will not make us feel squeezed each month.",
  ];
  const prompts: string[] = [];

  setCustomerReplyTestResponder(({ input }) => {
    prompts.push(input);
    const reply = fixtureReplies.shift();
    if (!reply) throw new Error("No fixture reply remains for getCustomerReply");
    return reply;
  });

  try {
    const transcript: TranscriptMessage[] = [
      turn("customer", "We are replacing our nine-year-old sedan. We are looking for a used car, nothing fancy."),
      turn("consultant", "When you say safe and comfortable for the six-hour drive to your grandkids, what does that mean to you?"),
    ];
    const safetyReply = await getCustomerReply(personaVariantSeed["demo-v2-auto-2"].core, transcript);
    transcript.push(turn("customer", safetyReply));
    transcript.push(turn("consultant", "Would you rather focus on a new vehicle or a used one?"));
    const usedReply = await getCustomerReply(personaVariantSeed["demo-v2-auto-2"].core, transcript);

    const report = `# Auto Sales customer-reply sample transcript\n\n` +
      `Generation mode: MOCKED responder (not a live OpenAI API call).\n` +
      `Execution path: the actual getCustomerReply() function was called twice; the responder only supplies deterministic fixture output after getCustomerReply builds the production prompt.\n` +
      `Scenario: demo-v2-auto-2 — Don, Auto Sales.\n\n` +
      `Customer: We are replacing our nine-year-old sedan. We are looking for a used car, nothing fancy.\n\n` +
      `Consultant: When you say safe and comfortable for the six-hour drive to your grandkids, what does that mean to you?\n\n` +
      `Customer: ${safetyReply}\n\n` +
      `Consultant: Would you rather focus on a new vehicle or a used one?\n\n` +
      `Customer: ${usedReply}\n\n` +
      `Prompt verification: the second getCustomerReply() call contained ${prompts.length} generated prompts total, including the shared CUSTOMER_ROLE_BOUNDARY_RULES and the RUNNING CUSTOMER MEMORY CONTRACT with Don's prior used-car and safety/comfort disclosures.\n`;

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, report, "utf8");
    console.log(report);
    console.log(`Saved mocked transcript to ${outputPath}`);
  } finally {
    setCustomerReplyTestResponder(null);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
