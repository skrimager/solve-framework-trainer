import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deriveConversationState, repeatsClosedAnsweredQuestion } from "../server/conversationState";
import { getCustomerReply } from "../server/llm";
import { personaVariantSeed } from "../server/personaVariants";
import type { TranscriptMessage } from "@shared/schema";

function turn(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to a placeholder when using the approved credential proxy.");

  const vagueTranscript = [
    turn("customer", "What towing capacity does this truck have?"),
    turn("consultant", "It should be able to handle a trailer, but I would need to check the exact rating."),
  ];
  const vagueState = deriveConversationState(vagueTranscript);
  const vagueReply = await getCustomerReply(personaVariantSeed["auto-sales-skeptical-negotiator"].core, vagueTranscript);

  const crossVerticalTranscript = [
    turn("customer", "What is the monthly HOA fee for this listing?"),
    turn("consultant", "The HOA fee is $425 per month and covers exterior maintenance and landscaping."),
  ];
  const crossVerticalState = deriveConversationState(crossVerticalTranscript);
  const crossVerticalReply = await getCustomerReply(personaVariantSeed["real-estate-first-time-buyer-anxious"].core, crossVerticalTranscript);

  const report = {
    vagueAnswerAllowsOneClarification: {
      state: vagueState.answeredCustomerQuestions,
      reply: vagueReply.text,
      hasVagueOpenTopic: vagueState.answeredCustomerQuestions[0]?.status === "vague" && !vagueState.answeredCustomerQuestions[0]?.clarificationUsed,
    },
    nonAutoRealEstate: {
      state: crossVerticalState.answeredCustomerQuestions,
      reply: crossVerticalReply.text,
      repeatsClosedFact: repeatsClosedAnsweredQuestion(crossVerticalState, crossVerticalReply.text),
      hasAnsweredClosedTopic: crossVerticalState.answeredCustomerQuestions[0]?.status === "answered",
    },
  };
  const out = resolve("/home/user/workspace/live_closure_regressions_20260808.json");
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved ${out}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
