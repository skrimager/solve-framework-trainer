// The sentence-by-sentence customer-reply stream, shared by real trainee
// sessions and the public demo.
//
// Both flows need the identical behavior: stream the reply text, start TTS on
// each completed sentence the instant it closes (overlapping continued
// generation), and emit one ordered `sentence` Server-Sent Event per sentence so
// the client can queue clips gaplessly and start speaking within about a second.
// The two flows differ only in the inputs they derive (escalation tier, persona
// variant, where the finished text is persisted), so those are parameters and
// the streaming machinery itself lives here once. A second copy of this loop for
// the demo is exactly the drift that left the demo synthesizing whole replies in
// one blocking call while real sessions streamed.
import type { Response } from "express";
import fs from "node:fs/promises";

import { streamCustomerReply, synthesizeSpeech } from "./llm";
import { personaCoreFor } from "./persona";
import { sentenceAudioPath, sentenceAudioUrl } from "./audioCache";
import type { Scenario, TranscriptMessage } from "@shared/schema";

export type MsgAudioStatus = "ready" | "failed";

export interface ReplyStreamOptions {
  msgId: string;
  // Conversation history through the consultant's latest turn. Callers pass the
  // transcript with the empty placeholder message removed (see historyForTurn).
  history: TranscriptMessage[];
  scenario: Scenario;
  escalationTier: number;
  variantSection: string;
  voice: string;
  instructions?: string;
  // `sessionEnded` is true only on the second vulgar/belligerent strike (see
  // checkVulgarBaitStrike in server/llm.ts). Callers must persist that as a
  // terminal session status themselves — this streamer only tells them it
  // happened, the same way it hands back content/status for the transcript
  // message itself.
  persist: (content: string, status: MsgAudioStatus, sessionEnded: boolean) => Promise<void>;
}

// The two external effects of a streamed turn (generate text, synthesize a
// sentence). Swapped out in tests so the stream can be driven without OpenAI.
export interface ReplyStreamDeps {
  streamReply: typeof streamCustomerReply;
  synthesize: typeof synthesizeSpeech;
}

const realDeps: ReplyStreamDeps = { streamReply: streamCustomerReply, synthesize: synthesizeSpeech };
let deps: ReplyStreamDeps = realDeps;

export function __setReplyStreamDepsForTests(next: Partial<ReplyStreamDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
}

// The history the model should see for a turn: everything except the empty
// placeholder message this turn is about to fill in.
export function historyForTurn(transcript: TranscriptMessage[], msgId: string): TranscriptMessage[] {
  return transcript.filter((m) => m.msgId !== msgId);
}

// Drives one streamed customer turn over Server-Sent Events. Streams the reply
// text, and for each completed sentence starts TTS immediately (overlapping
// continued generation) while emitting `sentence` events strictly in order so
// the client can queue them gaplessly. Emits a final `done` (or `error`) event
// and persists the full reply text + audio status when finished.
export async function runReplyStream(res: Response, opts: ReplyStreamOptions): Promise<void> {
  const { msgId, history, scenario, escalationTier, variantSection, voice, instructions, persist } = opts;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable proxy buffering (nginx) so events flush to the client immediately.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  const sse = (event: string, data: unknown) => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let anyAudio = false;
  // Serializes SSE emission in sentence order even though each sentence's TTS
  // runs concurrently with generation and with the other sentences.
  let emitChain: Promise<void> = Promise.resolve();

  const handleSentence = (sentence: string, index: number) => {
    const ttsPromise = deps
      .synthesize(sentence, voice, instructions)
      .then(async (buf) => {
        await fs.writeFile(sentenceAudioPath(msgId, index), buf);
        return true;
      })
      .catch((err) => {
        console.error("Sentence TTS failed:", err);
        return false;
      });
    emitChain = emitChain.then(async () => {
      const ok = await ttsPromise;
      if (ok) anyAudio = true;
      sse("sentence", {
        index,
        text: sentence,
        audioUrl: ok ? sentenceAudioUrl(msgId, index) : null,
      });
    });
  };

  let fullText = "";
  let sessionEnded = false;
  try {
    const result = await deps.streamReply(
      personaCoreFor(scenario),
      history,
      scenario.difficulty,
      escalationTier,
      variantSection,
      handleSentence,
    );
    fullText = result.text;
    sessionEnded = result.sessionEnded;
    await emitChain;
    await persist(fullText, anyAudio ? "ready" : "failed", sessionEnded);
    sse("done", { msgId, text: fullText, sessionEnded });
  } catch (err) {
    console.error("Turn stream failed:", err);
    await emitChain.catch(() => {});
    // Persist whatever text was generated so the transcript is never left blank.
    await persist(fullText, "failed", false).catch(() => {});
    sse("error", { message: "reply_failed" });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
