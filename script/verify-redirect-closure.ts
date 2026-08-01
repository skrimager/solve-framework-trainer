// Verification script for the redirect/closure detection fix.
//
// Run from the repo root:
//   DATABASE_URL=postgresql://localhost:5432/unused OPENAI_API_KEY=sk-test-dummy \
//     npx tsx script/verify-redirect-closure.ts
//
// It replays the verbatim staging transcript from the bug report one message at
// a time and prints the sequencedTopics state after each consultant turn, plus
// the prompt lines the customer would actually be given.

import {
  deriveConversationState,
  buildConversationStateLines,
} from "../server/conversationState";
import type { TranscriptMessage } from "../shared/schema";

const TS = "2026-01-01T00:00:00.000Z";

function m(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return { role, content, timestamp: TS };
}

// VERBATIM from the bug report. Do not tidy this text.
const transcript: TranscriptMessage[] = [
  m(
    "consultant",
    "Hi Priya, thanks for coming in today. Is there any particular reason you're looking to buy an SUV today?",
  ),
  m(
    "customer",
    "We're expecting our first child soon, and we're really feeling the need for something spacious and practical. Plus, we want to make sure we have enough room for the baby gear. Is there a specific model you recommend for families?",
  ),
  m(
    "consultant",
    "Congratulations on the little one! When you think about 'enough room,' what specifically comes to mind — is it more about cargo space for gear, seating for other family members, or something else?",
  ),
  m(
    "customer",
    "Thanks! We're mostly focused on cargo space for all the baby gear—things like the stroller and car seat that we need to fit. It's going to be a lot, so I want to make sure there's enough room for everything. Oh, and I'm also curious about how safe the models you're suggesting are. Can you share the safety ratings?",
  ),
  m(
    "consultant",
    "That's a great question, and I promise we'll get to all the safety details once we find the right vehicle for you — I'll walk you through everything it offers. Besides the stroller and car seat, are there other things like sports equipment or luggage for trips that you'll regularly need to haul around?",
  ),
  m(
    "customer",
    "We might need to fit in some larger items too, like a pack-and-play and some bags when traveling. Being able to access everything easily is really important, especially once the baby is here. Speaking of safety, can we dive into those ratings a bit more when you have a chance?",
  ),
  m(
    "consultant",
    "Absolutely, we'll cover all of that in detail shortly, I don't want to skip ahead. Aside from space and safety, is there a particular budget range you two are hoping to stay within for this vehicle?",
  ),
];

const REDIRECT_TURNS = new Set([4, 6]);

console.log("=== Replaying the verbatim staging transcript ===\n");

for (let i = 0; i < transcript.length; i++) {
  const msg = transcript[i];
  if (msg.role !== "consultant") continue;

  const state = deriveConversationState(transcript.slice(0, i + 1));
  const label = REDIRECT_TURNS.has(i)
    ? `consultant turn ${i} (REDIRECT #${i === 4 ? 1 : 2})`
    : `consultant turn ${i}`;

  console.log(`--- after ${label} ---`);
  console.log(`  "${msg.content.slice(0, 76)}..."`);
  console.log(`  sequencedTopics: ${JSON.stringify(state.sequencedTopics)}`);
  console.log("");
}

const finalState = deriveConversationState(transcript);
const safety = finalState.sequencedTopics.find((t) =>
  t.keywords.some((k) => k.includes("safe") || k.includes("rating")),
);

console.log("=== ASSERTIONS ===");
console.log(`safety entry found:            ${Boolean(safety)}`);
console.log(`safety.redirectCount === 2:    ${safety?.redirectCount === 2}   (actual: ${safety?.redirectCount})`);
console.log(`safety.closed === true:        ${safety?.closed === true}   (actual: ${safety?.closed})`);

const lines = buildConversationStateLines(finalState);
const closedLine = lines.find((l) => /CLOSED/.test(l) && /do not raise it again in any form/i.test(l));
console.log(`closed prompt line rendered:   ${Boolean(closedLine)}`);
console.log("");
console.log("=== Prompt line the customer is actually given ===");
console.log(closedLine ?? "(none)");
console.log("");

const ok =
  safety?.redirectCount === 2 && safety?.closed === true && Boolean(closedLine);
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
