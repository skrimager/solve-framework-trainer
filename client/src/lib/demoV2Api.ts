// Thin client for the public demo API (/api/demo/*). Kept separate from the
// retired demoApi.ts rather than merged into it, so the retired single-scenario
// client can stay in the repo for reference without this one depending on it.
//
// Three endpoints are flow-agnostic and are still served by server/routes.ts
// directly: the email code pair (/api/demo/request-code, /api/demo/verify), which
// only touches demo_signups, and /api/demo/lead, which is generic lead capture.
// Everything session-shaped is served by server/demoV2Routes.ts.
import type { TranscriptMessage } from "@shared/schema";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export type DemoV2Industry = {
  key: "auto" | "real_estate";
  label: string;
  blurb: string;
};

export type DemoV2Scenario = {
  id: number;
  slug: string;
  title: string;
  briefing: string;
  track: string | null;
  gender: string | null;
};

export type DemoV2Session = {
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

export const demoV2Api = {
  async options() {
    const res = await fetch(`${API_BASE}/api/demo/options`);
    if (!res.ok) throw new Error("Couldn't load the industry list.");
    const data = await res.json();
    return data.options as DemoV2Industry[];
  },

  // Flow-agnostic: nothing about the code email or the signed token is specific
  // to a demo flow.
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

  async startSession(token: string, industry: string, fingerprint?: string) {
    const { ok, data } = await post("/api/demo/session", { token, industry, fingerprint });
    if (!ok) {
      const err = new Error(data.message ?? "Couldn't start the practice conversation.") as Error & {
        limitReached?: boolean;
      };
      err.limitReached = !!data.limitReached;
      throw err;
    }
    return data as {
      session: DemoV2Session;
      scenario: DemoV2Scenario;
      remaining: number;
      voiceEnabled: boolean;
      industry: string;
    };
  },

  async getSession(token: string, id: number) {
    const res = await fetch(`${API_BASE}/api/demo/session/${id}?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return data.session as DemoV2Session;
  },

  async sendMessage(token: string, id: number, content: string, withAudio: boolean) {
    const { ok, data } = await post(`/api/demo/session/${id}/message`, { token, content, withAudio });
    if (!ok) throw new Error(data.message ?? "Message failed to send.");
    return data.session as DemoV2Session;
  },

  // `force` skips the completeness gate. The UI sends it only after the visitor
  // is told the conversation looks unfinished and chooses to score it anyway.
  async complete(token: string, id: number, force = false) {
    const { ok, status, data } = await post(`/api/demo/session/${id}/complete`, { token, force });
    if (!ok) {
      const err = new Error(data.message ?? "Couldn't score the conversation.") as Error & {
        incomplete?: boolean;
      };
      err.incomplete = status === 409 && !!data.incomplete;
      throw err;
    }
    return data as { session: DemoV2Session; stalledStep: string | null };
  },

  // Generic lead capture, nothing demo-flow specific in it.
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
