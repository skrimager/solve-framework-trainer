import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deriveConversationState, repeatsClosedAnsweredQuestion } from "../server/conversationState";
import { getCustomerReply } from "../server/llm";
import { personaVariantSeed } from "../server/personaVariants";
import type { TranscriptMessage } from "@shared/schema";

function turn(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

const RUNS = Number(process.env.RUNS ?? "6");
const phase = process.env.PHASE ?? "baseline";
const persona = personaVariantSeed["auto-sales-skeptical-negotiator"].core;
const ask = "What specific towing package and towing capacity does this truck have?";
const firstAnswer = "This truck can tow 12,000 to 14,000 pounds depending on configuration.";
const repeatedAnswer = "Like I said, it can tow 12,000 to 14,000 pounds depending on configuration. That is the specific towing capacity range.";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to a placeholder when using the approved credential proxy.");
  const rows: Array<{ run: number; reply1: string; reply2: string; repeatByClosedTopicCheck: boolean }> = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const transcript: TranscriptMessage[] = [turn("customer", ask), turn("consultant", firstAnswer)];
    const reply1 = await getCustomerReply(persona, transcript);
    transcript.push(turn("customer", reply1.text));
    transcript.push(turn("consultant", repeatedAnswer));
    const reply2 = await getCustomerReply(persona, transcript);
    const repeat = repeatsClosedAnsweredQuestion(deriveConversationState(transcript), reply2.text);
    rows.push({ run, reply1: reply1.text, reply2: reply2.text, repeatByClosedTopicCheck: repeat });
    console.log(`RUN ${run}/${RUNS} ${repeat ? "REPEAT" : "PASS"}`);
    console.log(`  reply 1: ${reply1.text}`);
    console.log(`  reply 2: ${reply2.text}`);
  }
  const repeats = rows.filter((row) => row.repeatByClosedTopicCheck).length;
  const report = {
    phase,
    model: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
    runs: RUNS,
    repeatByClosedTopicCheck: repeats,
    nonRepeatByClosedTopicCheck: RUNS - repeats,
    scenario: { ask, firstAnswer, repeatedAnswer },
    rows,
  };
  const out = resolve(`/home/user/workspace/live_towing_${phase}_20260808.json`);
  await mkdir(resolve("/home/user/workspace"), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Saved ${out}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
