// On-disk cache for synthesized reply audio, shared by the real trainee session
// routes and the public demo routes so both write and serve clips from the same
// place under the same names.
import path from "node:path";
import fsSync from "node:fs";

export const AUDIO_DIR = path.join(process.cwd(), "audio_cache");
if (!fsSync.existsSync(AUDIO_DIR)) fsSync.mkdirSync(AUDIO_DIR, { recursive: true });

// A whole message's audio, keyed by message id, so the stream endpoint can reuse
// a previously rendered file (replay) instead of re-synthesizing.
export function audioPathForMsg(msgId: string): string {
  return path.join(AUDIO_DIR, `${msgId}.mp3`);
}

// One sentence's audio within a streamed reply, keyed by message id + sentence
// index so the SSE endpoint can write it and /api/audio/:filename can serve it.
export function sentenceAudioPath(msgId: string, index: number): string {
  return path.join(AUDIO_DIR, `${msgId}-${index}.mp3`);
}

export function sentenceAudioUrl(msgId: string, index: number): string {
  return `/api/audio/${msgId}-${index}.mp3`;
}
