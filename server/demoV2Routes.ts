// Demo v2 HTTP surface. This is the only demo session flow: the visitor picks an
// industry before every session and never sees the same scenario twice inside an
// industry (see pickNextV2Scenario). Everything else is deliberately the same
// code as the real platform: the same roleplay pipeline, the same scoreTranscript
// call with the same four arguments, the same rubric, the same 85 standard, the
// same beginner leniency, the same score cache. Nothing about scoring is
// re-derived here.
//
// These handlers answer under DEMO_API_BASE (/api/demo/*). They were originally
// mounted at /api/demo-v2/* alongside the retired v1 session routes; that
// parallel prefix is gone and only this flow serves /api/demo/session*.
//
// Email verification is NOT duplicated. The client calls the existing
// /api/demo/request-code and /api/demo/verify, which only touch demo_signups and
// issue the voice-scoped token accepted here. The Command Center demo reuses the
// same OTP helpers through its own routes, but its dashboard-scoped token is
// deliberately rejected here. Lead capture likewise reuses /api/demo/lead.
// Those three voice-demo routes are registered in server/routes.ts and are the
// only voice-demo routes not defined in this file.
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { storage } from "./storage";
import {
  normalizeEmail,
  verifyDemoToken,
  isSessionLimitReached,
  remainingSessions,
  isUnlimitedDemoEmail,
  isDeviceLimitReached,
  isIpLimitReached,
  countDemoSessionsInIpWindow,
  isVoiceUnlockedForDemo,
} from "./demo";
import {
  availablePaidSessionCredits,
  consumeOldestPaidCredit,
  createDemoSessionCheckout,
} from "./demoPayments";
import { isStripeConfigured } from "./stripe";
import {
  DEMO_V2_INDUSTRIES,
  DEMO_V2_ALL_SLUGS,
  demoV2Scenario,
  industryForSlug,
  isDemoV2Industry,
  pickNextV2Scenario,
  type DemoV2ScenarioOption,
} from "./demoV2";
import {
  getCustomerOpening,
  getCustomerReply,
  scoreTranscript,
  scenarioTrack,
  hasProposedRecommendation,
  checkVulgarBaitStrike,
} from "./llm";
import { VULGAR_ENDED_STATUS } from "./vulgarBait";
import { deriveStalledStep } from "./realConversations";
import { personaCoreFor, personaOpeningCoreFor, sessionVariantSection } from "./persona";
import { getVoiceForScenario, getVoiceInstructionsForScenario } from "./voices";
import { historyForTurn, runReplyStream } from "./turnStream";
import { transcriptMessageSchema, type DemoSession, type DemoSignup, type RubricScores, type Scenario, type TranscriptMessage } from "@shared/schema";

// The pieces of server/routes.ts that v2 needs are module-private there (a
// RateLimiter instance, the proxy-aware IP reader, the TTS streamer). They are
// injected rather than copied so v2 shares the exact same rate-limit budget and
// the exact same audio cache behavior as v1 instead of forking them.
export type DemoV2Deps = {
  clientIp: (req: Request) => string;
  demoLimiter: { check: (key: string) => boolean };
  streamMessageAudio: (
    res: Response,
    opts: {
      msgId: string;
      text: string;
      voice: string;
      instructions?: string;
      setStatus: (status: "ready" | "failed") => Promise<void>;
    },
  ) => Promise<void>;
  updateDemoMsgAudioStatus: (sessionId: number, msgId: string, status: "ready" | "failed") => Promise<void>;
  updateDemoMsgContentAndStatus: (
    sessionId: number,
    msgId: string,
    content: string,
    status: "ready" | "failed",
    sessionEnded?: boolean,
  ) => Promise<void>;
};

export const DEMO_V2_FLOW = "v2";

// The public demo's URL prefix. Declared once so the route registrations and the
// audio-stream URL handed to the client can never drift apart.
export const DEMO_API_BASE = "/api/demo";

function publicDemoSession(s: DemoSession) {
  return {
    id: s.id,
    scenarioId: s.scenarioId,
    status: s.status,
    transcript: s.transcript,
    score: s.score,
    rubricScores: s.rubricScores,
    feedback: s.feedback,
  };
}

// Demo sessions signal an ended-by-vulgarity session the same way real
// sessions do: `status === VULGAR_ENDED_STATUS` (see server/vulgarBait.ts).
// publicDemoSession already forwards `status` as-is, so the frontend can read
// this straight off the session object; kept as a tiny named helper anyway so
// the check has one obvious spelling everywhere it's needed, matching how
// closeCheckpoint is a named concept on the real-session side.
function isDemoSessionEnded(s: { status: string }): boolean {
  return s.status === VULGAR_ENDED_STATUS;
}

// Loads the v2 scenario rows and shapes them into picker candidates, in the
// fixed per-industry order declared in demoV2.ts. Missing rows (an unseeded
// database) are skipped rather than throwing, so one absent scenario degrades to
// a smaller pool instead of taking the flow down.
export async function loadDemoV2Pool(): Promise<DemoV2ScenarioOption[]> {
  const pool: DemoV2ScenarioOption[] = [];
  for (const slug of DEMO_V2_ALL_SLUGS) {
    const scenario = await storage.getScenarioBySlug(slug);
    if (!scenario) continue;
    const industry = industryForSlug(slug);
    if (!industry) continue;
    pool.push({ id: scenario.id, slug, industry });
  }
  return pool;
}

// Every scenario a demo session actually runs on is loaded through here, so the
// demo can never see a difficulty other than Beginner (see demoV2Scenario). The
// pool loader above deliberately does not use it: it only reads id and slug to
// build picker candidates, and never runs a conversation.
async function loadDemoScenario(id: number): Promise<Scenario | undefined> {
  const scenario = await storage.getScenario(id);
  return scenario ? demoV2Scenario(scenario) : undefined;
}

export function registerDemoV2Routes(app: Express, deps: DemoV2Deps): void {
  const { clientIp, demoLimiter, streamMessageAudio, updateDemoMsgAudioStatus, updateDemoMsgContentAndStatus } = deps;

  async function requireDemoSignup(req: Request, res: Response): Promise<DemoSignup | null> {
    const payload = verifyDemoToken(req.body?.token ?? req.query?.token);
    if (!payload || payload.scope !== "voice") {
      res.status(401).json({ message: "Your demo session has expired. Please verify your email again." });
      return null;
    }
    const signup = await storage.getDemoSignupByEmail(normalizeEmail(payload.email));
    if (!signup || !signup.verified) {
      res.status(401).json({ message: "Please verify your email to start the demo." });
      return null;
    }
    return signup;
  }

  // The industry choices, served rather than hardcoded in the client, so the two
  // never drift apart.
  app.get(`${DEMO_API_BASE}/options`, (_req, res) => {
    res.json({ options: DEMO_V2_INDUSTRIES });
  });

  // Start a session in the chosen industry. All three fair-use caps (email,
  // device, IP) are enforced here, with increment-before-create ordering so a
  // refresh cannot buy an extra run.
  app.post(`${DEMO_API_BASE}/session`, async (req, res) => {
    if (!demoLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const parsed = z
      .object({ industry: z.string().trim() })
      .safeParse({ industry: req.body?.industry ?? "" });
    if (!parsed.success || !isDemoV2Industry(parsed.data.industry)) {
      return res.status(400).json({ message: "Please choose an industry to begin." });
    }
    const industry = parsed.data.industry;

    const signup = await requireDemoSignup(req, res);
    if (!signup) return;

    const fingerprint =
      typeof req.body?.fingerprint === "string" && req.body.fingerprint.trim()
        ? req.body.fingerprint.trim().slice(0, 128)
        : null;
    const ip = clientIp(req);

    // The free-vs-paid decision comes first, because a visitor who bought a
    // session must not then be turned away by the device/IP heuristics, which
    // exist purely to stop free-tier farming.
    const freeLimitReached = isSessionLimitReached(signup.sessionsUsed, signup.email);
    const usingPaidCredit = freeLimitReached && (await availablePaidSessionCredits(signup.id)) > 0;

    if (freeLimitReached && !usingPaidCredit) {
      return res.status(403).json({
        message: "You've used your free demo session. Purchase an individual session to keep practicing.",
        limitReached: true,
        remaining: 0,
        reason: "email",
      });
    }

    if (!usingPaidCredit) {
      const deviceCount = fingerprint
        ? (await storage.listDemoSessionsByFingerprint(fingerprint)).length
        : 0;
      if (isDeviceLimitReached(deviceCount, signup.email)) {
        return res.status(403).json({ message: "You've used all your free practice sessions.", limitReached: true, remaining: 0, reason: "device" });
      }

      const ipRows = await storage.listDemoSessionsByIp(ip);
      if (isIpLimitReached(countDemoSessionsInIpWindow(ipRows), signup.email)) {
        return res.status(403).json({ message: "You've used all your free practice sessions.", limitReached: true, remaining: 0, reason: "ip" });
      }
    }

    const pool = await loadDemoV2Pool();
    const priorSessions = await storage.listDemoSessionsBySignup(signup.id);
    // Only v2 rows count toward the exclusion set, so a visitor who already ran
    // the original demo flow still gets an unseen scenario here.
    const priorV2 = priorSessions.filter((row) => row.flow === DEMO_V2_FLOW);
    let choice: DemoV2ScenarioOption;
    try {
      choice = pickNextV2Scenario(industry, priorV2, pool);
    } catch {
      return res.status(500).json({ message: "Demo is temporarily unavailable." });
    }
    const scenario = await loadDemoScenario(choice.id);
    if (!scenario) return res.status(500).json({ message: "Demo is temporarily unavailable." });

    // sessionsUsed counts FREE sessions only, so a paid session must leave it
    // alone: purchases are tracked entirely in demo_paid_sessions.
    const updatedSignup =
      usingPaidCredit || isUnlimitedDemoEmail(signup.email)
        ? signup
        : await storage.updateDemoSignup(signup.id, { sessionsUsed: signup.sessionsUsed + 1 });
    const sessionNumber = usingPaidCredit
      ? priorSessions.length + 1
      : isUnlimitedDemoEmail(signup.email)
        ? signup.sessionsUsed + 1
        : updatedSignup?.sessionsUsed ?? signup.sessionsUsed + 1;

    let session = await storage.createDemoSession({
      signupId: signup.id,
      email: signup.email,
      scenarioId: scenario.id,
      status: "in_progress",
      transcript: "[]",
      score: null,
      rubricScores: null,
      feedback: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      deviceFingerprint: fingerprint,
      ipAddress: ip,
      sessionNumber,
      flow: DEMO_V2_FLOW,
    });

    // Claim the credit atomically now that the session row exists to link it to.
    // The earlier count is not trusted: if the claim finds nothing (a race, or a
    // credit spent by a parallel request) the session runs as an unpaid one, so
    // voice stays locked, rather than silently handing out a paid session.
    if (usingPaidCredit) {
      if (await consumeOldestPaidCredit(signup.id, session.id)) {
        session = (await storage.getDemoSession(session.id)) ?? session;
      } else {
        console.error(
          `Demo session ${session.id} passed the paid-credit check but no credit could be claimed for signup ${signup.id}`,
        );
      }
    }
    const voiceEnabled = isVoiceUnlockedForDemo(session.paidSessionId, signup.email);

    try {
      const variantSection = sessionVariantSection(scenario, { id: session.id, personaVariant: null });
      const openingText = await getCustomerOpening(personaOpeningCoreFor(scenario), scenario.track, variantSection);
      if (openingText) {
        const openingMsg = transcriptMessageSchema.parse({
          role: "customer",
          content: openingText,
          audioStatus: "none",
          msgId: randomUUID(),
          timestamp: new Date().toISOString(),
        });
        session = (await storage.updateDemoSession(session.id, {
          transcript: JSON.stringify([openingMsg]),
        })) ?? session;
      }
    } catch (err) {
      console.error("Demo v2 opening generation failed; starting empty:", err);
    }

    res.json({
      session: publicDemoSession(session),
      remaining: remainingSessions(updatedSignup?.sessionsUsed ?? signup.sessionsUsed + 1, signup.email),
      voiceEnabled,
      industry,
      scenario: {
        id: scenario.id,
        slug: scenario.slug,
        title: scenario.title,
        briefing: scenario.briefing,
        track: scenario.track,
        gender: scenario.gender,
      },
    });
  });

  app.get(`${DEMO_API_BASE}/session/:id`, async (req, res) => {
    const signup = await requireDemoSignup(req, res);
    if (!signup) return;
    const session = await storage.getDemoSession(Number(req.params.id));
    if (!session || session.signupId !== signup.id) {
      return res.status(404).json({ message: "Session not found" });
    }
    res.json({ session: publicDemoSession(session) });
  });

  // A conversational turn. Escalation tier is pinned to 0 and voice is gated to
  // paid sessions only (see isVoiceUnlockedForDemo). In voice mode the reply is
  // streamed exactly as it is for real trainee sessions: this handler does not
  // block on the LLM, it appends an empty customer placeholder and hands back an
  // SSE URL that the shared streamer fills in sentence by sentence (see
  // /turn-stream below).
  app.post(`${DEMO_API_BASE}/session/:id/message`, async (req, res) => {
    try {
      if (!demoLimiter.check(clientIp(req))) {
        return res.status(429).json({ message: "Too many requests. Please slow down." });
      }
      const signup = await requireDemoSignup(req, res);
      if (!signup) return;
      const session = await storage.getDemoSession(Number(req.params.id));
      if (!session || session.signupId !== signup.id) {
        return res.status(404).json({ message: "Session not found" });
      }
      const scenario = await loadDemoScenario(session.scenarioId);
      if (!scenario) return res.status(404).json({ message: "Conversation not found" });

      // A session already ended by the second vulgar/belligerent strike is
      // terminal (see server/vulgarBait.ts): reject/no-op instead of letting a
      // stray retry re-open or re-score it.
      if (isDemoSessionEnded(session)) {
        return res.status(409).json({ message: "session_ended", sessionEnded: true });
      }

      const voiceUnlocked = isVoiceUnlockedForDemo(session.paidSessionId, signup.email);
      const { content, withAudio, stream } = req.body ?? {};
      const useAudio = Boolean(withAudio) && voiceUnlocked;
      const transcript = JSON.parse(session.transcript);
      transcript.push(
        transcriptMessageSchema.parse({
          role: "consultant",
          content,
          timestamp: new Date().toISOString(),
        }),
      );

      const msgId = randomUUID();

      // Same up-front vulgar-bait short-circuit as the real-session message
      // route (see server/routes.ts for the full rationale): checked here so
      // the /message response can synchronously tell the frontend sessionEnded
      // even for the streaming/voice branch below, and so a baiting message
      // never burns an LLM call. getCustomerReply/streamCustomerReply still
      // hold the single source of truth for the actual reply-selection logic
      // (checkVulgarBaitStrike in server/llm.ts); this just reads the same
      // derivation early enough to route around the SSE hand-off entirely.
      const strike = checkVulgarBaitStrike(transcript);
      if (strike) {
        transcript.push(
          transcriptMessageSchema.parse({
            role: "customer",
            content: strike.text,
            audioStatus: "none",
            msgId,
            timestamp: new Date().toISOString(),
          }),
        );
        const patch: Record<string, unknown> = { transcript: JSON.stringify(transcript) };
        if (strike.sessionEnded) {
          // Terminal: end the session, do not score it -- this was never a
          // real practice attempt to grade.
          patch.status = VULGAR_ENDED_STATUS;
          patch.completedAt = new Date().toISOString();
        }
        const updated = await storage.updateDemoSession(session.id, patch);
        return res.json({ session: publicDemoSession(updated!), sessionEnded: strike.sessionEnded });
      }

      if (stream && useAudio) {
        transcript.push(
          transcriptMessageSchema.parse({
            role: "customer",
            content: "",
            audioStatus: "pending",
            // Replay uses this same-msg endpoint later, once content is filled in.
            audioUrl: `${DEMO_API_BASE}/session/${session.id}/audio-stream/${msgId}`,
            msgId,
            timestamp: new Date().toISOString(),
          }),
        );
        const streamed = await storage.updateDemoSession(session.id, { transcript: JSON.stringify(transcript) });
        return res.json({
          session: publicDemoSession(streamed!),
          streamMsgId: msgId,
          replyStreamUrl: `${DEMO_API_BASE}/session/${session.id}/turn-stream/${msgId}`,
        });
      }

      const variantSection = sessionVariantSection(scenario, { id: session.id, personaVariant: null });
      const customerReply = await getCustomerReply(personaCoreFor(scenario), transcript, scenario.difficulty, 0, variantSection);
      transcript.push(
        transcriptMessageSchema.parse({
          role: "customer",
          content: customerReply.text,
          audioStatus: useAudio ? "pending" : "none",
          audioUrl: useAudio ? `${DEMO_API_BASE}/session/${session.id}/audio-stream/${msgId}` : undefined,
          msgId,
          timestamp: new Date().toISOString(),
        }),
      );

      // Defense-in-depth mirror of the real-session route: customerReply.sessionEnded
      // should already have been caught by the up-front `strike` check above, but
      // handle it here too in case getCustomerReply's own internal check is what
      // actually fired.
      const patch: Record<string, unknown> = { transcript: JSON.stringify(transcript) };
      if (customerReply.sessionEnded) {
        patch.status = VULGAR_ENDED_STATUS;
        patch.completedAt = new Date().toISOString();
      }

      const updated = await storage.updateDemoSession(session.id, patch);
      res.json({ session: publicDemoSession(updated!), sessionEnded: customerReply.sessionEnded });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to process message" });
    }
  });

  // Not signup-gated: the request comes from an <audio> element that cannot carry
  // the demo token, and the unguessable msgId is the capability. Voice is
  // re-checked server side so a crafted request cannot spend TTS budget on a
  // locked session.
  app.get(`${DEMO_API_BASE}/session/:id/audio-stream/:msgId`, async (req, res) => {
    const session = await storage.getDemoSession(Number(req.params.id));
    if (!session) return res.status(404).end();
    if (!isVoiceUnlockedForDemo(session.paidSessionId, session.email)) {
      return res.status(403).end();
    }
    const transcript: TranscriptMessage[] = JSON.parse(session.transcript);
    const msg = transcript.find((m) => m.msgId === req.params.msgId && m.role === "customer");
    if (!msg) return res.status(404).end();
    const scenario = await loadDemoScenario(session.scenarioId);
    if (!scenario) return res.status(404).end();
    await streamMessageAudio(res, {
      msgId: req.params.msgId,
      text: msg.content,
      voice: getVoiceForScenario(scenario.slug, scenario.gender),
      instructions: getVoiceInstructionsForScenario(scenario.slug),
      setStatus: (status) => updateDemoMsgAudioStatus(session.id, req.params.msgId, status),
    });
  });

  // Server-Sent Events turn stream, the demo's half of the same streaming
  // pipeline real trainee sessions use: the shared streamer generates the reply
  // for the placeholder created by POST /message and pushes one `sentence` event
  // per sentence the moment that sentence's audio is synthesized, so the first
  // one plays while the rest are still being generated. Gated the same way the
  // audio-stream route is (unguessable msgId as the capability, since EventSource
  // requests cannot carry the demo token, plus a server-side voice re-check).
  app.get(`${DEMO_API_BASE}/session/:id/turn-stream/:msgId`, async (req, res) => {
    const session = await storage.getDemoSession(Number(req.params.id));
    if (!session) return res.status(404).end();
    if (!isVoiceUnlockedForDemo(session.paidSessionId, session.email)) {
      return res.status(403).end();
    }
    const transcript: TranscriptMessage[] = JSON.parse(session.transcript);
    const placeholder = transcript.find((m) => m.msgId === req.params.msgId && m.role === "customer");
    if (!placeholder) return res.status(404).end();
    const scenario = await loadDemoScenario(session.scenarioId);
    if (!scenario) return res.status(404).end();
    await runReplyStream(res, {
      msgId: req.params.msgId,
      history: historyForTurn(transcript, req.params.msgId),
      scenario,
      // Demo sessions never escalate difficulty within a level.
      escalationTier: 0,
      variantSection: sessionVariantSection(scenario, { id: session.id, personaVariant: null }),
      voice: getVoiceForScenario(scenario.slug, scenario.gender),
      instructions: getVoiceInstructionsForScenario(scenario.slug),
      persist: (content, status, sessionEnded) =>
        updateDemoMsgContentAndStatus(session.id, req.params.msgId, content, status, sessionEnded),
    });
  });

  // End and score. The scoreTranscript call is byte-for-byte the v1/real call
  // with the same four arguments (plus, demo-only, the noRecommendationHint
  // deps field below), so the rubric, the 85 standard, the beginner leniency,
  // and the score cache all apply unchanged.
  //
  // UNLIKE the real-session /complete route in server/routes.ts, this route no
  // longer blocks on hasProposedRecommendation. A visitor only gets one demo
  // attempt (see the frontend's one-shot confirm dialog in demo-v2.tsx), so
  // refusing to score an incomplete one just leaves them with nothing --
  // exactly what happened in the real incident this change exists for (a
  // hostile demo conversation that never reached a recommendation, correctly
  // 409'd by the old gate, but with no visible way for the visitor to force a
  // score). Instead, whether a recommendation was ever proposed is threaded
  // into scoreTranscript as a hint so the coaching feedback addresses the gap
  // directly rather than blocking completion outright. `force` is still
  // accepted on the request body for backward compatibility with any
  // in-flight frontend build, but is now unused -- there is no gate left to
  // force past.
  app.post(`${DEMO_API_BASE}/session/:id/complete`, async (req, res) => {
    try {
      const signup = await requireDemoSignup(req, res);
      if (!signup) return;
      const session = await storage.getDemoSession(Number(req.params.id));
      if (!session || session.signupId !== signup.id) {
        return res.status(404).json({ message: "Session not found" });
      }
      const transcript = JSON.parse(session.transcript);

      const proposed = await hasProposedRecommendation(transcript);

      const scenario = await loadDemoScenario(session.scenarioId);
      const track = scenarioTrack(scenario?.track);
      const { rubric, feedback, overall } = await scoreTranscript(
        transcript,
        scenario?.difficulty,
        track,
        scenario?.transactionType,
        { noRecommendationHint: !proposed },
      );
      const updated = await storage.updateDemoSession(session.id, {
        status: "completed",
        score: overall,
        rubricScores: JSON.stringify(rubric),
        feedback,
        completedAt: new Date().toISOString(),
      });
      res.json({
        session: publicDemoSession(updated!),
        // Presentation-only derivation over the unchanged stored rubric.
        stalledStep: deriveStalledStep(rubric as RubricScores),
      });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to score session" });
    }
  });

  // Start the one-time $4.99 purchase of a single practice session. Gated by the
  // same verified-signup helper as the session routes, so only a visitor who has
  // already verified their email can buy. Returns { url } for the client to hand
  // off to Stripe Checkout, matching the office checkout routes in
  // server/routes.ts. The credit is granted by the webhook, never by the
  // redirect (see server/demoPayments.ts).
  app.post(`${DEMO_API_BASE}/checkout`, async (req, res) => {
    const signup = await requireDemoSignup(req, res);
    if (!signup) return;
    // With no Stripe keys the app still boots and the free session still works;
    // only this endpoint is unavailable.
    if (!isStripeConfigured()) {
      return res.status(503).json({ message: "Purchasing is not available right now." });
    }
    try {
      const url = await createDemoSessionCheckout({ signupId: signup.id, email: signup.email });
      res.json({ url });
    } catch (err: any) {
      console.error("Demo paid-session checkout creation failed:", err);
      res.status(500).json({ message: err.message ?? "Could not start checkout" });
    }
  });
}
