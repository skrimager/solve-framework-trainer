// Real, non-mocked load test against the live OpenAI model.
//
// Purpose: measure actual scoring variance for the message coach rewrite
// verification loop, using the REAL scoreOutreachMessage() function from
// server/messageCoach.ts (not a reimplementation), with a responder that
// calls the real OpenAI API through an HTTPS proxy (no mocking).
//
// This directly answers: after scoreOutreachMessage() verifies a rewrite
// clears MESSAGE_COACH_REWRITE_FLOOR (90), and a customer pastes that exact
// rewrite text back in as a brand new message to score, how far does the
// score actually drift, and does the temperature=0 + double-check change
// meaningfully narrow that drift versus the old single-check approach?
//
// Run with: OPENAI_API_KEY=<real key> npx tsx scripts/real_variance_test.ts

import {
  scoreOutreachMessage,
  type ScoreCacheStore,
  type MessageCoachResponder,
} from "../server/messageCoach";
import type { InsertScoreCache, ScoreCache } from "@shared/schema";
import OpenAI from "openai";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// The OpenAI SDK's default fetch does not honor HTTPS_PROXY the way plain
// httpx/requests do, so the sandbox credential proxy's auth swap for
// api.openai.com never applies and every call 401s. Force it through an
// explicit undici ProxyAgent that reads HTTPS_PROXY directly, matching how
// the credential proxy actually injects auth.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const proxiedFetch = dispatcher
  ? ((url: any, init: any = {}) => undiciFetch(url, { ...init, dispatcher }) as any)
  : undefined;

const client = new OpenAI(proxiedFetch ? { fetch: proxiedFetch } : {});
// Matches production exactly: ONE model for the whole Message Coach path
// (initial score, rewrite generation, rewrite verification). A prior split
// (fast model for score, strong model for rewrite) was proven broken by a
// real test: the same exact text scored differently by model, not by
// chance, so score and rewrite verification must share a model.
const MESSAGE_COACH_MODEL = process.env.OPENAI_MESSAGE_COACH_MODEL || "gpt-4o";

function makeResponder(model: string): MessageCoachResponder {
  return async (input, promptCacheKey) => {
    const response = await client.responses.create({
      model,
      input,
      prompt_cache_key: promptCacheKey,
      temperature: 0,
    });
    return response.output_text || "";
  };
}

const scoreResponder = makeResponder(MESSAGE_COACH_MODEL);
const rewriteResponder = makeResponder(MESSAGE_COACH_MODEL);

// A no-op cache so every call in this script actually reaches the model
// (mirrors production's first-time-scored path, not a cache hit).
function noCache(): ScoreCacheStore {
  return {
    async getScoreCacheEntry(_hash: string): Promise<ScoreCache | undefined> {
      return undefined;
    },
    async createScoreCacheEntry(entry: InsertScoreCache): Promise<ScoreCache> {
      return { id: 0, ...entry } as ScoreCache;
    },
  };
}

// Low-scoring cold outreach messages, the exact category this tool exists
// to coach, across different industries.
const ORIGINAL_MESSAGES: { message: string; industry: string | null }[] = [
  { message: "Are you ready to sell your house?", industry: "Real Estate" },
  { message: "I noticed several homes for sale in your neighborhood.", industry: "Real Estate" },
  { message: "Hey, do you want a better rate on your mortgage?", industry: "Mortgage" },
  { message: "Selling soon? Let me know.", industry: "Real Estate" },
  { message: "Quick question, are you the decision maker for insurance at your company?", industry: "Insurance" },
];

const RESUBMISSIONS_PER_REWRITE = 3;

async function main() {
  console.log(`Message Coach model: ${MESSAGE_COACH_MODEL} (score + rewrite + verification), temperature: 0\n`);
  console.log("=".repeat(80));

  const summary: { message: string; verifiedScore: number; resubmitScores: number[]; minResubmit: number; maxDrop: number }[] = [];

  for (const { message, industry } of ORIGINAL_MESSAGES) {
    console.log(`\nORIGINAL: "${message}" (${industry})`);
    const result = await scoreOutreachMessage(message, industry, {
      responder: scoreResponder,
      rewriteResponder,
      cache: noCache(),
    });
    console.log(`  Original score: ${result.score}`);
    console.log(`  Rewrite (verified >= 90 internally): "${result.rewrite}"`);

    const resubmitScores: number[] = [];
    for (let i = 0; i < RESUBMISSIONS_PER_REWRITE; i++) {
      // Simulate exactly what the customer did: paste the rewrite back in
      // as a brand new message to score, fresh, no cache.
      const resubmit = await scoreOutreachMessage(result.rewrite, industry, {
        responder: scoreResponder,
        rewriteResponder,
        cache: noCache(),
      });
      resubmitScores.push(resubmit.score);
      console.log(`  Resubmission ${i + 1}/${RESUBMISSIONS_PER_REWRITE}: scored ${resubmit.score}`);
    }

    const minResubmit = Math.min(...resubmitScores);
    const maxDrop = 90 - minResubmit; // how far below the floor the worst resubmission fell, if at all
    summary.push({ message, verifiedScore: 90, resubmitScores, minResubmit, maxDrop });
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY\n");
  for (const row of summary) {
    const status = row.minResubmit >= 90 ? "HELD >= 90" : `DROPPED to ${row.minResubmit}`;
    console.log(`"${row.message.slice(0, 50)}..." -> resubmit scores: [${row.resubmitScores.join(", ")}] -> ${status}`);
  }

  const allMins = summary.map((r) => r.minResubmit);
  const worstCase = Math.min(...allMins);
  const allHeld = allMins.every((s) => s >= 90);
  console.log(`\nWorst-case resubmission score across all tests: ${worstCase}`);
  console.log(allHeld ? "ALL resubmissions held >= 90." : "AT LEAST ONE resubmission fell below 90.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
