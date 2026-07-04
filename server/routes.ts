import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { storage } from "./storage";
import { getCustomerReply, getCustomerOpening, scoreTranscript, synthesizeSpeech, hasProposedRecommendation, computeLevelAdvancement } from "./llm";
import { getVoiceForScenario } from "./voices";
import { transcriptMessageSchema, type TranscriptMessage } from "@shared/schema";
import { seed } from "./seed";
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

    const existing = await storage.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ message: "That username is already taken. Please choose another." });
    }

    const user = await storage.createUser({
      officeId: office.id,
      username,
      password,
      role: "consultant",
      displayName,
      currentLevel: "beginner",
    });

    res.json({ user: publicUser(user) });
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

      const customerReplyText = await getCustomerReply(scenario.customerPersona, transcript);

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
        synthesizeAudio(customerReplyText, getVoiceForScenario(scenario.slug))
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

      const { rubric, feedback, overall } = await scoreTranscript(transcript);

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
function publicUser(user: { id: number; officeId: number; username: string; role: string; displayName: string; currentLevel: string }) {
  return {
    id: user.id,
    officeId: user.officeId,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    currentLevel: user.currentLevel,
  };
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
