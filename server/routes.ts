import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { storage } from "./storage";
import { getCustomerReply, getCustomerOpening, scoreTranscript, synthesizeSpeech, hasProposedRecommendation, computeLevelAdvancement } from "./llm";
import { getVoiceForScenario } from "./voices";
import { transcriptMessageSchema, type TranscriptMessage, type User } from "@shared/schema";
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
  app.get("/api/scenarios", async (_req, res) => {
    const scenarios = await storage.listScenarios();
    res.json(scenarios.filter((s) => s.active));
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
        const openingText = await getCustomerOpening(scenario.customerPersona);
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
      if (!scenario) return res.status(404).json({ message: "Scenario not found" });

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

      // Respond immediately with the text reply — never make the consultant wait on voice.
      const updated = await storage.updateSession(session.id, {
        transcript: JSON.stringify(transcript),
      });
      res.json(updated);

      // Generate audio in the background; the client polls /api/sessions/:id/audio-status/:msgId.
      if (withAudio) {
        synthesizeAudio(customerReplyText, getVoiceForScenario(scenario.slug, scenario.gender))
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

      // Score against the scenario's difficulty so higher levels are graded stricter.
      const scenario = await storage.getScenario(session.scenarioId);
      const { rubric, feedback, overall } = await scoreTranscript(transcript, scenario?.difficulty);

      const updated = await storage.updateSession(session.id, {
        status: "completed",
        score: overall,
        rubricScores: JSON.stringify(rubric),
        feedback,
        completedAt: new Date().toISOString(),
      });

      // Auto-advance the consultant's level if their average score at their
      // current level's difficulty has reached the threshold.
      const user = await storage.getUser(session.userId);
      if (user) {
        const [allSessions, allScenarios] = await Promise.all([
          storage.listSessionsByUser(user.id),
          storage.listScenarios(),
        ]);
        const scenarioDifficulty = new Map(allScenarios.map((s) => [s.id, s.difficulty]));
        const scoresAtLevel = allSessions
          .filter((s) => s.status === "completed" && s.score !== null && scenarioDifficulty.get(s.scenarioId) === user.currentLevel)
          .map((s) => s.score as number);
        const nextLevel = computeLevelAdvancement(user.currentLevel, scoresAtLevel);
        if (nextLevel) {
          await storage.updateUser(user.id, { currentLevel: nextLevel });
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

  return httpServer;
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
    seatActive: user.seatActive,
    isDemoAccount: user.isDemoAccount,
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

async function synthesizeAudio(text: string, voice: string): Promise<string> {
  const filename = `${randomUUID()}.mp3`;
  const outputPath = path.join(AUDIO_DIR, filename);
  const audioBuffer = await synthesizeSpeech(text, voice);
  await fs.writeFile(outputPath, audioBuffer);
  return `/api/audio/${filename}`;
}
