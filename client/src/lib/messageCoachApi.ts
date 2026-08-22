// Thin client for the Message Coach API (/api/message-coach/*). Same shape as
// demoV2Api.ts, including the build-time API base substitution.
//
// Every endpoint 404s when the server's MESSAGE_COACH_ENABLED flag is not
// "true". The page calls config() first and renders its "not available" state
// on a 404, so a deployment with the flag off shows a coherent page instead of
// a broken form.

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export type MessageCoachResult = {
  score: number;
  stalledStep: string;
  coaching: string;
  // First touch, rewritten from the original message.
  rewrite: string;
  // Second touch, intended only when the first touch receives no reply.
  followUp: string;
  demoEntryPoint: "try_one_conversation" | "command_center";
  source: "free" | "paid" | "member";
};

// A refusal the page has a real UI for, rather than an error to surface raw.
// 402 means the free score is spent (show the paywall); 409 means the payment
// webhook has not landed yet (retry shortly).
export type MessageCoachRefusal = {
  kind: "payment_required" | "confirming";
  message: string;
};

export class MessageCoachError extends Error {}

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

export const messageCoachApi = {
  // Returns null when the feature flag is off, which the page renders as the
  // "not available" state.
  async config(): Promise<{ priceCents: number } | null> {
    const res = await fetch(`${API_BASE}/api/message-coach/config`);
    if (res.status === 404) return null;
    if (!res.ok) throw new MessageCoachError("We couldn't load Message Coach. Please refresh.");
    const data = await res.json();
    return { priceCents: data.priceCents as number };
  },

  async score(args: {
    name?: string;
    email?: string;
    message: string;
    industry?: string | null;
    paidCheckoutSessionId?: string | null;
    userId?: number | null;
    verificationToken?: string | null;
  }): Promise<MessageCoachResult | MessageCoachRefusal> {
    const { ok, status, data } = await post("/api/message-coach/score", {
      name: args.name,
      email: args.email,
      message: args.message,
      industry: args.industry ?? undefined,
      paidCheckoutSessionId: args.paidCheckoutSessionId ?? undefined,
      userId: args.userId ?? undefined,
      verificationToken: args.verificationToken ?? undefined,
    });
    if (ok) return data as MessageCoachResult;
    if (status === 402) {
      return { kind: "payment_required", message: String(data.message ?? "") };
    }
    if (status === 409) {
      return { kind: "confirming", message: String(data.message ?? "") };
    }
    throw new MessageCoachError(
      data.message ?? "We couldn't score that message. Please try again.",
    );
  },

  async checkout(args: { email: string; name?: string; verificationToken?: string | null }): Promise<string> {
    const { ok, data } = await post("/api/message-coach/checkout", {
      email: args.email,
      name: args.name,
      verificationToken: args.verificationToken ?? undefined,
    });
    if (!ok || typeof data.url !== "string") {
      throw new MessageCoachError(
        data.message ?? "We couldn't open checkout. Please try again.",
      );
    }
    return data.url;
  },

  // Step 1 of the anonymous-visitor email gate: request a 6-digit code.
  async requestCode(email: string): Promise<{ ok: true }> {
    const { ok, data } = await post("/api/message-coach/request-code", { email });
    if (!ok) {
      throw new MessageCoachError(
        data.message ?? "We couldn't send your code. Please try again.",
      );
    }
    return data as { ok: true };
  },

  // Step 2: submit the code, get back the token that unlocks score/checkout.
  async verifyCode(email: string, code: string): Promise<{ verified: true; token: string }> {
    const { ok, data } = await post("/api/message-coach/verify-code", { email, code });
    if (!ok || typeof data.token !== "string") {
      throw new MessageCoachError(
        data.message ?? "That code is incorrect or has expired.",
      );
    }
    return data as { verified: true; token: string };
  },
};
