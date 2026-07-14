// Thin client for the public "Free Voice Demo" API. These endpoints are
// unauthenticated: the email + 6-digit code IS the auth, and a signed demo
// token (returned by /verify) authorizes the roleplay calls. Kept separate from
// queryClient's apiRequest (which throws on any non-2xx) because the demo's 200
// responses carry meaningful flags like `limitReached` that the UI must read.
import type { TranscriptMessage } from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export type DemoScenario = {
  id: number;
  slug: string;
  title: string;
  briefing: string;
  track: string | null;
  gender: string | null;
};

export type DemoSession = {
  id: number;
  scenarioId: number;
  status: string;
  transcript: string;
  score: number | null;
  rubricScores: string | null;
  feedback: string | null;
};

type Json = Record<string, any>;

async function post(url: string, body: Json): Promise<{ ok: boolean; status: number; data: Json }> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Json = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON error body; leave data empty.
  }
  return { ok: res.ok, status: res.status, data };
}

export const demoApi = {
  async requestCode(email: string) {
    const { ok, data } = await post("/api/demo/request-code", { email });
    if (!ok) throw new Error(data.message ?? "We couldn't send your code. Please try again.");
    return data as { ok: true; limitReached?: boolean; remaining?: number };
  },

  async verify(email: string, code: string) {
    const { ok, data } = await post("/api/demo/verify", { email, code });
    if (!ok) throw new Error(data.message ?? "That code is incorrect or has expired.");
    return data as { verified: true; token?: string; limitReached?: boolean; remaining?: number };
  },

  async startSession(token: string, scenario?: string) {
    const { ok, data } = await post("/api/demo/session", { token, scenario });
    if (!ok) {
      const err = new Error(data.message ?? "Couldn't start the demo.") as Error & { limitReached?: boolean };
      err.limitReached = !!data.limitReached;
      throw err;
    }
    return data as { session: DemoSession; scenario: DemoScenario; remaining: number };
  },

  async getSession(token: string, id: number) {
    const res = await fetch(`${API_BASE}/api/demo/session/${id}?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return data.session as DemoSession;
  },

  async sendMessage(token: string, id: number, content: string, withAudio: boolean) {
    const { ok, data } = await post(`/api/demo/session/${id}/message`, { token, content, withAudio });
    if (!ok) throw new Error(data.message ?? "Message failed to send.");
    return data.session as DemoSession;
  },

  async complete(token: string, id: number) {
    const { ok, data } = await post(`/api/demo/session/${id}/complete`, { token });
    if (!ok) throw new Error(data.message ?? "Couldn't score the session.");
    return data.session as DemoSession;
  },

  async submitLead(lead: { name: string; email: string; company?: string; teamSize?: string; message?: string }) {
    const { ok, data } = await post("/api/demo/lead", lead);
    if (!ok) throw new Error(data.message ?? "Couldn't submit. Please try again.");
    return data as { ok: true; id: number };
  },
};

export function parseTranscript(json: string | null | undefined): TranscriptMessage[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
