// Generates a real, reviewable Auto Sales discovery conversation through the
// production getCustomerOpening()/getCustomerReply() path. This intentionally
// does NOT install a test responder: every customer line comes from the live
// OpenAI Responses API and is saved in full for human review.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getCustomerOpening, getCustomerReply } from "../server/llm";
import { buildPersonaVariantSection, type SelectedPersonaVariant } from "../server/persona";
import { personaVariantSeed } from "../server/personaVariants";
import type { TranscriptMessage } from "@shared/schema";

function turn(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

const vince = personaVariantSeed["demo-v2-auto-1"];

// This mirrors the per-session structured rendition the live demo supplies while
// making the live transcript reviewable and repeatable in its persona facts.
const vinceVariant: SelectedPersonaVariant = {
  personality: "guarded but fair, willing to warm up for someone who answers straight",
  motivation: "protecting the business that runs entirely out of this vehicle",
  objections: [
    { text: "what's the out-the-door number, I don't need the tour", position: "early" },
    { text: "how do I know this one isn't going to do the same thing to me", position: "midway" },
  ],
};

const consultantTurns = [
  "Hi Vince, glad you called. Beyond the silver SUV itself, what has you looking for a vehicle right now?",
  "You spend a lot of time on the road. When you think about safety in this SUV, what specifically would help you feel confident?",
  "Would you rather focus on a new SUV or a used one, and what makes that the better fit for you?",
  "What kind of budget or monthly range would feel workable for the business without putting you in a squeeze?",
  "Besides safety, comfort, and the number, what else will matter when you decide whether this is the right SUV?",
  "You mentioned that your last vehicle nickel-and-dimed you. What happened with it that still sticks with you?",
  "Earlier you said you run the flooring business from the vehicle. How does that day-to-day use affect what you need from the SUV?",
  "Just so I do not miss it: you mentioned safety earlier. Which safety features or driving situations matter most to you now?",
];

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY must be set to a truthy placeholder when using the approved credential proxy.",
    );
  }

  const outputPath = resolve(
    process.env.CUSTOMER_REPLY_TRANSCRIPT_PATH ??
      "/home/user/workspace/auto_sales_customer_reply_live_transcript_20260808.txt",
  );
  const variantSection = buildPersonaVariantSection(vinceVariant);
  const transcript: TranscriptMessage[] = [];

  const opening = await getCustomerOpening(vince.core, "consulting", variantSection);
  transcript.push(turn("customer", opening));

  for (const consultantLine of consultantTurns) {
    transcript.push(turn("consultant", consultantLine));
    const reply = await getCustomerReply(vince.core, transcript, "beginner", 0, variantSection);
    if (reply.sessionEnded) throw new Error("Unexpected terminal customer reply during live transcript generation.");
    transcript.push(turn("customer", reply.text));
  }

  const renderedTurns = transcript
    .map((message, index) => `${index + 1}. ${message.role === "consultant" ? "Consultant" : "Vince"}: ${message.content}`)
    .join("\n\n");
  const report = `# Real OpenAI Auto Sales customer transcript

Generation mode: LIVE OpenAI Responses API via production getCustomerOpening() and getCustomerReply(); no mocked responder was installed.
Scenario: demo-v2-auto-1 — Vince, Auto Sales.
Difficulty: beginner (the public demo setting).
Customer turns: 9 total (one opening plus eight replies).
Consultant coverage: opening/why now, safety-specific discovery, new-versus-used, budget, an open "what else matters" question, a follow-up on the last vehicle, a business-use callback, and a repeat-ish safety question.

${renderedTurns}
`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report, "utf8");
  console.log(report);
  console.log(`Saved live transcript to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
