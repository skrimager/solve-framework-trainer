import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { storage } from "./storage";
import { getCustomerReply, getCustomerOpening, scoreTranscript, synthesizeSpeech, hasProposedRecommendation, detectCloseIntent, computeLevelAdvancement, scoresForTrackAtLevel, scenarioTrack, isExamEligible, countQualifyingSessions, computeEscalationTier, REQUIRED_QUALIFYING_SESSIONS, ADVANCE_THRESHOLD, gradeWrittenAnswer, WrittenGradingUnavailableError } from "./llm";
import {
  normalizeTrack,
  drawExam,
  getQuestions,
  toPublicQuestion,
  gradeWrittenExam,
  questionBankSize,
  EXAM_QUESTION_COUNT,
  WRITTEN_PASS_CORRECT,
  WRITTEN_PASS_PERCENT,
  TRACK_CREDENTIAL,
  type Track,
} from "./certification";
import { getVoiceForScenario, getVoiceInstructionsForScenario } from "./voices";
import { getCoachingReply, type CoachingResponder, type CoachingThreadMessage } from "./coaching";
import { sendLeadNotification, sendDemoVerificationCode, sendProspectEmail, sendInboundEmail } from "./notifications";
import {
  buildSequence,
  planApproval,
  sendDueOutreach,
  startOutreachScheduler,
  enrollInboundLead,
  SEQUENCE_STEPS,
} from "./opportunities";
import {
  MAX_DEMO_SESSIONS,
  DEMO_SCENARIO_SLUG,
  normalizeEmail,
  generateVerificationCode,
  codeExpiryFrom,
  isCodeValid,
  isSessionLimitReached,
  remainingSessions,
  isUnlimitedDemoEmail,
  signDemoToken,
  verifyDemoToken,
  ctaSeatQuestion,
} from "./demo";
import {
  contactTypeSchema,
  contactPatchSchema,
  normalizeContactPatch,
  buildContactUpdateEvents,
  isFollowUpDue,
  DEFAULT_TYPE,
  DEFAULT_SOURCE,
  DEFAULT_PRIORITY,
  type ContactFilters,
} from "./contacts";
import { transcriptMessageSchema, type TranscriptMessage, type User, type Contact, type Session, type Scenario } from "@shared/schema";
import { seed } from "./seed";
import { isStripeConfigured, getStripe, STRIPE_WEBHOOK_SECRET } from "./stripe";
import {
  officeIsActive,
  createManagerCheckoutSession,
  createBillingPortalSession,
  setSeatQuantity,
  handleStripeEvent,
} from "./billing";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import type { Request, Response, NextFunction } from "express";
import {
  ADMIN_SESSION_COOKIE,
  verifyPassword,
  signAdminSession,
  verifyAdminSession,
  toCsv,
  summarizeSales,
  RateLimiter,
} from "./admin";

// Marketing-site origins allowed to call the public lead/visit endpoints cross-origin.
const ALLOWED_CORS_ORIGINS = new Set([
  "https://www.solveframework.com",
  "https://solveframework.com",
]);

// Reflect an allowed Origin back so the browser accepts the cross-origin POST.
function applyCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

// Parse a specific cookie value out of the raw Cookie header (no cookie-parser dep).
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

const leadsLimiter = new RateLimiter(5, 60 * 1000); // 5 lead submissions / IP / minute
const visitsLimiter = new RateLimiter(60, 60 * 1000); // 60 page-views / IP / minute
const demoLimiter = new RateLimiter(20, 60 * 1000); // 20 demo actions / IP / minute (code requests, verify, turns)

const AUDIO_DIR = path.join(process.cwd(), "audio_cache");
if (!fsSync.existsSync(AUDIO_DIR)) fsSync.mkdirSync(AUDIO_DIR, { recursive: true });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await seed();

  // --- Health check (verify environment is live) ---
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "SOLVE Framework Discovery Training Platform",
      timestamp: new Date().toISOString(),
    });
  });

  // --- Stripe webhook ---
  // Signature is verified against the exact raw request bytes captured by the global
  // express.json({ verify }) hook in server/index.ts. Idempotency + all side effects
  // live in handleStripeEvent. Always ack 2xx once verified so Stripe stops retrying.
  app.post("/api/webhooks/stripe", async (req, res) => {
    if (!isStripeConfigured() || !STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({ message: "Billing is not configured" });
    }
    const signature = req.headers["stripe-signature"];
    const raw = req.rawBody;
    if (!signature || !Buffer.isBuffer(raw)) {
      return res.status(400).json({ message: "Missing signature or raw body" });
    }
    let event;
    try {
      event = getStripe().webhooks.constructEvent(raw, signature as string, STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      console.error("Stripe webhook signature verification failed:", err?.message);
      return res.status(400).json({ message: `Webhook signature verification failed` });
    }
    try {
      await handleStripeEvent(event);
      res.json({ received: true });
    } catch (err: any) {
      // A processing error should return 5xx so Stripe retries later.
      console.error("Error handling Stripe event:", err);
      res.status(500).json({ message: "Error handling event" });
    }
  });

  // --- Billing: manager-initiated Checkout + self-serve portal + seat purchase ---
  // Create a Stripe Checkout Session for the manager's office subscription.
  app.post("/api/billing/checkout", async (req, res) => {
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });
    const { userId } = req.body ?? {};
    const user = await storage.getUser(Number(userId));
    if (!user || user.role !== "manager") {
      return res.status(403).json({ message: "Only a manager can start checkout" });
    }
    const office = await storage.getOffice(user.officeId);
    if (!office) return res.status(404).json({ message: "Office not found" });
    if (officeIsActive(office)) {
      return res.status(409).json({ message: "This office already has an active subscription" });
    }
    try {
      const url = await createManagerCheckoutSession(office, user.username);
      res.json({ url });
    } catch (err: any) {
      console.error("Checkout session creation failed:", err);
      res.status(500).json({ message: err.message ?? "Could not start checkout" });
    }
  });

  // Create a Stripe Billing Portal session so a manager can manage their subscription.
  app.post("/api/billing/portal", async (req, res) => {
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });
    const { userId } = req.body ?? {};
    const user = await storage.getUser(Number(userId));
    if (!user || user.role !== "manager") {
      return res.status(403).json({ message: "Only a manager can manage billing" });
    }
    const office = await storage.getOffice(user.officeId);
    if (!office) return res.status(404).json({ message: "Office not found" });
    if (!office.stripeCustomerId) {
      return res.status(409).json({ message: "No billing account exists for this office yet" });
    }
    try {
      const url = await createBillingPortalSession(office);
      res.json({ url });
    } catch (err: any) {
      console.error("Portal session creation failed:", err);
      res.status(500).json({ message: err.message ?? "Could not open billing portal" });
    }
  });

  // Manager buys their own training seat (the dashboard is admin-only; roleplay needs a
  // paid seat like any consultant). Increments the Stripe seat quantity FIRST, then marks
  // the manager's own user row seatActive so a Stripe failure never grants free access.
  app.post("/api/billing/manager-seat", async (req, res) => {
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });
    const { userId } = req.body ?? {};
    const user = await storage.getUser(Number(userId));
    if (!user || user.role !== "manager") {
      return res.status(403).json({ message: "Only a manager can buy their own seat" });
    }
    if (user.seatActive) {
      return res.status(409).json({ message: "You already have a training seat" });
    }
    const office = await storage.getOffice(user.officeId);
    if (!office) return res.status(404).json({ message: "Office not found" });
    if (!officeIsActive(office)) {
      return res.status(402).json({ message: "Your office subscription is not active" });
    }
    try {
      const targetQty = (await storage.countPaidSeats(office.id)) + 1;
      await setSeatQuantity(office, targetQty);
      const updated = await storage.updateUser(user.id, { seatActive: true });
      await storage.updateOffice(office.id, { activeSeatCount: targetQty });
      res.json({ user: publicUser(updated!) });
    } catch (err: any) {
      console.error("Manager seat purchase failed:", err);
      res.status(500).json({ message: err.message ?? "Could not add your seat" });
    }
  });

  // --- Auth (simple demo-credential login, no sessions/passwords hashing needed for pilot) ---
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    const user = await storage.getUserByUsername(username ?? "");
    if (!user || user.password !== password) {
      return res.status(401).json({ message: "Invalid username or password" });
    }
    res.json(publicUser(user));
  });

  // --- Registration (self-serve office sign-up) ---
  app.post("/api/register/manager", async (req, res) => {
    const schema = z.object({
      officeName: z.string().trim().min(1, "Office name is required"),
      username: z.string().trim().min(1, "Username is required"),
      password: z.string().min(1, "Password is required"),
      displayName: z.string().trim().min(1, "Your name is required"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const { officeName, username, password, displayName } = parsed.data;

    const existing = await storage.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ message: "That username is already taken. Please choose another." });
    }

    const inviteCode = await generateUniqueInviteCode();
    const office = await storage.createOffice({
      name: officeName,
      inviteCode,
      createdAt: new Date().toISOString(),
    });
    const user = await storage.createUser({
      officeId: office.id,
      username,
      password,
      role: "manager",
      displayName,
      currentLevel: "beginner",
    });

    res.json({ user: publicUser(user), office });
  });

  app.post("/api/register/consultant", async (req, res) => {
    const schema = z.object({
      inviteCode: z.string().trim().min(1, "Invite code is required"),
      username: z.string().trim().min(1, "Username is required"),
      password: z.string().min(1, "Password is required"),
      displayName: z.string().trim().min(1, "Your name is required"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const { inviteCode, username, password, displayName } = parsed.data;

    const office = await storage.getOfficeByInviteCode(inviteCode.trim().toUpperCase());
    if (!office) {
      return res.status(404).json({ message: "That invite code doesn't match any office. Double-check it with your manager." });
    }

    // A consultant can only join an office whose subscription is active — otherwise
    // there is nothing to attach a paid seat to.
    if (!officeIsActive(office)) {
      return res.status(402).json({ message: "This office's subscription isn't active yet. Ask your manager to complete billing setup." });
    }

    const existing = await storage.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ message: "That username is already taken. Please choose another." });
    }

    // Increment the Stripe seat quantity BEFORE creating the user, so a billing
    // failure never yields a free seat. Skipped only when Stripe isn't configured
    // (dev/demo), in which case the seat is granted locally.
    let seatActive = true;
    if (isStripeConfigured() && office.stripeSubscriptionId) {
      try {
        const targetQty = (await storage.countPaidSeats(office.id)) + 1;
        await setSeatQuantity(office, targetQty);
        await storage.updateOffice(office.id, { activeSeatCount: targetQty });
      } catch (err: any) {
        console.error("Failed to increment Stripe seat for new consultant:", err);
        return res.status(502).json({ message: "Couldn't reserve a billing seat. Please try again in a moment." });
      }
    }

    const user = await storage.createUser({
      officeId: office.id,
      username,
      password,
      role: "consultant",
      displayName,
      currentLevel: "beginner",
      seatActive,
    });

    res.json({ user: publicUser(user) });
  });

  // Remove (deactivate) a consultant's seat — decrements the Stripe seat quantity and
  // marks the user seatActive:false. No hard delete: their history is preserved.
  app.post("/api/offices/:id/seats/remove", async (req, res) => {
    const officeId = Number(req.params.id);
    const { requesterId, targetUserId } = req.body ?? {};
    const requester = await storage.getUser(Number(requesterId));
    if (!requester || requester.role !== "manager" || requester.officeId !== officeId) {
      return res.status(403).json({ message: "Only this office's manager can remove seats" });
    }
    const target = await storage.getUser(Number(targetUserId));
    if (!target || target.officeId !== officeId) {
      return res.status(404).json({ message: "User not found in this office" });
    }
    if (target.isDemoAccount) {
      return res.status(409).json({ message: "Demo accounts don't hold a paid seat" });
    }
    if (!target.seatActive) {
      return res.status(409).json({ message: "That user doesn't have an active seat" });
    }

    const office = await storage.getOffice(officeId);
    if (!office) return res.status(404).json({ message: "Office not found" });

    // Deactivate locally first so the seat is released even if Stripe lags, then set
    // Stripe quantity to the recomputed paid-seat count.
    await storage.updateUser(target.id, { seatActive: false });
    if (isStripeConfigured() && office.stripeSubscriptionId && office.seatItemId) {
      try {
        const remaining = await storage.countPaidSeats(office.id);
        await setSeatQuantity(office, remaining);
        await storage.updateOffice(office.id, { activeSeatCount: remaining });
      } catch (err: any) {
        console.error("Failed to decrement Stripe seat on removal:", err);
        // Local state already reflects removal; Stripe will reconcile via webhook.
      }
    }
    res.json({ ok: true });
  });

  // Fetch an office (used by the manager dashboard to display its invite code).
  app.get("/api/offices/:id", async (req, res) => {
    const office = await storage.getOffice(Number(req.params.id));
    if (!office) return res.status(404).json({ message: "Not found" });
    res.json(office);
  });

  // --- Scenarios ---
  app.get("/api/scenarios", async (req, res) => {
    const scenarios = await storage.listScenarios();
    let active = scenarios.filter((s) => s.active);
    // Optional ?track= filter so the client (consultant picker and admin
    // management) can request just one track's scenarios. Unknown/absent track
    // returns all active scenarios (back-compat).
    const track = typeof req.query.track === "string" ? req.query.track : undefined;
    if (track === "consulting" || track === "leadership") {
      active = active.filter((s) => scenarioTrack(s.track) === track);
    }
    res.json(active);
  });

  app.get("/api/scenarios/:id", async (req, res) => {
    const scenario = await storage.getScenario(Number(req.params.id));
    if (!scenario) return res.status(404).json({ message: "Not found" });
    res.json(scenario);
  });

  // --- Sessions (role-play attempts) ---
  app.post("/api/sessions", async (req, res) => {
    const { userId, scenarioId } = req.body ?? {};
    const gate = await checkSeatAccess(Number(userId));
    if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

    // Start every session with the customer's own opening line so the consultant
    // walks in cold (no pre-roleplay briefing) and must uncover the situation
    // through discovery. Falls back to an empty transcript if generation fails,
    // so a flaky LLM call never blocks starting a session.
    let openingTranscript = "[]";
    try {
      const scenario = await storage.getScenario(scenarioId);
      if (scenario) {
        const openingText = await getCustomerOpening(scenario.customerPersona, scenario.track);
        if (openingText) {
          const openingMsg = transcriptMessageSchema.parse({
            role: "customer",
            content: openingText,
            audioStatus: "none",
            msgId: randomUUID(),
            timestamp: new Date().toISOString(),
          });
          openingTranscript = JSON.stringify([openingMsg]);
        }
      }
    } catch (err) {
      console.error("Opening line generation failed; starting with empty transcript:", err);
    }

    // Starting a new attempt retires any SOLVE Coach follow-up thread from the
    // trainee's previous attempt: prior threads are soft-cleared so a fresh
    // attempt never shows the last attempt's Q&A (persistence is per-attempt,
    // not kept forever). Best-effort — a failure here must not block starting.
    try {
      await storage.clearCoachingMessagesForUser(Number(userId));
    } catch (err) {
      console.error("Failed to clear prior coaching threads:", err);
    }

    const session = await storage.createSession({
      userId,
      scenarioId,
      status: "in_progress",
      transcript: openingTranscript,
      score: null,
      rubricScores: null,
      feedback: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    res.json(session);
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const session = await storage.getSession(Number(req.params.id));
    if (!session) return res.status(404).json({ message: "Not found" });
    res.json(session);
  });

  app.get("/api/users/:userId/sessions", async (req, res) => {
    const sessions = await storage.listSessionsByUser(Number(req.params.userId));
    res.json(sessions);
  });

  // manager/QA: sessions across consultants, scoped to the requester's own office.
  app.get("/api/sessions", async (req, res) => {
    const requesterId = Number(req.query.requesterId);
    if (!requesterId) {
      return res.status(400).json({ message: "requesterId is required" });
    }
    const requester = await storage.getUser(requesterId);
    if (!requester) {
      return res.status(401).json({ message: "Unknown user" });
    }
    const sessions = await storage.listSessionsByOffice(requester.officeId);
    res.json(sessions);
  });

  // Consultant sends a message; get back the simulated customer's reply (+ optional audio)
  app.post("/api/sessions/:id/message", async (req, res) => {
    try {
      const session = await storage.getSession(Number(req.params.id));
      if (!session) return res.status(404).json({ message: "Session not found" });

      const gate = await checkSeatAccess(session.userId);
      if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

      const scenario = await storage.getScenario(session.scenarioId);
      if (!scenario) return res.status(404).json({ message: "Conversation not found" });

      const { content, withAudio } = req.body ?? {};
      const transcript = JSON.parse(session.transcript);

      const consultantMsg = transcriptMessageSchema.parse({
        role: "consultant",
        content,
        timestamp: new Date().toISOString(),
      });
      transcript.push(consultantMsg);

      // If the consultant appears to be wrapping up (goodbye, "here's my card",
      // "I'll follow up", etc.), we do NOT silently end the session or silently
      // keep it open. We still let the persona reply naturally, but flag the turn
      // so the client can raise an explicit checkpoint asking whether to end and
      // score now or continue the conversation.
      const closeCheckpoint = detectCloseIntent(content);

      // Within-level difficulty escalation ("dangle the carrot"): once the
      // trainee is consistently clearing the qualifying bar at this level, nudge
      // the persona incrementally harder. Computed from already-completed
      // sessions, so it is stable across this session's turns (keeping the
      // customer-reply prompt prefix cacheable). Defaults to base (tier 0) if the
      // lookup fails, so it can never break a turn.
      let escalationTier = 0;
      try {
        const track = scenarioTrack(scenario.track);
        const [allSessions, allScenarios] = await Promise.all([
          storage.listSessionsByUser(session.userId),
          storage.listScenarios(),
        ]);
        const scoresAtLevel = scoresForTrackAtLevel(track, scenario.difficulty, allSessions, allScenarios);
        escalationTier = computeEscalationTier(countQualifyingSessions(scoresAtLevel));
      } catch {
        escalationTier = 0;
      }

      const customerReplyText = await getCustomerReply(scenario.customerPersona, transcript, scenario.difficulty, escalationTier);

      const msgId = randomUUID();
      const customerMsg = transcriptMessageSchema.parse({
        role: "customer",
        content: customerReplyText,
        audioStatus: withAudio ? "pending" : "none",
        msgId,
        timestamp: new Date().toISOString(),
      });
      transcript.push(customerMsg);

      // Respond immediately with the text reply — never make the consultant wait on voice.
      const updated = await storage.updateSession(session.id, {
        transcript: JSON.stringify(transcript),
      });
      res.json({ ...updated, closeCheckpoint });

      // Generate audio in the background; the client polls /api/sessions/:id/audio-status/:msgId.
      if (withAudio) {
        synthesizeAudio(customerReplyText, getVoiceForScenario(scenario.slug, scenario.gender), getVoiceInstructionsForScenario(scenario.slug))
          .then(async (audioUrl) => {
            const latestSession = await storage.getSession(session.id);
            if (!latestSession) return;
            const latestTranscript: TranscriptMessage[] = JSON.parse(latestSession.transcript);
            const idx = latestTranscript.findIndex((m) => m.msgId === msgId);
            if (idx !== -1) {
              latestTranscript[idx] = { ...latestTranscript[idx], audioUrl, audioStatus: "ready" };
              await storage.updateSession(session.id, { transcript: JSON.stringify(latestTranscript) });
            }
          })
          .catch(async (err) => {
            console.error("Background TTS generation failed:", err);
            const latestSession = await storage.getSession(session.id);
            if (!latestSession) return;
            const latestTranscript: TranscriptMessage[] = JSON.parse(latestSession.transcript);
            const idx = latestTranscript.findIndex((m) => m.msgId === msgId);
            if (idx !== -1) {
              latestTranscript[idx] = { ...latestTranscript[idx], audioStatus: "failed" };
              await storage.updateSession(session.id, { transcript: JSON.stringify(latestTranscript) });
            }
          });
      }
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to process message" });
    }
  });

  // Complete a session and score it. Unless `force` is set, a session with no
  // recommendation/solution/close proposed yet is blocked so the client can
  // show the "consultation is incomplete" modal instead of scoring prematurely.
  app.post("/api/sessions/:id/complete", async (req, res) => {
    try {
      const session = await storage.getSession(Number(req.params.id));
      if (!session) return res.status(404).json({ message: "Session not found" });

      const transcript = JSON.parse(session.transcript);
      const { force } = req.body ?? {};

      if (!force) {
        const proposed = await hasProposedRecommendation(transcript);
        if (!proposed) {
          return res.status(409).json({ message: "incomplete", incomplete: true });
        }
      }

      // Score against the scenario's difficulty (stricter at higher levels) and
      // its track (consulting vs. leadership uses a different rubric).
      const scenario = await storage.getScenario(session.scenarioId);
      const track = scenarioTrack(scenario?.track);
      const { rubric, feedback, overall } = await scoreTranscript(transcript, scenario?.difficulty, track, scenario?.transactionType);

      const updated = await storage.updateSession(session.id, {
        status: "completed",
        score: overall,
        rubricScores: JSON.stringify(rubric),
        feedback,
        completedAt: new Date().toISOString(),
      });

      // If this completed session is the FINAL expert scenario of a certification
      // attempt, finalize the second half of the exam instead of ordinary
      // advancement. Certification requires BOTH parts: the written test must have
      // already passed in this attempt AND this scenario must score >= threshold.
      const certAttempt = await storage.getCertificationAttemptByScenarioSession(session.id);
      if (certAttempt && certAttempt.completedAt === null) {
        await finalizeCertificationScenario(certAttempt, overall);
        res.json(updated);
        return;
      }

      // Auto-advance the consultant's level for THIS track once they have
      // accumulated the required number of individually-qualifying (85+) sessions
      // at their current level's difficulty on this track. The two tracks advance
      // independently: only sessions on the same track count, and only that track's
      // level column is updated — so being Advanced in Consulting never advances or
      // certifies someone in Leadership. Reaching Advanced does NOT auto-certify;
      // it only makes the user exam-eligible (see the certification endpoints).
      const user = await storage.getUser(session.userId);
      if (user) {
        const [allSessions, allScenarios] = await Promise.all([
          storage.listSessionsByUser(user.id),
          storage.listScenarios(),
        ]);
        const levelForTrack = track === "leadership" ? user.leadershipLevel : user.currentLevel;
        const scoresAtLevel = scoresForTrackAtLevel(track, levelForTrack, allSessions, allScenarios);
        const nextLevel = computeLevelAdvancement(levelForTrack, scoresAtLevel);
        if (nextLevel) {
          await storage.updateUser(
            user.id,
            track === "leadership" ? { leadershipLevel: nextLevel } : { currentLevel: nextLevel },
          );
        }
      }

      res.json(updated);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to score session" });
    }
  });

  // Save an incomplete session for later instead of scoring it now.
  app.post("/api/sessions/:id/save-for-later", async (req, res) => {
    try {
      const session = await storage.getSession(Number(req.params.id));
      if (!session) return res.status(404).json({ message: "Session not found" });
      const updated = await storage.updateSession(session.id, {
        status: "saved",
        savedAt: new Date().toISOString(),
      });
      res.json(updated);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to save session" });
    }
  });

  // Resume a previously-saved session so it can continue in the role-play view.
  app.post("/api/sessions/:id/resume", async (req, res) => {
    try {
      const session = await storage.getSession(Number(req.params.id));
      if (!session) return res.status(404).json({ message: "Session not found" });
      const updated = await storage.updateSession(session.id, {
        status: "in_progress",
        savedAt: null,
      });
      res.json(updated);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to resume session" });
    }
  });

  // Get the current user's fresh level (used after a session completes to refresh the badge).
  app.get("/api/users/:userId", async (req, res) => {
    const user = await storage.getUser(Number(req.params.userId));
    if (!user) return res.status(404).json({ message: "Not found" });
    res.json(publicUser(user));
  });

  // Serve generated audio files
  app.get("/api/audio/:filename", (req, res) => {
    const filePath = path.join(AUDIO_DIR, req.params.filename);
    if (!fsSync.existsSync(filePath)) return res.status(404).end();
    res.setHeader("Content-Type", "audio/mpeg");
    res.sendFile(filePath);
  });

  // ===========================================================================
  // Certification exam (two distinct credentials, one per track, fully independent)
  // ===========================================================================

  // Per-track certification status for a user: level, whether they're already
  // certified, progress toward exam eligibility, and any in-flight attempt.
  app.get("/api/users/:userId/certification", async (req, res) => {
    const user = await storage.getUser(Number(req.params.userId));
    if (!user) return res.status(404).json({ message: "Not found" });
    const [allSessions, allScenarios, attempts] = await Promise.all([
      storage.listSessionsByUser(user.id),
      storage.listScenarios(),
      storage.listCertificationAttemptsByUser(user.id),
    ]);
    const tracks: Track[] = ["consulting", "leadership"];
    const status = Object.fromEntries(
      tracks.map((t) => [t, certStatusForTrack(user, t, allSessions, allScenarios, attempts)]),
    );
    res.json(status);
  });

  // Start a new exam attempt: draws a random 30-question set from the track's
  // bank. Requires the user to be exam-eligible (Advanced + 5 qualifying
  // Advanced sessions) and not already certified on that track.
  app.post("/api/certification/start", async (req, res) => {
    const { userId, track: rawTrack } = req.body ?? {};
    const track = normalizeTrack(rawTrack);
    const gate = await checkSeatAccess(Number(userId));
    if (!gate.ok) return res.status(gate.status).json({ message: gate.message });
    const user = await storage.getUser(Number(userId));
    if (!user) return res.status(404).json({ message: "User not found" });

    const [allSessions, allScenarios] = await Promise.all([
      storage.listSessionsByUser(user.id),
      storage.listScenarios(),
    ]);
    if (isTrackCertified(user, track)) {
      return res.status(409).json({ message: "You are already certified on this track." });
    }
    const level = track === "leadership" ? user.leadershipLevel : user.currentLevel;
    const advancedScores = scoresForTrackAtLevel(track, "advanced", allSessions, allScenarios);
    if (!isExamEligible(level, advancedScores)) {
      return res.status(403).json({ message: "You are not eligible for the certification exam yet." });
    }

    const questionIds = drawExam(track, EXAM_QUESTION_COUNT);
    const attempt = await storage.createCertificationAttempt({
      userId: user.id,
      track,
      startedAt: new Date().toISOString(),
      questionIds: JSON.stringify(questionIds),
      writtenScore: null,
      writtenPassed: false,
      scenarioSessionId: null,
      scenarioScore: null,
      scenarioPassed: false,
      overallPassed: false,
      completedAt: null,
    });
    res.json({
      attemptId: attempt.id,
      track,
      credential: TRACK_CREDENTIAL[track],
      passMark: WRITTEN_PASS_CORRECT,
      total: EXAM_QUESTION_COUNT,
      questions: getQuestions(questionIds).map(toPublicQuestion),
    });
  });

  // Fetch an attempt's current state (used to resume / show results screens).
  app.get("/api/certification/attempts/:id", async (req, res) => {
    const attempt = await storage.getCertificationAttempt(Number(req.params.id));
    if (!attempt) return res.status(404).json({ message: "Attempt not found" });
    const questionIds: string[] = JSON.parse(attempt.questionIds);
    res.json({
      ...attempt,
      credential: TRACK_CREDENTIAL[normalizeTrack(attempt.track)],
      passMark: WRITTEN_PASS_CORRECT,
      total: EXAM_QUESTION_COUNT,
      // Only expose questions (without answers) while the written test is unsubmitted.
      questions: attempt.writtenScore === null ? getQuestions(questionIds).map(toPublicQuestion) : undefined,
    });
  });

  // Submit written-test answers. MC/fill-in-the-blank are graded deterministically;
  // free-text ("written") answers are graded by the LLM against each question's
  // rubric. On a pass, unlocks the final expert scenario by creating a roleplay
  // session and linking it to the attempt.
  app.post("/api/certification/attempts/:id/written", async (req, res) => {
    try {
      const attempt = await storage.getCertificationAttempt(Number(req.params.id));
      if (!attempt) return res.status(404).json({ message: "Attempt not found" });
      if (attempt.writtenScore !== null) {
        return res.status(409).json({ message: "The written test was already submitted for this attempt." });
      }
      const gate = await checkSeatAccess(attempt.userId);
      if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

      const answers = (req.body?.answers ?? {}) as Record<string, unknown>;
      const track = normalizeTrack(attempt.track);
      const questionIds: string[] = JSON.parse(attempt.questionIds);

      const result = await gradeWrittenExam(questionIds, answers, (q, ans) =>
        gradeWrittenAnswer(q.prompt, q.rubric, ans),
      );

      // On a pass, create the final expert-level scenario session for this track.
      let scenarioSessionId: number | null = null;
      if (result.passed) {
        const scenario = await pickExpertScenario(track);
        if (scenario) {
          const session = await createScenarioSession(attempt.userId, scenario);
          scenarioSessionId = session.id;
        }
      }

      await storage.updateCertificationAttempt(attempt.id, {
        writtenScore: result.percent,
        writtenPassed: result.passed,
        scenarioSessionId,
      });

      res.json({
        writtenPassed: result.passed,
        writtenScore: result.percent,
        correct: result.correct,
        total: result.total,
        passMark: WRITTEN_PASS_CORRECT,
        passPercent: WRITTEN_PASS_PERCENT,
        scenarioSessionId,
      });
    } catch (err: any) {
      console.error("Written exam grading failed:", err);
      if (err instanceof WrittenGradingUnavailableError) {
        // The grading service itself failed (not a rubric judgment) after
        // retries. Nothing was persisted, so the attempt is untouched and
        // safe to resubmit — tell the client this is transient and retryable.
        return res.status(503).json({
          message: "Grading is temporarily unavailable. Your answers were not lost — please try submitting again in a moment.",
          retryable: true,
        });
      }
      res.status(500).json({ message: err.message ?? "Failed to grade written test" });
    }
  });

  registerCoachingRoutes(app);

  registerManagerRosterRoutes(app);

  registerPublicAndAdminRoutes(app);

  // Start the Opportunity Intelligence drip sender (every ~20 min it sends any
  // scheduled+due outreach via the existing Resend transport). Guarded against
  // double-start inside startOutreachScheduler. Only booted here (the DB entry
  // point), never in the test harness which drives sendDueOutreach directly.
  startOutreachScheduler(storage);

  return httpServer;
}

// Per-track certification status shape returned to the client. Kept a pure
// function of the user + their sessions/scenarios/attempts so the two tracks
// stay fully independent.
function certStatusForTrack(
  user: User,
  track: Track,
  allSessions: { scenarioId: number; status: string; score: number | null }[],
  allScenarios: { id: number; track?: string | null; difficulty: string }[],
  attempts: import("@shared/schema").CertificationAttempt[],
) {
  const level = track === "leadership" ? user.leadershipLevel : user.currentLevel;
  const advancedScores = scoresForTrackAtLevel(track, "advanced", allSessions, allScenarios);
  const qualifying = countQualifyingSessions(advancedScores);
  const eligible = isExamEligible(level, advancedScores);
  const certified = isTrackCertified(user, track);
  const certifiedAt = track === "leadership" ? user.leadershipCertifiedAt : user.consultingCertifiedAt;
  const trackAttempts = attempts.filter((a) => normalizeTrack(a.track) === track);
  const latestAttempt = trackAttempts[0]; // listed newest-first
  return {
    track,
    credential: TRACK_CREDENTIAL[track],
    level,
    certified,
    certifiedAt: certifiedAt ?? null,
    qualifyingAdvancedSessions: qualifying,
    requiredSessions: REQUIRED_QUALIFYING_SESSIONS,
    qualifyingThreshold: ADVANCE_THRESHOLD,
    eligible,
    latestAttempt: latestAttempt ?? null,
  };
}

function isTrackCertified(user: User, track: Track): boolean {
  return track === "leadership" ? user.leadershipCertified : user.consultingCertified;
}

// Finalize the scenario half of a certification attempt. Certification requires
// BOTH halves: mark scenarioPassed if the score clears the bar, overallPassed
// only if the written test also passed, and flip the user's per-track certified
// flag (with a timestamp) only then.
async function finalizeCertificationScenario(
  attempt: import("@shared/schema").CertificationAttempt,
  scenarioScore: number,
): Promise<void> {
  const scenarioPassed = scenarioScore >= ADVANCE_THRESHOLD;
  const overallPassed = scenarioPassed && attempt.writtenPassed;
  await storage.updateCertificationAttempt(attempt.id, {
    scenarioScore,
    scenarioPassed,
    overallPassed,
    completedAt: new Date().toISOString(),
  });
  if (overallPassed) {
    const track = normalizeTrack(attempt.track);
    const now = new Date().toISOString();
    await storage.updateUser(
      attempt.userId,
      track === "leadership"
        ? { leadershipCertified: true, leadershipCertifiedAt: now }
        : { consultingCertified: true, consultingCertifiedAt: now },
    );
  }
}

// Pick a random active Advanced-difficulty scenario for the given track to serve
// as the certification's final expert roleplay. Reuses the existing scenario
// pool rather than seeding a special one.
async function pickExpertScenario(track: Track) {
  const all = await storage.listScenarios();
  const pool = all.filter((s) => s.active && scenarioTrack(s.track) === track && s.difficulty === "advanced");
  if (pool.length === 0) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Create a roleplay session (mirrors POST /api/sessions) seeded with the
// customer's cold opening line. Used for the certification's final scenario.
async function createScenarioSession(
  userId: number,
  scenario: import("@shared/schema").Scenario,
) {
  let openingTranscript = "[]";
  try {
    const openingText = await getCustomerOpening(scenario.customerPersona, scenario.track);
    if (openingText) {
      const openingMsg = transcriptMessageSchema.parse({
        role: "customer",
        content: openingText,
        audioStatus: "none",
        msgId: randomUUID(),
        timestamp: new Date().toISOString(),
      });
      openingTranscript = JSON.stringify([openingMsg]);
    }
  } catch (err) {
    console.error("Certification scenario opening generation failed; starting empty:", err);
  }
  return storage.createSession({
    userId,
    scenarioId: scenario.id,
    status: "in_progress",
    transcript: openingTranscript,
    score: null,
    rubricScores: null,
    feedback: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  });
}

// Public marketing-site endpoints + the top-level admin console. Extracted so it
// can be mounted on a bare Express app in tests without booting seed()/the DB.
export function registerPublicAndAdminRoutes(app: Express): void {
  // ===========================================================================
  // Public marketing-site endpoints (CORS-enabled, rate-limited, no auth)
  // ===========================================================================

  // Preflight for the cross-origin POSTs from the marketing site.
  app.options(["/api/leads", "/api/track-visit"], (req, res) => {
    applyCors(req, res);
    res.status(204).end();
  });

  // Lead capture from the marketing site "Request Access" form.
  app.post("/api/leads", async (req, res) => {
    applyCors(req, res);
    if (!leadsLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const schema = z.object({
      name: z.string().trim().min(1, "Name is required").max(200),
      email: z.string().trim().email("A valid email is required").max(200),
      company: z.string().trim().max(200).optional().or(z.literal("")),
      message: z.string().trim().max(2000).optional().or(z.literal("")),
      source: z.string().trim().max(100).optional().or(z.literal("")),
      // Optional CRM tag. The marketing forms don't send this yet (Phase 2), so
      // it defaults to "general"; a caller may specify any contact type.
      type: contactTypeSchema.optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const { name, email, company, message, source, type } = parsed.data;
    const lead = await storage.createLead({
      name,
      email,
      company: company || null,
      message: message || null,
      // Default to the marketing-site origin/tag unless the caller specifies.
      source: source || DEFAULT_SOURCE,
      type: type || DEFAULT_TYPE,
      priority: DEFAULT_PRIORITY,
      status: "new",
      createdAt: new Date().toISOString(),
    });
    // Best-effort notification email. sendLeadNotification never throws, so a
    // failure here must never block or fail the lead-capture response.
    void sendLeadNotification(lead);
    // Auto-enroll this NEW inbound lead into the welcome drip: the day-0 welcome
    // is sent inline (best-effort) and the day-3/day-7 follow-ups are scheduled
    // for the shared background sender. Fire-and-forget and never throws, so it
    // is fully independent of the founder notification and never blocks capture.
    void enrollInboundLead({ storage, send: sendInboundEmail }, lead);
    res.status(201).json({ ok: true, id: lead.id });
  });

  // Anonymous page-view tracking from the marketing site.
  app.post("/api/track-visit", async (req, res) => {
    applyCors(req, res);
    if (!visitsLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "rate limited" });
    }
    const schema = z.object({
      path: z.string().trim().min(1).max(500),
      referrer: z.string().trim().max(500).optional().or(z.literal("")),
      visitorToken: z.string().trim().max(100).optional().or(z.literal("")),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false });
    }
    const { path: viewPath, referrer, visitorToken } = parsed.data;
    const ua = req.headers["user-agent"];
    await storage.createVisitorPageView({
      path: viewPath,
      referrer: referrer || null,
      visitorToken: visitorToken || null,
      userAgent: typeof ua === "string" ? ua.slice(0, 400) : null,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ ok: true });
  });

  // ===========================================================================
  // Public "Free Voice Demo" (no auth, no seat; the email+code IS the auth)
  // ===========================================================================
  // Reuses the EXACT existing roleplay pipeline: getCustomerOpening /
  // getCustomerReply / scoreTranscript / synthesizeAudio / getVoiceForScenario.
  // Anonymous demo traffic lives in demo_signups/demo_sessions and never touches
  // the seat-gated users/sessions tables, office analytics, or level progression.

  // Load the fixed demo scenario (by slug). It's seeded active:false so it never
  // appears in the trainee picker; the demo reaches it by slug only.
  async function getDemoScenario() {
    return storage.getScenarioBySlug(DEMO_SCENARIO_SLUG);
  }

  // Resolve the caller's verified signup from the signed token in the body.
  async function requireDemoSignup(
    req: Request,
    res: Response,
  ): Promise<import("@shared/schema").DemoSignup | null> {
    const payload = verifyDemoToken(req.body?.token ?? req.query?.token);
    if (!payload) {
      res.status(401).json({ message: "Your demo session has expired. Please verify your email again." });
      return null;
    }
    const signup = await storage.getDemoSignupByEmail(payload.email);
    if (!signup || !signup.verified) {
      res.status(401).json({ message: "Please verify your email to start the demo." });
      return null;
    }
    return signup;
  }

  function publicDemoSession(s: import("@shared/schema").DemoSession) {
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

  // Step 1: visitor submits their email; we email a 6-digit code. If the email
  // has already used all its free sessions, we short-circuit (no code sent) so
  // the client can show the "used all 3" message + signup CTA.
  app.post("/api/demo/request-code", async (req, res) => {
    if (!demoLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const schema = z.object({ email: z.string().trim().email("A valid email is required").max(200) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid email" });
    }
    const email = normalizeEmail(parsed.data.email);
    const now = new Date();

    let signup = await storage.getDemoSignupByEmail(email);
    if (signup && isSessionLimitReached(signup.sessionsUsed, email)) {
      return res.json({ ok: true, limitReached: true, remaining: 0 });
    }

    const code = generateVerificationCode();
    const patch = { code, codeExpiresAt: codeExpiryFrom(now.getTime()), lastSentAt: now.toISOString() };
    if (!signup) {
      signup = await storage.createDemoSignup({
        email,
        code: patch.code,
        codeExpiresAt: patch.codeExpiresAt,
        verified: false,
        sessionsUsed: 0,
        createdAt: now.toISOString(),
        lastSentAt: patch.lastSentAt,
      });
    } else {
      await storage.updateDemoSignup(signup.id, patch);
    }

    const sent = await sendDemoVerificationCode(email, code);
    if (!sent) {
      return res.status(502).json({ message: "We couldn't send your code just now. Please try again in a moment.", retryable: true });
    }
    res.json({ ok: true, remaining: remainingSessions(signup.sessionsUsed, email) });
  });

  // Step 2: visitor submits the code. On success we consume the code, mark the
  // email verified, and (unless the limit is already reached) issue a signed
  // demo token that authorizes starting roleplay sessions.
  app.post("/api/demo/verify", async (req, res) => {
    if (!demoLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const schema = z.object({
      email: z.string().trim().email("A valid email is required").max(200),
      code: z.string().trim().min(4).max(10),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const email = normalizeEmail(parsed.data.email);
    const signup = await storage.getDemoSignupByEmail(email);
    if (!signup || !isCodeValid(signup, parsed.data.code)) {
      return res.status(400).json({ message: "That code is incorrect or has expired. Please try again." });
    }

    // Consume the code (single-use) and mark verified.
    await storage.updateDemoSignup(signup.id, { verified: true, code: null, codeExpiresAt: null });

    if (isSessionLimitReached(signup.sessionsUsed, email)) {
      return res.json({ verified: true, limitReached: true, remaining: 0 });
    }
    const token = signDemoToken(email);
    res.json({ verified: true, token, remaining: remainingSessions(signup.sessionsUsed, email) });
  });

  // Step 3: start a demo roleplay. Usage is incremented AT START (before the
  // session row is created) so refreshing mid-session can't yield a 4th free run.
  app.post("/api/demo/session", async (req, res) => {
    if (!demoLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const signup = await requireDemoSignup(req, res);
    if (!signup) return;
    if (isSessionLimitReached(signup.sessionsUsed, signup.email)) {
      return res.status(403).json({ message: "You've used all 3 free demo sessions.", limitReached: true, remaining: 0 });
    }
    const scenario = await getDemoScenario();
    if (!scenario) return res.status(500).json({ message: "Demo is temporarily unavailable." });

    // Increment usage FIRST so a failure after this point can't grant a free retry.
    // Exempted (unlimited) emails skip the counter entirely so the cap never applies to them.
    const updatedSignup = isUnlimitedDemoEmail(signup.email)
      ? signup
      : await storage.updateDemoSignup(signup.id, { sessionsUsed: signup.sessionsUsed + 1 });

    let openingTranscript = "[]";
    try {
      const openingText = await getCustomerOpening(scenario.customerPersona, scenario.track);
      if (openingText) {
        const openingMsg = transcriptMessageSchema.parse({
          role: "customer",
          content: openingText,
          audioStatus: "none",
          msgId: randomUUID(),
          timestamp: new Date().toISOString(),
        });
        openingTranscript = JSON.stringify([openingMsg]);
      }
    } catch (err) {
      console.error("Demo opening generation failed; starting empty:", err);
    }

    const session = await storage.createDemoSession({
      signupId: signup.id,
      email: signup.email,
      scenarioId: scenario.id,
      status: "in_progress",
      transcript: openingTranscript,
      score: null,
      rubricScores: null,
      feedback: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });

    res.json({
      session: publicDemoSession(session),
      remaining: remainingSessions(updatedSignup?.sessionsUsed ?? signup.sessionsUsed + 1, signup.email),
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

  // Fetch a demo session's current state (used to poll for background audio).
  app.get("/api/demo/session/:id", async (req, res) => {
    const signup = await requireDemoSignup(req, res);
    if (!signup) return;
    const session = await storage.getDemoSession(Number(req.params.id));
    if (!session || session.signupId !== signup.id) {
      return res.status(404).json({ message: "Session not found" });
    }
    res.json({ session: publicDemoSession(session) });
  });

  // A conversational turn in the demo — mirrors POST /api/sessions/:id/message.
  app.post("/api/demo/session/:id/message", async (req, res) => {
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
      const scenario = await storage.getScenario(session.scenarioId);
      if (!scenario) return res.status(404).json({ message: "Conversation not found" });

      const { content, withAudio } = req.body ?? {};
      const transcript = JSON.parse(session.transcript);
      const consultantMsg = transcriptMessageSchema.parse({
        role: "consultant",
        content,
        timestamp: new Date().toISOString(),
      });
      transcript.push(consultantMsg);

      const customerReplyText = await getCustomerReply(scenario.customerPersona, transcript, scenario.difficulty);
      const msgId = randomUUID();
      const customerMsg = transcriptMessageSchema.parse({
        role: "customer",
        content: customerReplyText,
        audioStatus: withAudio ? "pending" : "none",
        msgId,
        timestamp: new Date().toISOString(),
      });
      transcript.push(customerMsg);

      const updated = await storage.updateDemoSession(session.id, { transcript: JSON.stringify(transcript) });
      res.json({ session: publicDemoSession(updated!) });

      if (withAudio) {
        synthesizeAudio(customerReplyText, getVoiceForScenario(scenario.slug, scenario.gender), getVoiceInstructionsForScenario(scenario.slug))
          .then(async (audioUrl) => {
            const latest = await storage.getDemoSession(session.id);
            if (!latest) return;
            const t: TranscriptMessage[] = JSON.parse(latest.transcript);
            const idx = t.findIndex((m) => m.msgId === msgId);
            if (idx !== -1) {
              t[idx] = { ...t[idx], audioUrl, audioStatus: "ready" };
              await storage.updateDemoSession(session.id, { transcript: JSON.stringify(t) });
            }
          })
          .catch(async (err) => {
            console.error("Demo background TTS failed:", err);
            const latest = await storage.getDemoSession(session.id);
            if (!latest) return;
            const t: TranscriptMessage[] = JSON.parse(latest.transcript);
            const idx = t.findIndex((m) => m.msgId === msgId);
            if (idx !== -1) {
              t[idx] = { ...t[idx], audioStatus: "failed" };
              await storage.updateDemoSession(session.id, { transcript: JSON.stringify(t) });
            }
          });
      }
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to process message" });
    }
  });

  // End & score a demo session with the SAME rubric as real sessions. The demo
  // ends naturally (no time limit, no incomplete-consultation gate).
  app.post("/api/demo/session/:id/complete", async (req, res) => {
    try {
      const signup = await requireDemoSignup(req, res);
      if (!signup) return;
      const session = await storage.getDemoSession(Number(req.params.id));
      if (!session || session.signupId !== signup.id) {
        return res.status(404).json({ message: "Session not found" });
      }
      const transcript = JSON.parse(session.transcript);
      const scenario = await storage.getScenario(session.scenarioId);
      const track = scenarioTrack(scenario?.track);
      const { rubric, feedback, overall } = await scoreTranscript(transcript, scenario?.difficulty, track, scenario?.transactionType);
      const updated = await storage.updateDemoSession(session.id, {
        status: "completed",
        score: overall,
        rubricScores: JSON.stringify(rubric),
        feedback,
        completedAt: new Date().toISOString(),
      });
      res.json({ session: publicDemoSession(updated!) });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to score session" });
    }
  });

  // Post-demo CTA lead capture. Reuses the existing contact/lead flow (creates a
  // contact + fires the same best-effort notification email). The team-size
  // answer is folded into the message so it shows in the admin CRM.
  app.post("/api/demo/lead", async (req, res) => {
    if (!demoLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const schema = z.object({
      name: z.string().trim().min(1, "Name is required").max(200),
      email: z.string().trim().email("A valid email is required").max(200),
      company: z.string().trim().max(200).optional().or(z.literal("")),
      teamSize: z.string().trim().max(200).optional().or(z.literal("")),
      message: z.string().trim().max(2000).optional().or(z.literal("")),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const { name, email, company, teamSize, message } = parsed.data;
    const scenario = await getDemoScenario();
    const question = ctaSeatQuestion(scenario?.track);
    const noteParts = [
      teamSize ? `${question} — ${teamSize}` : "",
      message || "",
    ].filter(Boolean);
    const lead = await storage.createLead({
      name,
      email: normalizeEmail(email),
      company: company || null,
      message: noteParts.join("\n\n") || null,
      source: "role_play",
      type: "consulting",
      priority: DEFAULT_PRIORITY,
      status: "new",
      createdAt: new Date().toISOString(),
    });
    void sendLeadNotification(lead);
    res.status(201).json({ ok: true, id: lead.id });
  });

  // ===========================================================================
  // Admin: top-level Solve Admin account (separate cookie/session from users)
  // ===========================================================================

  function setAdminCookie(res: Response, token: string): void {
    res.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12,
      path: "/",
    });
  }

  // Guard for every /api/admin/* data route. 401 unless a valid admin session
  // cookie is present. A manager/consultant has no such cookie, so their session
  // can never reach these routes regardless of role.
  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    const token = readCookie(req, ADMIN_SESSION_COOKIE);
    const session = verifyAdminSession(token);
    if (!session) {
      res.status(401).json({ message: "Admin authentication required" });
      return;
    }
    (req as any).admin = session;
    next();
  }

  app.post("/api/admin/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Username and password are required" });
    }
    const admin = await storage.getAdminByUsername(username);
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      return res.status(401).json({ message: "Invalid username or password" });
    }
    const token = signAdminSession(admin.id, admin.username);
    setAdminCookie(res, token);
    res.json({ username: admin.username });
  });

  app.post("/api/admin/logout", (_req, res) => {
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/admin/me", requireAdmin, (req, res) => {
    const session = (req as any).admin;
    res.json({ username: session.username });
  });

  // Send either JSON rows or a CSV download depending on ?format=csv.
  function sendData(
    req: Request,
    res: Response,
    filename: string,
    columns: { key: string; header: string }[],
    rows: Record<string, unknown>[],
  ): void {
    if (req.query.format === "csv") {
      const csv = toCsv(columns as any, rows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
      return;
    }
    res.json({ rows });
  }

  app.get("/api/admin/visitors", requireAdmin, async (req, res) => {
    const views = await storage.listVisitorPageViews(2000);
    const rows = views.map((v) => ({
      id: v.id,
      path: v.path,
      referrer: v.referrer ?? "",
      visitorToken: v.visitorToken ?? "",
      userAgent: v.userAgent ?? "",
      createdAt: v.createdAt,
    }));
    sendData(req, res, "visitors.csv", [
      { key: "id", header: "ID" },
      { key: "path", header: "Path" },
      { key: "referrer", header: "Referrer" },
      { key: "visitorToken", header: "Visitor Token" },
      { key: "userAgent", header: "User Agent" },
      { key: "createdAt", header: "Timestamp" },
    ], rows);
  });

  app.get("/api/admin/leads", requireAdmin, async (req, res) => {
    const leads = await storage.listLeads();
    const rows = leads.map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      company: l.company ?? "",
      message: l.message ?? "",
      status: l.status,
      source: l.source ?? "",
      createdAt: l.createdAt,
    }));
    sendData(req, res, "leads.csv", [
      { key: "id", header: "ID" },
      { key: "name", header: "Name" },
      { key: "email", header: "Email" },
      { key: "company", header: "Company" },
      { key: "message", header: "Message" },
      { key: "status", header: "Status" },
      { key: "source", header: "Source" },
      { key: "createdAt", header: "Submitted" },
    ], rows);
  });

  // Inline status update from the Leads table (new | contacted | converted).
  app.patch("/api/admin/leads/:id", requireAdmin, async (req, res) => {
    const schema = z.object({ status: z.enum(["new", "contacted", "converted"]) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const updated = await storage.updateLeadStatus(Number(req.params.id), parsed.data.status);
    if (!updated) return res.status(404).json({ message: "Lead not found" });
    res.json(updated);
  });

  // ---- Unified CRM contacts (evolved leads) --------------------------------

  // Serialize a contact for the admin UI, adding the derived `followUpDue` flag.
  function serializeContact(c: Contact): Record<string, unknown> {
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      company: c.company ?? "",
      message: c.message ?? "",
      status: c.status,
      type: c.type,
      source: c.source,
      priority: c.priority,
      owner: c.owner ?? "",
      followUpDate: c.followUpDate ?? "",
      followUpDue: isFollowUpDue(c.followUpDate),
      createdAt: c.createdAt,
    };
  }

  // List contacts with optional filters (type, priority, status, owner) and an
  // optional sort=followUp (soonest/most-overdue first). Supports ?format=csv.
  app.get("/api/admin/contacts", requireAdmin, async (req, res) => {
    const q = req.query;
    const filters: ContactFilters = {
      type: typeof q.type === "string" && q.type ? q.type : undefined,
      priority: typeof q.priority === "string" && q.priority ? q.priority : undefined,
      status: typeof q.status === "string" && q.status ? q.status : undefined,
      owner: typeof q.owner === "string" && q.owner ? q.owner : undefined,
    };
    const sort = q.sort === "followUp" ? "followUp" : undefined;
    const list = await storage.listContacts(filters, sort);
    const rows = list.map(serializeContact);
    sendData(req, res, "contacts.csv", [
      { key: "id", header: "ID" },
      { key: "name", header: "Name" },
      { key: "email", header: "Email" },
      { key: "company", header: "Company" },
      { key: "type", header: "Type" },
      { key: "source", header: "Source" },
      { key: "priority", header: "Priority" },
      { key: "status", header: "Status" },
      { key: "owner", header: "Owner" },
      { key: "followUpDate", header: "Follow-up" },
      { key: "message", header: "Message" },
      { key: "createdAt", header: "Created" },
    ], rows);
  });

  // Full timeline for one contact, newest first.
  app.get("/api/admin/contacts/:id/events", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const contact = await storage.getContact(id);
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    const events = await storage.listContactEvents(id);
    res.json({ rows: events });
  });

  // Update any of status/priority/owner/followUpDate and/or append a note. Each
  // real change (and every note) is logged as a timeline event automatically.
  app.patch("/api/admin/contacts/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const parsed = contactPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const existing = await storage.getContact(id);
    if (!existing) return res.status(404).json({ message: "Contact not found" });

    const admin = (req as any).admin;
    const actor = admin?.username ? String(admin.username) : "admin";
    const now = new Date().toISOString();
    const events = buildContactUpdateEvents(existing, parsed.data, { actor, now });

    const columnPatch = normalizeContactPatch(parsed.data);
    const updated = Object.keys(columnPatch).length
      ? (await storage.updateContact(id, columnPatch)) ?? existing
      : existing;

    for (const event of events) {
      await storage.createContactEvent(event);
    }

    res.json({ contact: serializeContact(updated), events });
  });

  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    const [allUsers, allOffices] = await Promise.all([storage.listUsers(), storage.listOffices()]);
    const officeName = new Map(allOffices.map((o) => [o.id, o.name]));
    const officeStatus = new Map(allOffices.map((o) => [o.id, o.subscriptionStatus]));
    const rows = allUsers.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      office: officeName.get(u.officeId) ?? "",
      officeId: u.officeId,
      role: u.role,
      currentLevel: u.currentLevel,
      leadershipLevel: u.leadershipLevel,
      seatActive: u.seatActive ? "yes" : "no",
      isDemoAccount: u.isDemoAccount ? "yes" : "no",
      subscriptionStatus: officeStatus.get(u.officeId) ?? "",
    }));
    sendData(req, res, "users.csv", [
      { key: "id", header: "ID" },
      { key: "username", header: "Username" },
      { key: "displayName", header: "Name" },
      { key: "office", header: "Office" },
      { key: "role", header: "Role" },
      { key: "currentLevel", header: "Consulting Level" },
      { key: "leadershipLevel", header: "Leadership Level" },
      { key: "seatActive", header: "Seat Active" },
      { key: "isDemoAccount", header: "Demo" },
      { key: "subscriptionStatus", header: "Office Subscription" },
    ], rows);
  });

  app.get("/api/admin/sales", requireAdmin, async (req, res) => {
    const allOffices = await storage.listOffices();
    const { rows, totalMrr, activeOffices } = summarizeSales(allOffices);
    const csvRows = rows.map((r) => ({
      officeId: r.officeId,
      officeName: r.officeName,
      subscriptionStatus: r.subscriptionStatus,
      seatCount: r.seatCount,
      seatsMrr: r.seatsMrr,
      managerMrr: r.managerMrr,
      mrr: r.mrr,
    }));
    if (req.query.format === "csv") {
      return sendData(req, res, "sales.csv", [
        { key: "officeId", header: "Office ID" },
        { key: "officeName", header: "Office" },
        { key: "subscriptionStatus", header: "Status" },
        { key: "seatCount", header: "Seats" },
        { key: "seatsMrr", header: "Seat MRR" },
        { key: "managerMrr", header: "Manager MRR" },
        { key: "mrr", header: "MRR" },
      ], csvRows);
    }
    res.json({ rows, totalMrr, activeOffices });
  });

  // Free Voice Demo usage: one row per email with verification state, all-time
  // sessions used (capped at 3), and how many of those were completed/scored.
  app.get("/api/admin/demo", requireAdmin, async (req, res) => {
    const [signups, sessions] = await Promise.all([
      storage.listDemoSignups(),
      storage.listDemoSessions(),
    ]);
    const completedByEmail = new Map<string, number>();
    for (const s of sessions) {
      if (s.status === "completed") {
        completedByEmail.set(s.email, (completedByEmail.get(s.email) ?? 0) + 1);
      }
    }
    const rows = signups.map((s) => {
      const unlimited = isUnlimitedDemoEmail(s.email);
      return {
        id: s.id,
        email: s.email,
        verified: s.verified ? "yes" : "no",
        sessionsUsed: unlimited ? `${s.sessionsUsed} (unlimited)` : s.sessionsUsed,
        maxSessions: unlimited ? "unlimited" : MAX_DEMO_SESSIONS,
        completedSessions: completedByEmail.get(s.email) ?? 0,
        createdAt: s.createdAt,
        lastSentAt: s.lastSentAt ?? "",
      };
    });
    sendData(req, res, "demo.csv", [
      { key: "id", header: "ID" },
      { key: "email", header: "Email" },
      { key: "verified", header: "Verified" },
      { key: "sessionsUsed", header: "Sessions Used" },
      { key: "maxSessions", header: "Max" },
      { key: "completedSessions", header: "Completed" },
      { key: "createdAt", header: "First Seen" },
      { key: "lastSentAt", header: "Last Code Sent" },
    ], rows);
  });

  // ===========================================================================
  // Opportunity Intelligence (admin-only outbound lead-gen + email drip)
  // ===========================================================================

  // List discovery batches, most recent first.
  app.get("/api/admin/opportunities/searches", requireAdmin, async (_req, res) => {
    const searches = await storage.listProspectSearches();
    res.json({
      rows: searches.map((s) => ({
        id: s.id,
        segment: s.segment,
        geography: s.geography,
        runAt: s.runAt,
        resultsCount: s.resultsCount,
        status: s.status,
      })),
    });
  });

  // Full detail for one batch: its companies, each company's contacts, and each
  // contact's full drafted/scheduled outreach sequence (step-sorted).
  app.get("/api/admin/opportunities/searches/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const search = await storage.getProspectSearch(id);
    if (!search) return res.status(404).json({ message: "Batch not found" });

    const outreach = await storage.listProspectOutreachBySearch(id);
    const contactIds = Array.from(new Set(outreach.map((o) => o.contactId)));
    const contacts = await storage.getProspectContactsByIds(contactIds);
    const companyIds = Array.from(new Set(contacts.map((c) => c.companyId)));
    const companies = await storage.getProspectCompaniesByIds(companyIds);

    const outreachByContact = new Map<number, typeof outreach>();
    for (const o of outreach) {
      const list = outreachByContact.get(o.contactId) ?? [];
      list.push(o);
      outreachByContact.set(o.contactId, list);
    }
    const contactsByCompany = new Map<number, typeof contacts>();
    for (const c of contacts) {
      const list = contactsByCompany.get(c.companyId) ?? [];
      list.push(c);
      contactsByCompany.set(c.companyId, list);
    }

    const companiesOut = companies.map((co) => ({
      id: co.id,
      name: co.name,
      domain: co.domain ?? "",
      segment: co.segment,
      city: co.city ?? "",
      state: co.state ?? "",
      employeeCount: co.employeeCount ?? null,
      signalType: co.signalType,
      signalDetail: co.signalDetail,
      source: co.source,
      status: co.status,
      contacts: (contactsByCompany.get(co.id) ?? []).map((c) => ({
        id: c.id,
        fullName: c.fullName,
        title: c.title,
        email: c.email,
        phone: c.phone ?? "",
        linkedinUrl: c.linkedinUrl ?? "",
        outreach: (outreachByContact.get(c.id) ?? [])
          .slice()
          .sort((a, b) => a.sequenceStep - b.sequenceStep)
          .map((o) => ({
            id: o.id,
            sequenceStep: o.sequenceStep,
            emailSubject: o.emailSubject,
            emailBody: o.emailBody,
            scheduledAt: o.scheduledAt ?? "",
            sentAt: o.sentAt ?? "",
            status: o.status,
          })),
      })),
    }));

    res.json({
      search: {
        id: search.id,
        segment: search.segment,
        geography: search.geography,
        runAt: search.runAt,
        resultsCount: search.resultsCount,
        status: search.status,
      },
      companies: companiesOut,
    });
  });

  // Approve a batch: mark it approved and schedule its entire draft outreach
  // sequence — step 1 now, step 2 at +3 days, step 3 at +7 days. Idempotent-ish:
  // only a pending_review batch can be approved.
  app.post("/api/admin/opportunities/searches/:id/approve", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const search = await storage.getProspectSearch(id);
    if (!search) return res.status(404).json({ message: "Batch not found" });
    if (search.status !== "pending_review") {
      return res.status(409).json({ message: `Batch is already ${search.status}` });
    }

    const outreach = await storage.listProspectOutreachBySearch(id);
    const plan = planApproval(outreach, Date.now());
    for (const p of plan) {
      await storage.updateProspectOutreach(p.id, { status: p.status, scheduledAt: p.scheduledAt });
    }
    const updated = await storage.updateProspectSearch(id, { status: "approved" });
    res.json({ search: updated, scheduled: plan.length });
  });

  // Reject a batch: mark it rejected. Outreach stays draft and is never sent.
  app.post("/api/admin/opportunities/searches/:id/reject", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const search = await storage.getProspectSearch(id);
    if (!search) return res.status(404).json({ message: "Batch not found" });
    if (search.status !== "pending_review") {
      return res.status(409).json({ message: `Batch is already ${search.status}` });
    }
    const updated = await storage.updateProspectSearch(id, { status: "rejected" });
    res.json({ search: updated });
  });

  // Recent prospect activity (opened/replied/bounced/sent), newest first, with
  // the contact's name/email resolved for display.
  app.get("/api/admin/opportunities/activity", requireAdmin, async (_req, res) => {
    const events = await storage.listRecentProspectActivity(200);
    const contactIds = Array.from(new Set(events.map((e) => e.contactId)));
    const contacts = await storage.getProspectContactsByIds(contactIds);
    const byId = new Map(contacts.map((c) => [c.id, c]));
    res.json({
      rows: events.map((e) => {
        const c = byId.get(e.contactId);
        return {
          id: e.id,
          contactId: e.contactId,
          contactName: c?.fullName ?? "",
          contactEmail: c?.email ?? "",
          eventType: e.eventType,
          eventDetail: e.eventDetail,
          occurredAt: e.occurredAt,
        };
      }),
    });
  });

  // Insert a discovery batch out-of-band. Discovery itself runs externally (via
  // Perplexity connectors called by the parent agent); its results are POSTed
  // here as JSON. Each contact's three-step drip is generated from the segment
  // templates unless the payload supplies explicit emails. See the README
  // section "How new discovery batches get created".
  const batchEmailSchema = z.object({
    step: z.number().int().min(1).max(3),
    subject: z.string().min(1),
    body: z.string().min(1),
  });
  const batchContactSchema = z.object({
    fullName: z.string().trim().min(1),
    title: z.string().trim().min(1),
    email: z.string().trim().email(),
    phone: z.string().trim().optional().or(z.literal("")),
    linkedinUrl: z.string().trim().optional().or(z.literal("")),
    emails: z.array(batchEmailSchema).optional(),
  });
  const batchCompanySchema = z.object({
    name: z.string().trim().min(1),
    domain: z.string().trim().optional().or(z.literal("")),
    city: z.string().trim().optional().or(z.literal("")),
    state: z.string().trim().optional().or(z.literal("")),
    employeeCount: z.number().int().nonnegative().optional(),
    signalType: z.string().trim().min(1),
    signalDetail: z.string().trim().min(1),
    source: z.string().trim().min(1),
    status: z.string().trim().optional(),
    contacts: z.array(batchContactSchema).min(1),
  });
  const batchSchema = z.object({
    segment: z.string().trim().min(1),
    geography: z.string().trim().min(1),
    runAt: z.string().trim().optional(),
    companies: z.array(batchCompanySchema).min(1),
  });

  app.post("/api/admin/opportunities/batches", requireAdmin, async (req, res) => {
    const parsed = batchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid batch payload" });
    }
    const payload = parsed.data;
    const now = new Date().toISOString();

    const search = await storage.createProspectSearch({
      segment: payload.segment,
      geography: payload.geography,
      runAt: payload.runAt || now,
      resultsCount: payload.companies.length,
      status: "pending_review",
    });

    let contactCount = 0;
    let outreachCount = 0;
    for (const co of payload.companies) {
      const company = await storage.createProspectCompany({
        name: co.name,
        domain: co.domain || null,
        segment: payload.segment,
        city: co.city || null,
        state: co.state || null,
        employeeCount: co.employeeCount ?? null,
        signalType: co.signalType,
        signalDetail: co.signalDetail,
        source: co.source,
        discoveredAt: now,
        status: co.status || "new",
      });
      for (const ct of co.contacts) {
        const contact = await storage.createProspectContact({
          companyId: company.id,
          fullName: ct.fullName,
          title: ct.title,
          email: ct.email,
          phone: ct.phone || null,
          linkedinUrl: ct.linkedinUrl || null,
          createdAt: now,
        });
        contactCount += 1;

        // Use supplied emails if present, else generate the segment drip.
        const drafts = ct.emails && ct.emails.length
          ? ct.emails.map((e) => ({ step: e.step, emailSubject: e.subject, emailBody: e.body }))
          : buildSequence(payload.segment, { contactName: ct.fullName, companyName: co.name });

        for (const step of SEQUENCE_STEPS) {
          const draft = drafts.find((d) => d.step === step);
          if (!draft) continue;
          await storage.createProspectOutreach({
            contactId: contact.id,
            searchId: search.id,
            sequenceStep: step,
            emailSubject: draft.emailSubject,
            emailBody: draft.emailBody,
            scheduledAt: null,
            sentAt: null,
            status: "draft",
          });
          outreachCount += 1;
        }
      }
    }

    res.status(201).json({
      searchId: search.id,
      companies: payload.companies.length,
      contacts: contactCount,
      outreach: outreachCount,
    });
  });

  // Manual trigger for the drip sender (useful for ops + as a documented cron
  // target if a platform scheduler is preferred over the in-process interval).
  app.post("/api/admin/opportunities/run-drip", requireAdmin, async (_req, res) => {
    const result = await sendDueOutreach({ storage, send: sendProspectEmail });
    res.json(result);
  });
}

// SOLVE Coach follow-up Q&A routes. Extracted so they can be mounted on a bare
// Express app in tests with an injected `responder` (no network) and stubbed
// storage. In production `registerRoutes` mounts them with the default OpenAI
// responder. Two routes:
//   POST /api/sessions/:id/coaching — the TRAINEE (session owner, seat-gated)
//     posts a follow-up question; we persist it, generate SOLVE Coach's reply
//     (with the attempt's feedback + transcript in context), persist that, and
//     return the refreshed thread.
//   GET  /api/sessions/:id/coaching — returns the still-active thread. Readable
//     by the trainee who owns it AND by a manager/QA in the same office
//     (read-only visibility while the thread is active) — managers never post.
export function registerCoachingRoutes(
  app: Express,
  opts: { responder?: CoachingResponder } = {},
): void {
  const responder = opts.responder;

  app.get("/api/sessions/:id/coaching", async (req, res) => {
    const session = await storage.getSession(Number(req.params.id));
    if (!session) return res.status(404).json({ message: "Session not found" });

    const requesterId = Number(req.query.requesterId);
    if (!requesterId) return res.status(400).json({ message: "requesterId is required" });
    const requester = await storage.getUser(requesterId);
    if (!requester) return res.status(401).json({ message: "Unknown user" });

    // The owning trainee always sees their own thread. Otherwise the requester
    // must be a manager/QA in the SAME office as the trainee (read-only view).
    if (requester.id !== session.userId) {
      const owner = await storage.getUser(session.userId);
      const isManagerPeer =
        (requester.role === "manager" || requester.role === "qa") &&
        !!owner &&
        owner.officeId === requester.officeId;
      if (!isManagerPeer) return res.status(403).json({ message: "Not authorized" });
    }

    const messages = await storage.listCoachingMessagesBySession(session.id);
    res.json({ messages, canPost: requester.id === session.userId });
  });

  app.post("/api/sessions/:id/coaching", async (req, res) => {
    try {
      const session = await storage.getSession(Number(req.params.id));
      if (!session) return res.status(404).json({ message: "Session not found" });

      const { userId, content } = req.body ?? {};
      // Only the trainee who owns this attempt can post — managers are read-only.
      if (Number(userId) !== session.userId) {
        return res.status(403).json({ message: "Only the trainee who ran this scenario can ask SOLVE Coach." });
      }
      const gate = await checkSeatAccess(session.userId);
      if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

      const question = typeof content === "string" ? content.trim() : "";
      if (!question) return res.status(400).json({ message: "A question is required" });

      const scenario = await storage.getScenario(session.scenarioId);
      const track = scenarioTrack(scenario?.track);
      const transcript = JSON.parse(session.transcript);

      // Persist the trainee's turn first so the thread is durable even if the
      // model call fails on the coach reply.
      await storage.createCoachingMessage({
        sessionId: session.id,
        userId: session.userId,
        role: "trainee",
        content: question,
        cleared: false,
        createdAt: new Date().toISOString(),
      });

      const priorThread = await storage.listCoachingMessagesBySession(session.id);
      // The thread we pass to the model is prior turns EXCLUDING the just-saved
      // question (which is passed separately as the new question).
      const thread: CoachingThreadMessage[] = priorThread
        .filter((m) => m.role === "trainee" || m.role === "coach")
        .slice(0, -1)
        .map((m) => ({ role: m.role as "trainee" | "coach", content: m.content }));

      const reply = await getCoachingReply(
        {
          track,
          feedback: session.feedback ?? "",
          rubricScoresJson: session.rubricScores ?? null,
          overallScore: session.score ?? null,
          transcript,
          thread,
          question,
        },
        responder,
      );

      await storage.createCoachingMessage({
        sessionId: session.id,
        userId: session.userId,
        role: "coach",
        content: reply,
        cleared: false,
        createdAt: new Date().toISOString(),
      });

      const messages = await storage.listCoachingMessagesBySession(session.id);
      res.json({ messages, canPost: true });
    } catch (err: any) {
      console.error("Coaching reply failed:", err);
      res.status(500).json({ message: err.message ?? "Failed to get a coaching reply" });
    }
  });
}

// ===========================================================================
// Manager roster — office-wide per-consultant progress for the manager/QA
// dashboard. Two read-only routes, authorized to the office's own manager/QA:
//   GET /api/offices/:officeId/consultants          — one summary row per consultant
//   GET /api/offices/:officeId/consultants/:userId  — one consultant's full session history
// Progress ("N of 5 at 85%+") is DERIVED, not stored: it reuses the same
// scoresForTrackAtLevel/countQualifyingSessions logic that drives level
// advancement, so the roster can never disagree with the trainee's own view.
// ===========================================================================

// Per-consultant summary shape returned by the roster endpoint. Kept independent
// of publicUser so tightening one never silently changes the other.
type ConsultantSummary = ReturnType<typeof buildConsultantSummary>;

function buildConsultantSummary(
  user: User,
  userSessions: Session[],
  allScenarios: Scenario[],
) {
  const completed = userSessions.filter((s) => s.status === "completed");
  const scored = completed.filter((s) => s.score !== null);
  const averageScore = scored.length
    ? Math.round(scored.reduce((sum, s) => sum + (s.score as number), 0) / scored.length)
    : null;

  // Progress toward the next consulting tier: how many completed sessions at the
  // user's CURRENT consulting difficulty individually cleared the 85% bar.
  const consultingScoresAtTier = scoresForTrackAtLevel(
    "consulting",
    user.currentLevel,
    userSessions,
    allScenarios,
  );
  const qualifyingSessionsAtCurrentTier = countQualifyingSessions(consultingScoresAtTier);

  // Most recent activity: prefer completedAt, fall back to createdAt so an
  // in-progress-only consultant still shows a last-active date.
  const lastSessionDate =
    userSessions
      .map((s) => s.completedAt ?? s.createdAt)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    currentLevel: user.currentLevel,
    leadershipLevel: user.leadershipLevel,
    consultingCertified: user.consultingCertified,
    consultingCertifiedAt: user.consultingCertifiedAt,
    leadershipCertified: user.leadershipCertified,
    leadershipCertifiedAt: user.leadershipCertifiedAt,
    totalSessionsCompleted: completed.length,
    averageScore,
    qualifyingSessionsAtCurrentTier,
    requiredQualifyingSessions: REQUIRED_QUALIFYING_SESSIONS,
    lastSessionDate,
  };
}

// Authorize a manager-roster request: the requester must exist, be a manager or
// QA, and belong to the office they're asking about. Mirrors the office-scoping
// used by /api/offices/:id/seats/remove and the coaching manager-peer check.
async function authorizeRosterRequest(
  requesterId: number,
  officeId: number,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!requesterId) return { ok: false, status: 400, message: "requesterId is required" };
  const requester = await storage.getUser(requesterId);
  if (!requester) return { ok: false, status: 401, message: "Unknown user" };
  if (requester.role !== "manager" && requester.role !== "qa") {
    return { ok: false, status: 403, message: "Only a manager or QA can view the office roster" };
  }
  if (requester.officeId !== officeId) {
    return { ok: false, status: 403, message: "You can only view your own office's roster" };
  }
  return { ok: true };
}

export function registerManagerRosterRoutes(app: Express): void {
  // Roster: one summary row per consultant in the office.
  app.get("/api/offices/:officeId/consultants", async (req, res) => {
    const officeId = Number(req.params.officeId);
    const requesterId = Number(req.query.requesterId);
    const auth = await authorizeRosterRequest(requesterId, officeId);
    if (!auth.ok) return res.status(auth.status).json({ message: auth.message });

    const [officeUsers, officeSessions, allScenarios] = await Promise.all([
      storage.listUsersByOffice(officeId),
      storage.listSessionsByOffice(officeId),
      storage.listScenarios(),
    ]);

    const sessionsByUser = new Map<number, Session[]>();
    for (const s of officeSessions) {
      const list = sessionsByUser.get(s.userId) ?? [];
      list.push(s);
      sessionsByUser.set(s.userId, list);
    }

    const consultants = officeUsers
      .filter((u) => u.role === "consultant")
      .map((u) => buildConsultantSummary(u, sessionsByUser.get(u.id) ?? [], allScenarios));

    res.json(consultants);
  });

  // Detail: one consultant's full session history (newest first) so a manager can
  // click into an employee and review their actual practice attempts.
  app.get("/api/offices/:officeId/consultants/:userId", async (req, res) => {
    const officeId = Number(req.params.officeId);
    const userId = Number(req.params.userId);
    const requesterId = Number(req.query.requesterId);
    const auth = await authorizeRosterRequest(requesterId, officeId);
    if (!auth.ok) return res.status(auth.status).json({ message: auth.message });

    const target = await storage.getUser(userId);
    if (!target || target.officeId !== officeId || target.role !== "consultant") {
      return res.status(404).json({ message: "Consultant not found in this office" });
    }

    const [userSessions, allScenarios] = await Promise.all([
      storage.listSessionsByUser(userId),
      storage.listScenarios(),
    ]);
    const scenarioById = new Map(allScenarios.map((s) => [s.id, s]));

    const sessions = userSessions
      .map((s) => {
        const scenario = scenarioById.get(s.scenarioId);
        let rubricScores: unknown = null;
        if (s.rubricScores) {
          try {
            rubricScores = JSON.parse(s.rubricScores);
          } catch {
            rubricScores = null;
          }
        }
        return {
          id: s.id,
          scenarioTitle: scenario?.title ?? `Conversation #${s.scenarioId}`,
          scenarioVertical: scenario?.vertical ?? null,
          track: scenarioTrack(scenario?.track),
          status: s.status,
          score: s.score,
          rubricScores,
          createdAt: s.createdAt,
          completedAt: s.completedAt,
        };
      })
      .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt));

    res.json({
      consultant: buildConsultantSummary(target, userSessions, allScenarios),
      sessions,
    });
  });
}

// Public-safe user shape returned to the client (never leaks the password).
function publicUser(user: User) {
  return {
    id: user.id,
    officeId: user.officeId,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    currentLevel: user.currentLevel,
    leadershipLevel: user.leadershipLevel,
    seatActive: user.seatActive,
    isDemoAccount: user.isDemoAccount,
    consultingCertified: user.consultingCertified,
    consultingCertifiedAt: user.consultingCertifiedAt,
    leadershipCertified: user.leadershipCertified,
    leadershipCertifiedAt: user.leadershipCertifiedAt,
  };
}

// Access gate for roleplay/session actions. Regardless of role, the acting user must
// hold an active paid seat AND belong to an active office. Demo/QA accounts bypass
// both checks (they are permanently free). Returns a 402 when locked out so the
// client can prompt for billing.
async function checkSeatAccess(
  userId: number,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const user = await storage.getUser(userId);
  if (!user) return { ok: false, status: 401, message: "Unknown user" };
  if (user.isDemoAccount) return { ok: true };

  const office = await storage.getOffice(user.officeId);
  if (!office) return { ok: false, status: 404, message: "Office not found" };
  if (!officeIsActive(office)) {
    return { ok: false, status: 402, message: "Your office subscription is inactive. Billing must be brought current to continue training." };
  }
  if (!user.seatActive) {
    return { ok: false, status: 402, message: "You don't have an active training seat yet." };
  }
  return { ok: true };
}

// Generate a short, unambiguous, uppercase alphanumeric invite code that isn't already in use.
async function generateUniqueInviteCode(): Promise<string> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars (0/O, 1/I)
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = randomBytes(8);
    let code = "";
    for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
    const existing = await storage.getOfficeByInviteCode(code);
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique invite code");
}

async function synthesizeAudio(text: string, voice: string, instructions?: string): Promise<string> {
  const filename = `${randomUUID()}.mp3`;
  const outputPath = path.join(AUDIO_DIR, filename);
  const audioBuffer = await synthesizeSpeech(text, voice, instructions);
  await fs.writeFile(outputPath, audioBuffer);
  return `/api/audio/${filename}`;
}
