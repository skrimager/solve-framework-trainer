import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import multer from "multer";
import { storage } from "./storage";
import { getCustomerReply, streamCustomerReply, getCustomerOpening, scoreTranscript, synthesizeSpeech, synthesizeSpeechStream, hasProposedRecommendation, detectCloseIntent, computeLevelAdvancement, scoresForTrackAtLevel, scoresForVerticalAtLevel, scenarioTrack, isExamEligible, countQualifyingSessions, computeEscalationTier, REQUIRED_QUALIFYING_SESSIONS, ADVANCE_THRESHOLD, LEVEL_ORDER, gradeWrittenAnswer, WrittenGradingUnavailableError, transcribeAudio } from "./llm";
import {
  computeAwardableLevels,
  countDistinctCertifiedVerticals,
  isSeatCreditEligible,
  officeEarnsCredits,
  formatCents,
  CREDIT_AMOUNT_CENTS,
  LEVEL_LABELS,
  type AcademyLevel,
} from "./credits";
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
import {
  selectPersonaVariant,
  buildPersonaVariantSection,
  scenarioPersonaVariants,
  personaCoreFor,
  sessionVariantSection,
} from "./persona";
import { getVoiceForScenario, getVoiceInstructionsForScenario } from "./voices";
import { getCoachingReply, type CoachingResponder, type CoachingThreadMessage } from "./coaching";
import {
  parsePastedTranscript,
  parseAudioTranscript,
  deriveStalledStep,
  isAllowedAudioFile,
  REAL_CONVERSATION_CONSENT_TEXT,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  type RealConversationScorer,
  type RealConversationTranscriber,
} from "./realConversations";
import {
  evaluateRealConversationCap,
  realConversationCapBlockedMessage,
  REAL_CONVERSATION_MONTHLY_CAP,
} from "./realConversationCap";
import { sendLeadNotification, sendDemoVerificationCode, sendProspectEmail, sendInboundEmail, sendSignupVerificationCode, sendConsultantEnrollmentEmail } from "./notifications";
import {
  canResendSignupCode,
  validateOfficeSetupInput,
} from "./signup";
import {
  buildSequence,
  planApproval,
  sendDueOutreach,
  startOutreachScheduler,
  enrollInboundLead,
  SEQUENCE_STEPS,
} from "./opportunities";
import { enrollDemoDrip } from "./demoDrip";
import {
  verifyUnsubscribeToken,
  normalizeUnsubEmail,
  unsubscribeConfirmationHtml,
  unsubscribeInvalidHtml,
} from "./unsubscribe";
import {
  MAX_DEMO_SESSIONS,
  DEMO_SCENARIO_SLUG,
  demoScenarioSlugForKey,
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
  isDisposableEmail,
  isDeviceLimitReached,
  isIpLimitReached,
  countDemoSessionsInIpWindow,
  isVoiceUnlockedForDemo,
  demoAbuseAnalytics,
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
import { transcriptMessageSchema, type TranscriptMessage, type User, type Contact, type Session, type Scenario, type RealConversation, type RubricScores } from "@shared/schema";
import { seed } from "./seed";
import { isStripeConfigured, getStripe, STRIPE_WEBHOOK_SECRET, APP_URL } from "./stripe";
import {
  officeIsActive,
  createManagerCheckoutSession,
  createBillingPortalSession,
  createSelfServeCheckoutSession,
  setSeatQuantity,
  handleStripeEvent,
  addDashboard,
} from "./billing";
import { generateUniqueInviteCode } from "./invite";
import {
  evaluatePracticeCap,
  computeDurationSeconds,
  blockedMessage,
  type PracticeCapStatus,
} from "./fairUse";
import { randomUUID } from "node:crypto";
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
  // When `trust proxy` is configured (production/Render, set in server/index.ts),
  // Express derives req.ip from X-Forwarded-For while ignoring hops beyond the
  // trusted count, so a client-forged XFF header cannot spoof the IP. We rely on
  // that for the durable per-IP cap. In tests (and any app without trust proxy
  // set) we fall back to reading XFF directly so per-request IPs still vary.
  if (req.app?.get("trust proxy")) {
    return req.ip ?? "unknown";
  }
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

// Derives the "Where it stalled" SOLVE step for a completed practice session and
// attaches it to the response object. This is a presentation-only derivation over
// the UNCHANGED stored rubric (it never alters scoring or persistence), mirroring
// how a real conversation surfaces its stalled step. SOLVE steps only apply to
// the discovery rubric, so leadership/conflict-management sessions (which store a
// different rubric shape in the same field, identified by the activeListening
// key) get a null stalledStep and no badge. A session with no rubric yet (still
// in progress) also yields null.
export function withStalledStep(session: Session): Session & { stalledStep: string | null } {
  return { ...session, stalledStep: deriveSessionStalledStep(session.rubricScores) };
}

function deriveSessionStalledStep(rubricScoresJson: string | null): string | null {
  if (!rubricScoresJson) return null;
  let rubric: unknown;
  try {
    rubric = JSON.parse(rubricScoresJson);
  } catch {
    return null;
  }
  if (!rubric || typeof rubric !== "object" || "activeListening" in rubric) {
    return null;
  }
  return deriveStalledStep(rubric as RubricScores);
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
      // Stamp seat activation on first activation only so the 60-day credit
      // eligibility window is measured from when the seat first went live.
      const updated = await storage.updateUser(user.id, {
        seatActive: true,
        ...(user.seatActivatedAt ? {} : { seatActivatedAt: new Date().toISOString() }),
      });
      await storage.updateOffice(office.id, { activeSeatCount: targetQty });
      res.json({ user: publicUser(updated!) });
    } catch (err: any) {
      console.error("Manager seat purchase failed:", err);
      res.status(500).json({ message: err.message ?? "Could not add your seat" });
    }
  });

  // Add the optional Manager Dashboard to an already-active office (the friendly
  // in-dashboard upsell). Adds the dashboard line to the existing Stripe
  // subscription at the office's current tier; access follows the persisted
  // managerItemId. Idempotent via addDashboard (no-op if already present).
  app.post("/api/billing/add-dashboard", async (req, res) => {
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });
    const { userId } = req.body ?? {};
    const user = await storage.getUser(Number(userId));
    if (!user || user.role !== "manager") {
      return res.status(403).json({ message: "Only a manager can add the dashboard" });
    }
    const office = await storage.getOffice(user.officeId);
    if (!office) return res.status(404).json({ message: "Office not found" });
    if (!officeIsActive(office)) {
      return res.status(402).json({ message: "Your office subscription is not active" });
    }
    if (office.managerItemId) {
      return res.status(409).json({ message: "The Manager Dashboard is already active for your office." });
    }
    try {
      await addDashboard(office);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("Add dashboard failed:", err);
      res.status(500).json({ message: err.message ?? "Could not add the dashboard" });
    }
  });

  // --- Self-serve manager signup (email-first, verify, office setup, pay) ------
  // Step 1: capture email + company FIRST. Creates (or refreshes) the signup row
  // keyed by email and emails a 6-digit verification code. Every started signup
  // becomes a durable, reachable record from the very first screen.
  app.post("/api/signup/start", async (req, res) => {
    if (!demoLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const schema = z.object({
      email: z.string().trim().email("A valid email is required").max(200),
      company: z.string().trim().min(1, "Company name is required").max(200),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const email = normalizeEmail(parsed.data.email);
    const company = parsed.data.company;
    if (isDisposableEmail(email)) {
      return res.status(400).json({ message: "Please use a permanent business email address." });
    }

    const now = new Date();
    const code = generateVerificationCode();
    const patch = { code, codeExpiresAt: codeExpiryFrom(now.getTime()), lastSentAt: now.toISOString() };

    let signup = await storage.getOfficeSignupByEmail(email);
    if (!signup) {
      signup = await storage.createOfficeSignup({
        email,
        company,
        code: patch.code,
        codeExpiresAt: patch.codeExpiresAt,
        verified: false,
        dashboard: false,
        createdAt: now.toISOString(),
        lastSentAt: patch.lastSentAt,
      });
    } else {
      // Refresh the company name (they may have corrected it) and issue a new code.
      await storage.updateOfficeSignup(signup.id, { ...patch, company });
    }

    const sent = await sendSignupVerificationCode(email, code);
    if (!sent) {
      return res.status(502).json({ message: "We couldn't send your code just now. Please try again in a moment.", retryable: true });
    }
    res.json({ ok: true });
  });

  // Step 2: verify the 6-digit code. On success the email is marked verified and
  // the buyer may proceed to office setup. The code is single-use.
  app.post("/api/signup/verify", async (req, res) => {
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
    const signup = await storage.getOfficeSignupByEmail(email);
    if (!signup || !isCodeValid(signup, parsed.data.code)) {
      return res.status(400).json({ message: "That code is incorrect or has expired. Please try again." });
    }
    await storage.updateOfficeSignup(signup.id, { verified: true, code: null, codeExpiresAt: null });
    res.json({ verified: true, company: signup.company });
  });

  // Resend the verification code (step 2 helper). Cooldown-limited so the button
  // cannot be hammered into an email flood.
  app.post("/api/signup/resend", async (req, res) => {
    if (!demoLimiter.check(clientIp(req))) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    const schema = z.object({ email: z.string().trim().email("A valid email is required").max(200) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const email = normalizeEmail(parsed.data.email);
    const signup = await storage.getOfficeSignupByEmail(email);
    if (!signup) {
      return res.status(404).json({ message: "Start your signup with your email and company first." });
    }
    if (!canResendSignupCode(signup)) {
      return res.status(429).json({ message: "Please wait a moment before requesting another code." });
    }
    const now = new Date();
    const code = generateVerificationCode();
    await storage.updateOfficeSignup(signup.id, {
      code,
      codeExpiresAt: codeExpiryFrom(now.getTime()),
      lastSentAt: now.toISOString(),
    });
    const sent = await sendSignupVerificationCode(email, code);
    if (!sent) {
      return res.status(502).json({ message: "We couldn't resend your code just now. Please try again in a moment.", retryable: true });
    }
    res.json({ ok: true });
  });

  // Step 3/4: the verified buyer submits their office details and starts payment.
  // Their chosen login credentials are stored on the signup row (NEVER sent to
  // Stripe); only the signup row id rides on Checkout metadata so the payment
  // webhook (the sole activation trigger) can create the office + manager login.
  app.post("/api/signup/checkout", async (req, res) => {
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });
    const schema = z.object({
      email: z.string().trim().email("A valid email is required").max(200),
      company: z.string().trim().min(1, "Company name is required").max(200),
      managerName: z.string().trim().min(1, "Your name is required").max(200),
      username: z.string().trim().min(1, "A username is required").max(100),
      password: z.string().min(6, "Please choose a password of at least 6 characters").max(200),
      seatCount: z.coerce.number().int().min(1, "At least one consultant is required"),
      includeDashboard: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const email = normalizeEmail(parsed.data.email);
    const { company, managerName, username, password, seatCount, includeDashboard } = parsed.data;

    const signup = await storage.getOfficeSignupByEmail(email);
    if (!signup) {
      return res.status(404).json({ message: "Start your signup with your email and company first." });
    }
    if (!signup.verified) {
      return res.status(403).json({ message: "Please verify your email before continuing to payment." });
    }

    const inputError = validateOfficeSetupInput({ company, managerName, username, password, seatCount });
    if (inputError) return res.status(400).json({ message: inputError });

    // Reject a username already taken up front for a clear error (provisioning
    // still disambiguates as a safety net if it is taken between now and payment).
    if (await storage.getUserByUsername(username.trim())) {
      return res.status(409).json({ message: "That username is already taken. Please choose another." });
    }

    // Persist the office-setup inputs so the payment webhook can provision from them.
    await storage.updateOfficeSignup(signup.id, {
      company,
      managerName,
      username: username.trim(),
      password,
      seatCount,
      dashboard: includeDashboard,
    });

    try {
      const url = await createSelfServeCheckoutSession({
        officeName: company,
        seatCount,
        includeDashboard,
        email,
        signupId: signup.id,
      });
      res.json({ url });
    } catch (err: any) {
      console.error("Signup checkout creation failed:", err);
      res.status(500).json({ message: err.message ?? "Could not start checkout" });
    }
  });

  // --- Self-serve office setup (welcome-email link -> checkout -> provisioning) ---
  // Validate a setup token and return prefill data for the office setup page.
  app.get("/api/office-setup/:token", async (req, res) => {
    const token = await storage.getOfficeSetupToken(req.params.token);
    if (!token) return res.status(404).json({ message: "This setup link is not valid." });
    if (token.usedAt) {
      return res.status(410).json({ message: "This setup link has already been used." });
    }
    if (new Date(token.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ message: "This setup link has expired. Contact us for a new one." });
    }
    res.json({ email: token.email, name: token.name ?? null });
  });

  // Create a self-serve Checkout Session (item 4). No office exists yet; the office
  // is provisioned by the Stripe webhook on completion (item 5).
  app.post("/api/office-setup/checkout", async (req, res) => {
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });
    const schema = z.object({
      token: z.string().trim().min(1).optional(),
      officeName: z.string().trim().min(1, "Office name is required"),
      seatCount: z.coerce.number().int().min(1, "At least one consultant is required"),
      includeDashboard: z.boolean().default(false),
      email: z.string().trim().email().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const { token, officeName, seatCount, includeDashboard, email } = parsed.data;

    if (seatCount >= 36) {
      return res.status(400).json({ message: "36+ consultants is Enterprise. Contact us for a custom quote." });
    }

    // Resolve token (if any) for the originating lead + verified email.
    let contactId: number | undefined;
    let resolvedEmail = email;
    if (token) {
      const setupToken = await storage.getOfficeSetupToken(token);
      if (!setupToken || setupToken.usedAt || new Date(setupToken.expiresAt).getTime() < Date.now()) {
        return res.status(410).json({ message: "This setup link is no longer valid." });
      }
      contactId = setupToken.contactId ?? undefined;
      resolvedEmail = resolvedEmail || setupToken.email;
    }

    try {
      const url = await createSelfServeCheckoutSession({
        officeName,
        seatCount,
        includeDashboard,
        email: resolvedEmail,
        setupToken: token,
        contactId,
      });
      res.json({ url });
    } catch (err: any) {
      console.error("Self-serve checkout creation failed:", err);
      res.status(500).json({ message: err.message ?? "Could not start checkout" });
    }
  });

  // Confirmation page data: look up the office provisioned for a completed Checkout
  // Session so the buyer sees their invite code + next steps without logging in.
  app.get("/api/office-setup/complete/:sessionId", async (req, res) => {
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });
    try {
      const session = await getStripe().checkout.sessions.retrieve(req.params.sessionId);
      const subId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (!subId) return res.status(404).json({ message: "No subscription for this session yet." });
      const office = await storage.getOfficeByStripeSubscriptionId(subId);
      if (!office) {
        // Provisioning webhook may not have arrived yet; client polls/retries.
        return res.status(202).json({ pending: true });
      }
      res.json({
        officeName: office.name,
        inviteCode: office.inviteCode,
        seatCount: office.activeSeatCount,
        dashboard: !!office.managerItemId,
        commandCenterUrl: `${APP_URL}/#/command-center`,
      });
    } catch (err: any) {
      console.error("Office setup completion lookup failed:", err);
      res.status(500).json({ message: err.message ?? "Could not load your confirmation" });
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
    // Free-path offices start PENDING: the manager can register and log in, but the
    // office cannot practice until an admin activates it (see checkSeatAccess and the
    // admin Vault activate action). Paid self-serve offices are provisioned active by
    // the Stripe webhook, and all pre-existing offices are grandfathered active by the
    // status column default.
    const office = await storage.createOffice({
      name: officeName,
      inviteCode,
      createdAt: new Date().toISOString(),
      status: "pending",
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

    // A consultant may join an office that is active OR a free-path office still
    // pending admin activation (so the team can be assembled before go-live; they
    // are gated from practice by office.status in checkSeatAccess). Any other
    // inactive office (e.g. a lapsed paid subscription) still blocks joining.
    if (!officeIsActive(office) && office.status !== "pending") {
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
      // Stamp seat activation now so the 60-day credit-eligibility clock starts
      // the moment the consultant's paid seat goes live.
      seatActivatedAt: seatActive ? new Date().toISOString() : null,
    });

    res.json({ user: publicUser(user) });
  });

  // Manager enrolls consultants by email (step 6). Sends each address an
  // enrollment email with the office invite code and an activation link. This is
  // the guided path INTO the existing invite-code self-join system: it creates no
  // users and consumes no seats (each consultant still activates themselves via
  // /api/register/consultant with the code). The manager handing out the code
  // directly keeps working exactly as before. Best-effort per recipient.
  app.post("/api/manager/enroll-consultants", async (req, res) => {
    const schema = z.object({
      userId: z.coerce.number().int(),
      emails: z.array(z.string().trim().email()).min(1, "Add at least one email").max(100),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const manager = await storage.getUser(parsed.data.userId);
    if (!manager || manager.role !== "manager") {
      return res.status(403).json({ message: "Only a manager can enroll consultants" });
    }
    const office = await storage.getOffice(manager.officeId);
    if (!office) return res.status(404).json({ message: "Office not found" });

    const activateUrl = `${APP_URL}/#/register?code=${encodeURIComponent(office.inviteCode)}`;
    const results = await Promise.all(
      parsed.data.emails.map(async (raw) => {
        const email = normalizeEmail(raw);
        const sent = await sendConsultantEnrollmentEmail(email, {
          officeName: office.name,
          inviteCode: office.inviteCode,
          activateUrl,
        });
        return { email, sent };
      }),
    );
    res.json({
      sent: results.filter((r) => r.sent).map((r) => r.email),
      failed: results.filter((r) => !r.sent).map((r) => r.email),
    });
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

    // Enforce the monthly fair-use practice cap before creating the session. At
    // the cap, refuse with a friendly message + reset date; in the warn band,
    // allow the session but carry the warning back so the client can surface it.
    const cap = await checkPracticeCap(Number(userId));
    if (cap.blocked) {
      return res.status(403).json({
        message: blockedMessage(cap.resetDate),
        limitReached: true,
        resetDate: cap.resetDate,
        practiceCap: cap,
      });
    }

    // Start every session with the customer's own opening line so the consultant
    // walks in cold (no pre-roleplay briefing) and must uncover the situation
    // through discovery. Falls back to an empty transcript if generation fails,
    // so a flaky LLM call never blocks starting a session.
    // Draw this session's persona rendition (personality, motivation, objections)
    // once at start and store it resolved on the session, so every turn replays
    // the same customer while a fresh session gets a different one. Selection is
    // a no-op for scenarios without variant pools (variantSection is "").
    let openingTranscript = "[]";
    let personaVariant: string | null = null;
    try {
      const scenario = await storage.getScenario(scenarioId);
      if (scenario) {
        const selected = selectPersonaVariant(scenarioPersonaVariants(scenario));
        personaVariant = JSON.stringify(selected);
        const variantSection = buildPersonaVariantSection(selected);
        const openingText = await getCustomerOpening(personaCoreFor(scenario), scenario.track, variantSection);
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
      personaVariant,
      transcript: openingTranscript,
      score: null,
      rubricScores: null,
      feedback: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    // Carry the cap status alongside the session so the client can show the
    // approaching-limit banner when the user is in the warn band.
    res.json({ ...session, practiceCap: cap });
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const session = await storage.getSession(Number(req.params.id));
    if (!session) return res.status(404).json({ message: "Not found" });
    res.json(withStalledStep(session));
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

      const { content, withAudio, stream } = req.body ?? {};
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

      const msgId = randomUUID();

      // Streaming voice path: do NOT block on the full reply here. Append the
      // consultant turn plus an empty customer placeholder, persist, and hand the
      // client a Server-Sent Events URL. The turn-stream endpoint then streams the
      // reply text sentence by sentence, synthesizing and pushing each sentence's
      // audio the instant it is ready (see /turn-stream below). This is what lets
      // the first spoken sentence start within about a second of the user's turn
      // ending instead of after the whole reply is generated and synthesized.
      if (stream && withAudio) {
        const placeholder = transcriptMessageSchema.parse({
          role: "customer",
          content: "",
          audioStatus: "pending",
          // Replay uses this same-msg endpoint later, once content is filled in.
          audioUrl: `/api/sessions/${session.id}/audio-stream/${msgId}`,
          msgId,
          timestamp: new Date().toISOString(),
        });
        transcript.push(placeholder);
        const updated = await storage.updateSession(session.id, {
          transcript: JSON.stringify(transcript),
        });
        res.json({
          ...updated,
          closeCheckpoint,
          streamMsgId: msgId,
          replyStreamUrl: `/api/sessions/${session.id}/turn-stream/${msgId}`,
        });
        return;
      }

      const escalationTier = await computeSessionEscalationTier(session, scenario);

      const variantSection = sessionVariantSection(scenario, session);
      const customerReplyText = await getCustomerReply(personaCoreFor(scenario), transcript, scenario.difficulty, escalationTier, variantSection);

      const customerMsg = transcriptMessageSchema.parse({
        role: "customer",
        content: customerReplyText,
        audioStatus: withAudio ? "pending" : "none",
        // Point at the streaming endpoint up front. The client plays it as soon
        // as the reply arrives (playback starts on the first chunk); the same
        // URL serves the persisted file for later replays once synthesis ends.
        audioUrl: withAudio ? `/api/sessions/${session.id}/audio-stream/${msgId}` : undefined,
        msgId,
        timestamp: new Date().toISOString(),
      });
      transcript.push(customerMsg);

      // Respond immediately with the text reply. Audio is synthesized lazily and
      // streamed when the client requests the audio-stream URL above.
      const updated = await storage.updateSession(session.id, {
        transcript: JSON.stringify(transcript),
      });
      res.json({ ...updated, closeCheckpoint });
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

      const completedAt = new Date().toISOString();
      const updated = await storage.updateSession(session.id, {
        status: "completed",
        score: overall,
        rubricScores: JSON.stringify(rubric),
        feedback,
        completedAt,
        // Record practice time consumed (createdAt to now) so it counts toward
        // the user's monthly fair-use total.
        durationSeconds: computeDurationSeconds(session.createdAt, completedAt),
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

        // Mirror the same advancement per-industry: record progress against the
        // specific (track, vertical) this scenario belongs to, tracked
        // independently from every other industry the consultant practices.
        if (scenario?.vertical) {
          await advanceIndustryCertification(user.id, track, scenario.vertical, allSessions, allScenarios);
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
      const savedAt = new Date().toISOString();
      const updated = await storage.updateSession(session.id, {
        status: "saved",
        savedAt,
        // Practice time spent so far still counts toward the monthly cap even
        // when the session is paused instead of scored.
        durationSeconds: computeDurationSeconds(session.createdAt, savedAt),
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

  // Current monthly fair-use practice standing for a consultant. Lets the
  // practice/scenario pages show the approaching-limit banner (warn band) or the
  // limit-reached message (blocked) without having to attempt a session start.
  app.get("/api/users/:userId/practice-usage", async (req, res) => {
    const user = await storage.getUser(Number(req.params.userId));
    if (!user) return res.status(404).json({ message: "Not found" });
    const cap = await checkPracticeCap(user.id);
    res.json(cap);
  });

  // Serve generated audio files
  app.get("/api/audio/:filename", (req, res) => {
    const filePath = path.join(AUDIO_DIR, req.params.filename);
    if (!fsSync.existsSync(filePath)) return res.status(404).end();
    res.setHeader("Content-Type", "audio/mpeg");
    res.sendFile(filePath);
  });

  // Stream a customer reply's TTS audio. The client points its audio element at
  // this URL the moment the reply text arrives, so playback starts on the first
  // chunk instead of after a fully buffered file plus a poll cycle. The complete
  // audio is teed to disk under the message id so replays (and any later loads)
  // reuse it without re-synthesizing, keeping one TTS call per reply.
  app.get("/api/sessions/:id/audio-stream/:msgId", async (req, res) => {
    const session = await storage.getSession(Number(req.params.id));
    if (!session) return res.status(404).end();
    const transcript: TranscriptMessage[] = JSON.parse(session.transcript);
    const msg = transcript.find((m) => m.msgId === req.params.msgId && m.role === "customer");
    if (!msg) return res.status(404).end();
    const scenario = await storage.getScenario(session.scenarioId);
    if (!scenario) return res.status(404).end();
    await streamMessageAudio(res, {
      msgId: req.params.msgId,
      text: msg.content,
      voice: getVoiceForScenario(scenario.slug, scenario.gender),
      instructions: getVoiceInstructionsForScenario(scenario.slug),
      setStatus: (status) => updateSessionMsgAudioStatus(session.id, req.params.msgId, status),
    });
  });

  // Server-Sent Events turn stream. Generates the customer's reply for the
  // pending placeholder message created by POST /message (stream mode), streaming
  // the text token by token, and pushes one `sentence` event per completed
  // sentence the instant that sentence's audio is synthesized. This replaces the
  // old client poll loop with a push channel so playback of sentence one can
  // begin within about a second while later sentences are still being generated.
  app.get("/api/sessions/:id/turn-stream/:msgId", async (req, res) => {
    const session = await storage.getSession(Number(req.params.id));
    if (!session) return res.status(404).end();
    const scenario = await storage.getScenario(session.scenarioId);
    if (!scenario) return res.status(404).end();
    await runTurnStream(res, {
      msgId: req.params.msgId,
      session,
      scenario,
      voice: getVoiceForScenario(scenario.slug, scenario.gender),
      instructions: getVoiceInstructionsForScenario(scenario.slug),
      persist: (content, status) => updateSessionMsgContentAndStatus(session.id, req.params.msgId, content, status),
    });
  });

  // ===========================================================================
  // Certification exam (two distinct credentials, one per track, fully independent)
  // ===========================================================================

  // Per-track certification status for a user: level, whether they're already
  // certified, progress toward exam eligibility, and any in-flight attempt.
  app.get("/api/users/:userId/certification", async (req, res) => {
    const user = await storage.getUser(Number(req.params.userId));
    if (!user) return res.status(404).json({ message: "Not found" });
    const [allSessions, allScenarios, attempts, industryCerts] = await Promise.all([
      storage.listSessionsByUser(user.id),
      storage.listScenarios(),
      storage.listCertificationAttemptsByUser(user.id),
      storage.listIndustryCertificationsByUser(user.id),
    ]);
    const tracks: Track[] = ["consulting", "leadership"];
    const status = Object.fromEntries(
      tracks.map((t) => [t, certStatusForTrack(user, t, allSessions, allScenarios, attempts, industryCerts)]),
    );
    res.json(status);
  });

  // Start a new exam attempt: draws a random 30-question set from the track's
  // bank. Requires the user to be exam-eligible (Advanced + 5 qualifying
  // Advanced sessions) and not already certified on that track.
  app.post("/api/certification/start", async (req, res) => {
    const { userId, track: rawTrack, vertical: rawVertical } = req.body ?? {};
    const track = normalizeTrack(rawTrack);
    const vertical = typeof rawVertical === "string" && rawVertical.trim() ? rawVertical.trim() : null;
    const gate = await checkSeatAccess(Number(userId));
    if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

    // The certification exam ends in a graded practice scenario, so honor the
    // same monthly fair-use cap here: a consultant at their limit cannot start
    // the exam until the counter resets.
    const cap = await checkPracticeCap(Number(userId));
    if (cap.blocked) {
      return res.status(403).json({
        message: blockedMessage(cap.resetDate),
        limitReached: true,
        resetDate: cap.resetDate,
        practiceCap: cap,
      });
    }

    const user = await storage.getUser(Number(userId));
    if (!user) return res.status(404).json({ message: "User not found" });

    const [allSessions, allScenarios] = await Promise.all([
      storage.listSessionsByUser(user.id),
      storage.listScenarios(),
    ]);
    // Per-industry exam: when a vertical is supplied, eligibility and the
    // already-certified check are scoped to that single industry (so a
    // consultant can certify in several distinct verticals, which is what
    // Cross-Industry credits require). Without a vertical we fall back to the
    // legacy whole-track gate.
    if (vertical) {
      const industryCert = await storage.getIndustryCertification(user.id, track, vertical);
      if (industryCert?.currentLevel === "certified") {
        return res.status(409).json({ message: "You are already certified in this industry." });
      }
      const industryLevel = industryCert?.currentLevel ?? "beginner";
      const advancedScores = scoresForVerticalAtLevel(track, vertical, "advanced", allSessions, allScenarios);
      if (!isExamEligible(industryLevel, advancedScores)) {
        return res.status(403).json({ message: "You are not eligible for the certification exam in this industry yet." });
      }
    } else {
      if (isTrackCertified(user, track)) {
        return res.status(409).json({ message: "You are already certified on this track." });
      }
      const level = track === "leadership" ? user.leadershipLevel : user.currentLevel;
      const advancedScores = scoresForTrackAtLevel(track, "advanced", allSessions, allScenarios);
      if (!isExamEligible(level, advancedScores)) {
        return res.status(403).json({ message: "You are not eligible for the certification exam yet." });
      }
    }

    const questionIds = drawExam(track, EXAM_QUESTION_COUNT);
    const attempt = await storage.createCertificationAttempt({
      userId: user.id,
      track,
      vertical,
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
      vertical,
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
      // This also creates a practice session, so it must honor the same monthly
      // fair-use cap as every other session-creation entry point.
      let scenarioSessionId: number | null = null;
      let capBlockedMessage: string | null = null;
      if (result.passed) {
        const cap = await checkPracticeCap(attempt.userId);
        if (cap.blocked) {
          capBlockedMessage = blockedMessage(cap.resetDate);
        } else {
          const scenario = await pickExpertScenario(track, attempt.vertical);
          if (scenario) {
            const session = await createScenarioSession(attempt.userId, scenario);
            scenarioSessionId = session.id;
          }
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
        practiceCapBlockedMessage: capBlockedMessage,
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

  registerRealConversationRoutes(app);

  registerManagerRosterRoutes(app);

  registerManagerDashboardRoutes(app);

  registerConsultantDashboardRoutes(app);

  registerPublicDemoDashboardRoute(app);

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
  allScenarios: { id: number; track?: string | null; difficulty: string; vertical?: string | null }[],
  attempts: import("@shared/schema").CertificationAttempt[],
  industryCerts: import("@shared/schema").IndustryCertification[] = [],
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
    industries: industryStatusForTrack(track, allSessions, allScenarios, industryCerts),
  };
}

// Per-industry certification breakdown for one track: one entry per vertical the
// consultant has started or certified in, with its level, certified flag, and
// whether that specific industry's exam is now unlocked. Powers the rep profile
// and manager roster "started vs certified" per-industry view.
function industryStatusForTrack(
  track: Track,
  allSessions: { scenarioId: number; status: string; score: number | null }[],
  allScenarios: { id: number; track?: string | null; difficulty: string; vertical?: string | null }[],
  industryCerts: import("@shared/schema").IndustryCertification[],
) {
  const rows = industryCerts.filter((c) => normalizeTrack(c.track) === track);
  return rows
    .map((row) => {
      const advancedScores = scoresForVerticalAtLevel(track, row.vertical, "advanced", allSessions, allScenarios);
      const certified = row.currentLevel === "certified";
      return {
        vertical: row.vertical,
        level: row.currentLevel,
        certified,
        certifiedAt: row.certifiedAt ?? null,
        qualifyingAdvancedSessions: countQualifyingSessions(advancedScores),
        requiredSessions: REQUIRED_QUALIFYING_SESSIONS,
        eligible: !certified && isExamEligible(row.currentLevel, advancedScores),
      };
    })
    .sort((a, b) => a.vertical.localeCompare(b.vertical));
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
    // Certification is earned in a specific industry: the vertical of the final
    // expert scenario the consultant just passed. Record it against that
    // (track, vertical), then re-check whether any SOLVE Success Investment
    // credits are now earned (awarded automatically, in the same code path).
    const vertical = await verticalForCertAttempt(attempt);
    if (vertical) {
      await certifyIndustry(attempt.userId, track, vertical, now);
    }
    await awardAcademyCreditsForUser(attempt.userId, new Date());
  }
}

// The industry vertical a certification attempt certifies in: the vertical of the
// scenario used for the attempt's final expert roleplay.
async function verticalForCertAttempt(
  attempt: import("@shared/schema").CertificationAttempt,
): Promise<string | null> {
  // Prefer the vertical the attempt was started for; fall back to the vertical of
  // the final expert scenario (legacy attempts started before the column existed).
  if (attempt.vertical) return attempt.vertical;
  if (!attempt.scenarioSessionId) return null;
  const session = await storage.getSession(attempt.scenarioSessionId);
  if (!session) return null;
  const scenario = await storage.getScenario(session.scenarioId);
  return scenario?.vertical ?? null;
}

// Advance a consultant's per-industry certification progress for one (track,
// vertical) after a practice session, mirroring the global level advancement but
// scoped to that single vertical. Never touches an already-certified industry.
async function advanceIndustryCertification(
  userId: number,
  track: string,
  vertical: string,
  allSessions: Session[],
  allScenarios: Scenario[],
): Promise<void> {
  const existing = await storage.getIndustryCertification(userId, track, vertical);
  const currentLevel = existing?.currentLevel ?? "beginner";
  if (currentLevel === "certified") return;
  const scores = scoresForVerticalAtLevel(track, vertical, currentLevel, allSessions, allScenarios);
  const nextLevel = computeLevelAdvancement(currentLevel, scores);
  if (existing) {
    if (nextLevel) await storage.updateIndustryCertification(existing.id, { currentLevel: nextLevel });
  } else {
    // First practiced session in this industry: open a progress row so the rep
    // profile can show "started" even before the first advancement.
    await storage.createIndustryCertification({
      userId,
      track,
      vertical,
      currentLevel: nextLevel ?? "beginner",
      certifiedAt: null,
    });
  }
}

// Mark a (track, vertical) as fully certified for a consultant, creating the
// progress row if the exam was passed without any prior practice row.
async function certifyIndustry(userId: number, track: string, vertical: string, now: string): Promise<void> {
  const existing = await storage.getIndustryCertification(userId, track, vertical);
  if (existing) {
    await storage.updateIndustryCertification(existing.id, {
      currentLevel: "certified",
      certifiedAt: existing.certifiedAt ?? now,
    });
  } else {
    await storage.createIndustryCertification({
      userId,
      track,
      vertical,
      currentLevel: "certified",
      certifiedAt: now,
    });
  }
}

// Award any newly-earned SOLVE Success Investment credits for a consultant,
// immediately after a certification event. Gated by the 60-day seat tenure rule
// and by excluding the Apptix demo office. Levels are awarded strictly in
// sequence (see computeAwardableLevels); the unique (userId, level) constraint is
// the final guard against double-awarding under concurrent events.
async function awardAcademyCreditsForUser(userId: number, now: Date): Promise<void> {
  const user = await storage.getUser(userId);
  if (!user) return;
  if (!officeEarnsCredits(user.officeId)) return;
  if (!isSeatCreditEligible(user.seatActivatedAt, now)) return;

  const [industryCerts, existingCredits] = await Promise.all([
    storage.listIndustryCertificationsByUser(userId),
    storage.listAcademyCreditsByUser(userId),
  ]);
  const toAward = computeAwardableLevels({
    consultingCertifiedVerticals: countDistinctCertifiedVerticals(industryCerts, "consulting"),
    leadershipCertifiedVerticals: countDistinctCertifiedVerticals(industryCerts, "leadership"),
    alreadyAwarded: existingCredits.map((c) => c.level),
  });
  for (const level of toAward) {
    await storage.createAcademyCredit({
      userId,
      officeId: user.officeId,
      level,
      amountCents: CREDIT_AMOUNT_CENTS,
      earnedAt: now.toISOString(),
    });
  }
}

// Pick a random active Advanced-difficulty scenario for the given track to serve
// as the certification's final expert roleplay. Reuses the existing scenario
// pool rather than seeding a special one.
async function pickExpertScenario(track: Track, vertical?: string | null) {
  const all = await storage.listScenarios();
  let pool = all.filter((s) => s.active && scenarioTrack(s.track) === track && s.difficulty === "advanced");
  if (vertical) {
    const scoped = pool.filter((s) => (s.vertical ?? null) === vertical);
    // If the industry has no advanced scenario of its own, fall back to the
    // full track pool rather than blocking certification.
    if (scoped.length > 0) pool = scoped;
  }
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
  const selected = selectPersonaVariant(scenarioPersonaVariants(scenario));
  const personaVariant = JSON.stringify(selected);
  try {
    const openingText = await getCustomerOpening(
      personaCoreFor(scenario),
      scenario.track,
      buildPersonaVariantSection(selected)
    );
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
    personaVariant,
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

  // One-click unsubscribe for the new lifecycle emails (demo-activation drip +
  // monthly "Practice makes money" email). Public, no auth: a signed token
  // encodes the recipient's email. On a valid token we add the email to the
  // authoritative suppression list (idempotent) and, if it belongs to a demo
  // signup, flip that row's mirror flag. Always returns a friendly HTML page.
  app.get("/api/unsubscribe", async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    const email = verifyUnsubscribeToken(token);
    if (!email) {
      return res.status(400).type("html").send(unsubscribeInvalidHtml());
    }
    try {
      const normalized = normalizeUnsubEmail(email);
      await storage.createEmailSuppression({ email: normalized, suppressedAt: new Date().toISOString() });
      const signup = await storage.getDemoSignupByEmail(normalized);
      if (signup && !signup.unsubscribed) {
        await storage.updateDemoSignup(signup.id, { unsubscribed: true });
      }
    } catch (err) {
      console.warn("[unsubscribe] Failed to record suppression:", err);
      // Still show the confirmation: the user asked to opt out, and a transient
      // write error should not surface as a scary error page.
    }
    res.status(200).type("html").send(unsubscribeConfirmationHtml());
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
      // Optional referral attribution from the "Request Access" form: the company
      // that referred this lead. Surfaced in the admin CRM for manual credit review.
      referredBy: z.string().trim().max(200).optional().or(z.literal("")),
      source: z.string().trim().max(100).optional().or(z.literal("")),
      // Optional CRM tag. The marketing forms don't send this yet (Phase 2), so
      // it defaults to "general"; a caller may specify any contact type.
      type: contactTypeSchema.optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const { name, email, company, message, referredBy, source, type } = parsed.data;
    const lead = await storage.createLead({
      name,
      email,
      company: company || null,
      message: message || null,
      referredBy: referredBy || null,
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
    // Mint a per-lead office-setup token (item 2) so the welcome email can carry a
    // "Set Up Your Office" link into the self-serve checkout flow. Expires in 14 days.
    // Best-effort: if token creation fails, still enroll the lead (without the CTA).
    let setupUrl: string | undefined;
    try {
      const token = randomUUID().replace(/-/g, "");
      const nowMs = Date.now();
      await storage.createOfficeSetupToken({
        token,
        contactId: lead.id,
        email: lead.email,
        name: lead.name ?? null,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 14 * 24 * 60 * 60 * 1000).toISOString(),
        usedAt: null,
      });
      setupUrl = `${APP_URL}/#/office-setup/${token}`;
    } catch (err) {
      console.warn("[leads] Failed to create office setup token:", err);
    }
    // Auto-enroll this NEW inbound lead into the welcome drip: the day-0 welcome
    // is sent inline (best-effort) and the day-3/day-7 follow-ups are scheduled
    // for the shared background sender. Fire-and-forget and never throws, so it
    // is fully independent of the founder notification and never blocks capture.
    void enrollInboundLead({ storage, send: sendInboundEmail }, lead, setupUrl);
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
  // getCustomerReply / scoreTranscript / streamMessageAudio / getVoiceForScenario.
  // Anonymous demo traffic lives in demo_signups/demo_sessions and never touches
  // the seat-gated users/sessions tables, office analytics, or level progression.

  // Load the demo scenario for the visitor's chosen industry option (by slug).
  // An unknown/missing key resolves to the default (automotive). The lead route
  // calls this with no key to get the default scenario's track.
  async function getDemoScenario(choiceKey?: string | null) {
    return storage.getScenarioBySlug(demoScenarioSlugForKey(choiceKey));
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

    // Block throwaway/temporary domains before a code is ever sent. Allowlisted
    // founder emails are never blocked (they are real mailboxes anyway).
    if (!isUnlimitedDemoEmail(email) && isDisposableEmail(email)) {
      return res.status(400).json({ message: "Please use a permanent email address to start your free demo." });
    }

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

    // Enroll into the demo-activation drip on the FIRST verification only (never
    // backfill an already-verified signup). Fire-and-forget: best-effort, never
    // throws, so it can never block or fail the verify response.
    if (!signup.verified) {
      void enrollDemoDrip({ storage, send: sendInboundEmail }, { id: signup.id, email });
    }

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

    // Fair-use caps, checked in parallel with the per-email cap. If ANY of the
    // three limits (email, device, IP) is hit, block before creating a session.
    // All are bypassed for allowlisted founder emails via the helpers below.
    const fingerprint =
      typeof req.body?.fingerprint === "string" && req.body.fingerprint.trim()
        ? req.body.fingerprint.trim().slice(0, 128)
        : null;
    const ip = clientIp(req);

    if (isSessionLimitReached(signup.sessionsUsed, signup.email)) {
      return res.status(403).json({ message: "You've used all 3 free demo sessions.", limitReached: true, remaining: 0, reason: "email" });
    }

    const deviceCount = fingerprint
      ? (await storage.listDemoSessionsByFingerprint(fingerprint)).length
      : 0;
    if (isDeviceLimitReached(deviceCount, signup.email)) {
      return res.status(403).json({ message: "You've used all your free practice sessions.", limitReached: true, remaining: 0, reason: "device" });
    }

    const ipRows = await storage.listDemoSessionsByIp(ip);
    const ipCount = countDemoSessionsInIpWindow(ipRows);
    if (isIpLimitReached(ipCount, signup.email)) {
      return res.status(403).json({ message: "You've used all your free practice sessions.", limitReached: true, remaining: 0, reason: "ip" });
    }

    const scenario = await getDemoScenario(typeof req.body?.scenario === "string" ? req.body.scenario : undefined);
    if (!scenario) return res.status(500).json({ message: "Demo is temporarily unavailable." });

    // Increment usage FIRST so a failure after this point can't grant a free retry.
    // Exempted (unlimited) emails skip the counter entirely so the cap never applies to them.
    const updatedSignup = isUnlimitedDemoEmail(signup.email)
      ? signup
      : await storage.updateDemoSignup(signup.id, { sessionsUsed: signup.sessionsUsed + 1 });
    // 1-based ordinal of this session for the email; drives voice unlock. Founder
    // (unlimited) rows aren't incremented, so derive from the pre-start count + 1.
    const sessionNumber = isUnlimitedDemoEmail(signup.email)
      ? signup.sessionsUsed + 1
      : updatedSignup?.sessionsUsed ?? signup.sessionsUsed + 1;
    const voiceEnabled = isVoiceUnlockedForDemo(sessionNumber, signup.email);

    // Create the session first so its id can seed a stable persona rendition.
    // Demo sessions have no persona_variant column, so the rendition is
    // re-derived deterministically from the session id (via resolveSessionVariant)
    // on both the opening and every reply, keeping the customer consistent for
    // the whole demo conversation while still varying replay to replay.
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
    });

    try {
      const variantSection = sessionVariantSection(scenario, { id: session.id, personaVariant: null });
      const openingText = await getCustomerOpening(personaCoreFor(scenario), scenario.track, variantSection);
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
      console.error("Demo opening generation failed; starting empty:", err);
    }

    res.json({
      session: publicDemoSession(session),
      remaining: remainingSessions(updatedSignup?.sessionsUsed ?? signup.sessionsUsed + 1, signup.email),
      // Voice (server TTS) is unlocked only on the third free session; the client
      // hides the voice toggle otherwise. Enforced server-side in the message route.
      voiceEnabled,
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

      // Voice (server TTS) is unlocked only on the third free session (see
      // isVoiceUnlockedForDemo). Gate it here so a frontend-only default cannot
      // force text-mode sessions 1 and 2 to spend TTS budget: even if the client
      // sends withAudio, we ignore it unless the session's ordinal unlocks voice.
      const voiceUnlocked = isVoiceUnlockedForDemo(session.sessionNumber, signup.email);
      const { content, withAudio } = req.body ?? {};
      const useAudio = Boolean(withAudio) && voiceUnlocked;
      const transcript = JSON.parse(session.transcript);
      const consultantMsg = transcriptMessageSchema.parse({
        role: "consultant",
        content,
        timestamp: new Date().toISOString(),
      });
      transcript.push(consultantMsg);

      const variantSection = sessionVariantSection(scenario, { id: session.id, personaVariant: null });
      const customerReplyText = await getCustomerReply(personaCoreFor(scenario), transcript, scenario.difficulty, 0, variantSection);
      const msgId = randomUUID();
      const customerMsg = transcriptMessageSchema.parse({
        role: "customer",
        content: customerReplyText,
        audioStatus: useAudio ? "pending" : "none",
        // Streamed on demand from this URL (see the sessions route for details).
        // Gated on useAudio (voiceUnlocked && withAudio), not the raw withAudio
        // flag, so a client can't force TTS budget spend on a locked session.
        audioUrl: useAudio ? `/api/demo/session/${session.id}/audio-stream/${msgId}` : undefined,
        msgId,
        timestamp: new Date().toISOString(),
      });
      transcript.push(customerMsg);

      const updated = await storage.updateDemoSession(session.id, { transcript: JSON.stringify(transcript) });
      res.json({ session: publicDemoSession(updated!) });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: err.message ?? "Failed to process message" });
    }
  });

  // Stream a demo reply's TTS audio on demand (mirrors the sessions endpoint).
  // Not signup-gated: the request comes from an <audio> element that cannot send
  // the demo token, and the unguessable msgId is the capability (this matches
  // the previous unauthenticated /api/audio/<uuid>.mp3 static file behavior).
  app.get("/api/demo/session/:id/audio-stream/:msgId", async (req, res) => {
    const session = await storage.getDemoSession(Number(req.params.id));
    if (!session) return res.status(404).end();
    // Server-side re-check: voice is only unlocked on the third free session
    // (see isVoiceUnlockedForDemo). The JSON response only includes audioUrl
    // when unlocked, but that alone doesn't stop a crafted direct request to
    // this URL from spending TTS budget on a locked session, so gate here too.
    if (!isVoiceUnlockedForDemo(session.sessionNumber, session.email)) {
      return res.status(403).end();
    }
    const transcript: TranscriptMessage[] = JSON.parse(session.transcript);
    const msg = transcript.find((m) => m.msgId === req.params.msgId && m.role === "customer");
    if (!msg) return res.status(404).end();
    const scenario = await storage.getScenario(session.scenarioId);
    if (!scenario) return res.status(404).end();
    await streamMessageAudio(res, {
      msgId: req.params.msgId,
      text: msg.content,
      voice: getVoiceForScenario(scenario.slug, scenario.gender),
      instructions: getVoiceInstructionsForScenario(scenario.slug),
      setStatus: (status) => updateDemoMsgAudioStatus(session.id, req.params.msgId, status),
    });
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
      referredBy: l.referredBy ?? "",
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
      { key: "referredBy", header: "Referred By" },
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
      referredBy: c.referredBy ?? "",
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
      { key: "referredBy", header: "Referred By" },
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
    const [allOffices, allCredits] = await Promise.all([
      storage.listOffices(),
      storage.listAllAcademyCredits(),
    ]);
    const { rows: baseRows, totalMrr, activeOffices } = summarizeSales(allOffices);
    const creditCentsByOffice = new Map<number, number>();
    for (const c of allCredits) {
      creditCentsByOffice.set(c.officeId, (creditCentsByOffice.get(c.officeId) ?? 0) + c.amountCents);
    }
    // Enrich each office row with its total earned SOLVE Success Investment
    // credit (sum of academy_credits.amountCents). Read-only; touches no billing.
    const rows = baseRows.map((r) => {
      const academyCreditCents = creditCentsByOffice.get(r.officeId) ?? 0;
      return { ...r, academyCreditCents, academyCreditDisplay: formatCents(academyCreditCents) };
    });
    const totalAcademyCreditCents = Array.from(creditCentsByOffice.values()).reduce((sum, c) => sum + c, 0);
    const csvRows = rows.map((r) => ({
      officeId: r.officeId,
      officeName: r.officeName,
      subscriptionStatus: r.subscriptionStatus,
      seatCount: r.seatCount,
      seatsMrr: r.seatsMrr,
      managerMrr: r.managerMrr,
      mrr: r.mrr,
      academyCreditCents: r.academyCreditCents,
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
        { key: "academyCreditCents", header: "Academy Credit (cents)" },
      ], csvRows);
    }
    res.json({ rows, totalMrr, activeOffices, totalAcademyCreditCents, totalAcademyCreditDisplay: formatCents(totalAcademyCreditCents) });
  });

  // Grant an office permanent free "demo" access with zero Stripe involvement —
  // the exact state the seeded DEMO2024 office runs in (see server/seed.ts):
  // subscriptionStatus "active" (no Stripe ids), and every user in the office
  // marked isDemoAccount + seatActive so the whole office bypasses both the
  // office billing gate (officeIsActive) and the per-seat gate (checkSeatAccess).
  // Internal founder tool only: admin-guarded, never surfaced in the app UI, and
  // touches no Stripe code. Idempotent — re-running just re-asserts the same state.
  app.post("/api/admin/offices/:id/grant-demo-access", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const office = await storage.getOffice(id);
    if (!office) return res.status(404).json({ message: "Office not found" });

    const updatedOffice = await storage.updateOffice(id, { subscriptionStatus: "active" });
    const officeUsers = await storage.listUsersByOffice(id);
    for (const u of officeUsers) {
      await storage.updateUser(u.id, { isDemoAccount: true, seatActive: true });
    }
    res.json({ office: updatedOffice, usersUpdated: officeUsers.length });
  });

  // Reverse a demo grant: lock the office back out (subscriptionStatus
  // "incomplete", the default for an office with no live subscription) and clear
  // the demo flags on its users. Idempotent, and provided only as a safety hatch —
  // it does not touch Stripe, so an office that actually has a paid subscription
  // will be re-synced to its true status by the next Stripe webhook.
  app.post("/api/admin/offices/:id/revoke-demo-access", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const office = await storage.getOffice(id);
    if (!office) return res.status(404).json({ message: "Office not found" });

    const updatedOffice = await storage.updateOffice(id, { subscriptionStatus: "incomplete" });
    const officeUsers = await storage.listUsersByOffice(id);
    for (const u of officeUsers) {
      await storage.updateUser(u.id, { isDemoAccount: false, seatActive: false });
    }
    res.json({ office: updatedOffice, usersUpdated: officeUsers.length });
  });

  // Activate a free-path office (item 6). Free offices created via
  // /api/register/manager start status 'pending' and cannot practice; this admin
  // action is the only way to bring them live. It flips status to 'active' and,
  // for offices with no Stripe subscription, marks subscriptionStatus 'active' so
  // they clear the practice gate (officeIsActive) without any billing (mirrors the
  // demo-grant pattern, minus the demo flags). Offices that already have a real
  // Stripe subscription keep their true Stripe status. Idempotent.
  app.post("/api/admin/offices/:id/activate", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
    const office = await storage.getOffice(id);
    if (!office) return res.status(404).json({ message: "Office not found" });
    const patch: { status: string; subscriptionStatus?: string } = { status: "active" };
    if (!office.stripeSubscriptionId) patch.subscriptionStatus = "active";
    const updatedOffice = await storage.updateOffice(id, patch);
    res.json({ office: updatedOffice });
  });

  // Persistent list of completed paid self-serve signups for the Vault (item 7).
  app.get("/api/admin/paid-signups", requireAdmin, async (req, res) => {
    const signups = await storage.listPaidOfficeSignups();
    const rows = signups.map((s) => ({
      id: s.id,
      officeName: s.officeName,
      seatCount: s.seatCount,
      dashboard: s.dashboard ? "yes" : "no",
      stripeSubscriptionId: s.stripeSubscriptionId ?? "",
      contactEmail: s.contactEmail ?? "",
      createdAt: s.createdAt,
    }));
    sendData(req, res, "paid-signups.csv", [
      { key: "id", header: "ID" },
      { key: "officeName", header: "Office" },
      { key: "seatCount", header: "Seats" },
      { key: "dashboard", header: "Dashboard" },
      { key: "stripeSubscriptionId", header: "Stripe Subscription" },
      { key: "contactEmail", header: "Buyer Email" },
      { key: "createdAt", header: "Signed Up" },
    ], rows);
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

    // CSV export keeps its original per-signup shape so existing tooling and the
    // download button are unchanged. The richer abuse-protection analytics below
    // are JSON-only (the admin UI renders them; they do not belong in the CSV).
    if (req.query.format === "csv") {
      return sendData(req, res, "demo.csv", [
        { key: "id", header: "ID" },
        { key: "email", header: "Email" },
        { key: "verified", header: "Verified" },
        { key: "sessionsUsed", header: "Sessions Used" },
        { key: "maxSessions", header: "Max" },
        { key: "completedSessions", header: "Completed" },
        { key: "createdAt", header: "First Seen" },
        { key: "lastSentAt", header: "Last Code Sent" },
      ], rows);
    }

    res.json({ rows, analytics: demoAbuseAnalytics(sessions) });
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
// Real Conversation Scoring (Phase 1). A rep pastes a real discovery
// conversation (text/SMS/chat or an email thread); it is parsed into the SAME
// TranscriptMessage[] the practice engine consumes and scored by the UNCHANGED
// scoreTranscript. Results live in their own `real_conversations` table so they
// never mix with practice sessions, analytics, or level progression.
//
// Routes, gated by the existing paid-seat check (checkSeatAccess):
//   POST /api/real-conversations           (submit + score a real conversation)
//   POST /api/real-conversations/audio     (audio upload variant)
//   GET  /api/real-conversations?userId=N  (submissions ABOUT the caller)
//
// Consent is mandatory: a submission is rejected unless consentAccepted is true,
// and a timestamped consent record (submitter id + submission id + timestamp) is
// persisted with the row.
//
// Phase 3 additions:
//   * A manager/QA can submit ON BEHALF of a rep by passing subjectRepUserId; the
//     submitter must be authorized for that rep's office (authorizeRosterRequest).
//   * A per-rep monthly submission cap (evaluateRealConversationCap) hard-blocks
//     at REAL_CONVERSATION_MONTHLY_CAP, keyed on the subject rep.
//   * The GET endpoint returns submissions where the caller is the SUBJECT rep, so
//     reps see manager-submitted scores about them (with attribution).
// ===========================================================================

// A real-conversation row decorated with the submitter's display name and a flag
// for whether it was submitted by someone other than the subject rep (a manager
// on the rep's behalf). Used by both the rep's own view and the manager Field
// view so attribution renders identically in each.
type DecoratedRealConversation = RealConversation & {
  submittedByName: string | null;
  managerSubmitted: boolean;
};

// Attach the submitter's display name to each row (one lookup per distinct
// submitter) and mark manager-submitted rows. Never changes authorization or the
// set of rows, only enriches them for display.
async function decorateRealConversations(
  rows: RealConversation[],
): Promise<DecoratedRealConversation[]> {
  const submitterIds = Array.from(new Set(rows.map((r) => r.submittedByUserId)));
  const submitters = await Promise.all(submitterIds.map((id) => storage.getUser(id)));
  const nameById = new Map<number, string>();
  for (const u of submitters) if (u) nameById.set(u.id, u.displayName);
  return rows.map((r) => ({
    ...r,
    submittedByName: nameById.get(r.submittedByUserId) ?? null,
    managerSubmitted: r.submittedByUserId !== r.subjectRepUserId,
  }));
}

// Resolve who a submission is ABOUT. With no explicit target (or a target equal
// to the submitter) this is the Phase 1 self-submit path, preserved exactly. With
// an explicit different target it is the manager-on-behalf path: the submitter
// must be a manager/QA authorized for the target rep's office, and the target must
// be a consultant. Returns the subject rep id + the office the row belongs to.
async function resolveRealConversationSubject(
  submitterId: number,
  submitter: User,
  rawSubjectRepId: unknown,
): Promise<
  | { ok: true; subjectRepUserId: number; officeId: number }
  | { ok: false; status: number; message: string }
> {
  const provided =
    rawSubjectRepId !== undefined && rawSubjectRepId !== null && `${rawSubjectRepId}`.trim() !== "";
  if (!provided) {
    return { ok: true, subjectRepUserId: submitterId, officeId: submitter.officeId };
  }
  const subjectRepUserId = Number(rawSubjectRepId);
  if (!subjectRepUserId) {
    return { ok: false, status: 400, message: "subjectRepUserId must be a valid user id" };
  }
  if (subjectRepUserId === submitterId) {
    return { ok: true, subjectRepUserId: submitterId, officeId: submitter.officeId };
  }
  const target = await storage.getUser(subjectRepUserId);
  if (!target || target.role !== "consultant") {
    return { ok: false, status: 404, message: "Target rep not found" };
  }
  // Same office-scoped manager/QA authorization the roster routes use.
  const auth = await authorizeRosterRequest(submitterId, target.officeId);
  if (!auth.ok) return auth;
  return { ok: true, subjectRepUserId, officeId: target.officeId };
}

// Cap gate: block when the subject rep has already hit the monthly submission cap.
// Returns the {ok,status,message} shape used by the other gates in this file.
async function checkRealConversationCap(
  subjectRepUserId: number,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const rows = await storage.listRealConversationsBySubjectRep(subjectRepUserId);
  const cap = evaluateRealConversationCap({ rows, now: new Date() });
  if (cap.blocked) {
    return { ok: false, status: 429, message: realConversationCapBlockedMessage(cap.resetDate) };
  }
  return { ok: true };
}

export function registerRealConversationRoutes(
  app: Express,
  opts: { scorer?: RealConversationScorer; transcriber?: RealConversationTranscriber } = {},
): void {
  // Injectable so tests can score without the OpenAI client. Defaults to the
  // same engine practice sessions use, called with its default consulting track.
  // The engine's return type unions consulting + leadership rubrics; Phase 1
  // real conversations always score on the default consulting track, so the
  // rubric is RubricScores. The cast narrows to that Phase 1 contract.
  const scorer: RealConversationScorer = opts.scorer ?? (scoreTranscript as RealConversationScorer);
  // Injectable Whisper transcription (Phase 2), stubbed the same way in tests so
  // they need no network. Defaults to the shared OpenAI client's Whisper call.
  const transcriber: RealConversationTranscriber = opts.transcriber ?? transcribeAudio;

  // Multipart handler for audio uploads. Memory storage (the buffer is streamed
  // straight to Whisper, never persisted to disk), restricted to a single file,
  // with the 25MB cap enforced HERE as a first line of defense and the mp3/m4a/wav
  // allow-list rejected before the buffer is even read.
  const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (isAllowedAudioFile(file.originalname)) cb(null, true);
      else cb(new Error("Unsupported file type. Upload an mp3, m4a, or wav file."));
    },
  });

  app.post("/api/real-conversations", async (req, res) => {
    try {
      const { userId, submissionType, rawTranscript, consentAccepted, subjectRepUserId } =
        req.body ?? {};

      const submitterId = Number(userId);
      if (!submitterId) return res.status(400).json({ message: "userId is required" });

      const submitter = await storage.getUser(submitterId);
      if (!submitter) return res.status(401).json({ message: "Unknown user" });

      // Resolve who the submission is about (self, or a rep the manager is
      // authorized to submit for). Rejects unauthorized manager-on-behalf attempts.
      const subject = await resolveRealConversationSubject(submitterId, submitter, subjectRepUserId);
      if (!subject.ok) return res.status(subject.status).json({ message: subject.message });

      // Paid-seat gate checks the TARGET rep's seat, since the seat being used is
      // the rep's. 402 when the office/seat is unpaid.
      const gate = await checkSeatAccess(subject.subjectRepUserId);
      if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

      // This JSON route only handles pasted transcripts. Audio submissions have
      // their own multipart route below, so 'audio' is rejected here even though
      // it is a valid stored submission type.
      if (submissionType !== "text_chat" && submissionType !== "email") {
        return res.status(400).json({ message: "submissionType must be 'text_chat' or 'email'." });
      }

      const transcriptText = typeof rawTranscript === "string" ? rawTranscript.trim() : "";
      if (!transcriptText) {
        return res.status(400).json({ message: "Paste the conversation you want scored." });
      }

      // Consent gate: no submission is accepted or scored without it. Applies
      // unchanged whether a rep or a manager on the rep's behalf is submitting.
      if (consentAccepted !== true) {
        return res.status(400).json({ message: REAL_CONVERSATION_CONSENT_TEXT });
      }

      // Monthly per-rep cap. Hard block at the ceiling; no row is created.
      const cap = await checkRealConversationCap(subject.subjectRepUserId);
      if (!cap.ok) return res.status(cap.status).json({ message: cap.message });

      const parsed = parsePastedTranscript(transcriptText, submissionType);
      if (parsed.length === 0) {
        return res.status(400).json({ message: "That submission had no readable conversation content." });
      }

      // Reuse the practice engine unchanged (default consulting track/difficulty).
      const { rubric, feedback, overall } = await scorer(parsed);
      const stalledStep = deriveStalledStep(rubric as any);

      const nowIso = new Date().toISOString();
      const created = await storage.createRealConversation({
        submittedByUserId: submitterId,
        subjectRepUserId: subject.subjectRepUserId,
        officeId: subject.officeId,
        submissionType,
        rawTranscript: transcriptText,
        originalAudioFilename: null,
        overallScore: overall,
        rubricScores: JSON.stringify(rubric),
        feedback,
        stalledStep,
        consentAccepted: true,
        consentAcceptedAt: nowIso,
        createdAt: nowIso,
        // Counted toward the cap at creation time and never recalculated.
        submissionCountedForCap: true,
        fieldVerifiedEligible: null,
      });

      res.json(created);
    } catch (err: any) {
      console.error("Real conversation scoring failed:", err);
      res.status(500).json({ message: err.message ?? "Failed to score the conversation" });
    }
  });

  // Phase 2: audio upload. A rep uploads an mp3/m4a/wav recording of a real
  // discovery conversation; it is transcribed by Whisper and fed into the EXACT
  // same scoreTranscript pipeline as pasted text/email. The multer middleware is
  // wrapped so its file-type/size rejections return a clean 400 JSON error
  // instead of surfacing as an unhandled error.
  app.post(
    "/api/real-conversations/audio",
    (req: Request, res: Response, next: NextFunction) => {
      audioUpload.single("audio")(req, res, (err: any) => {
        if (err) {
          const message =
            err?.code === "LIMIT_FILE_SIZE"
              ? "Audio file is too large. The maximum size is 25MB."
              : err?.message ?? "Audio upload failed.";
          return res.status(400).json({ message });
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        const { userId, consentAccepted, subjectRepUserId } = req.body ?? {};

        const submitterId = Number(userId);
        if (!submitterId) return res.status(400).json({ message: "userId is required" });

        const submitter = await storage.getUser(submitterId);
        if (!submitter) return res.status(401).json({ message: "Unknown user" });

        // Resolve subject (self or manager-on-behalf), same as the paste route.
        const subject = await resolveRealConversationSubject(submitterId, submitter, subjectRepUserId);
        if (!subject.ok) return res.status(subject.status).json({ message: subject.message });

        // Paid-seat gate checks the TARGET rep's seat.
        const gate = await checkSeatAccess(subject.subjectRepUserId);
        if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

        const file = req.file;
        if (!file) {
          return res.status(400).json({ message: "Attach an audio file (mp3, m4a, or wav)." });
        }
        // Belt-and-suspenders: the type is already enforced in fileFilter.
        if (!isAllowedAudioFile(file.originalname)) {
          return res.status(400).json({ message: "Unsupported file type. Upload an mp3, m4a, or wav file." });
        }

        // Consent gate, identical to paste. Multipart fields arrive as strings.
        if (consentAccepted !== "true" && consentAccepted !== true) {
          return res.status(400).json({ message: REAL_CONVERSATION_CONSENT_TEXT });
        }

        // Monthly per-rep cap, checked before transcription so a blocked rep never
        // consumes a Whisper call and no row is created.
        const cap = await checkRealConversationCap(subject.subjectRepUserId);
        if (!cap.ok) return res.status(cap.status).json({ message: cap.message });

        // Transcribe with Whisper. A transcription failure never creates a row.
        let transcription: { text: string; duration?: number; segments?: { text: string }[] };
        try {
          transcription = await transcriber({
            buffer: file.buffer,
            filename: file.originalname,
            mimetype: file.mimetype,
          });
        } catch (err: any) {
          console.error("Whisper transcription failed:", err);
          return res.status(502).json({
            message:
              "We couldn't transcribe that audio. Please try again with a clear mp3, m4a, or wav recording.",
          });
        }

        // Best-effort ~30 min cap using Whisper's reported duration. The 25MB
        // size cap above is the strict, always-enforced limit.
        if (
          typeof transcription.duration === "number" &&
          transcription.duration > MAX_AUDIO_DURATION_SECONDS
        ) {
          return res.status(400).json({
            message: "Audio is longer than the 30 minute limit. Please upload a shorter recording.",
          });
        }

        const transcriptText = (transcription.text ?? "").trim();
        const parsed = parseAudioTranscript(transcriptText, transcription.segments);
        if (parsed.length === 0) {
          return res.status(400).json({ message: "That audio had no recognizable speech to score." });
        }

        // Same unchanged engine, same downstream handling as text/email.
        const { rubric, feedback, overall } = await scorer(parsed);
        const stalledStep = deriveStalledStep(rubric as any);

        const nowIso = new Date().toISOString();
        const created = await storage.createRealConversation({
          submittedByUserId: submitterId,
          subjectRepUserId: subject.subjectRepUserId,
          officeId: subject.officeId,
          submissionType: "audio",
          rawTranscript: transcriptText,
          originalAudioFilename: file.originalname,
          overallScore: overall,
          rubricScores: JSON.stringify(rubric),
          feedback,
          stalledStep,
          consentAccepted: true,
          consentAcceptedAt: nowIso,
          createdAt: nowIso,
          // Counted toward the cap at creation time and never recalculated.
          submissionCountedForCap: true,
          fieldVerifiedEligible: null,
        });

        res.json(created);
      } catch (err: any) {
        console.error("Real conversation audio scoring failed:", err);
        res.status(500).json({ message: err.message ?? "Failed to score the conversation" });
      }
    },
  );

  app.get("/api/real-conversations", async (req, res) => {
    const requesterId = Number(req.query.userId);
    if (!requesterId) return res.status(400).json({ message: "userId is required" });

    const requester = await storage.getUser(requesterId);
    if (!requester) return res.status(401).json({ message: "Unknown user" });

    // A rep sees every submission ABOUT them (subject rep == requester), including
    // ones a manager submitted on their behalf, and never anyone else's. Rows are
    // decorated with submitter attribution so the UI can label manager-submitted
    // entries.
    const rows = await storage.listRealConversationsBySubjectRep(requesterId);
    res.json(await decorateRealConversations(rows));
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
  industryCerts: import("@shared/schema").IndustryCertification[] = [],
  academyCredits: import("@shared/schema").AcademyCredit[] = [],
  // The rep's OWN real-conversation rows (subject rep == user), used only to
  // derive this month's usage meter. Defaults to [] so callers that don't care
  // about the meter (e.g. the public demo) get a zeroed meter without a query.
  realConversationRows: RealConversation[] = [],
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

  // Real-conversation usage this calendar month, out of the per-rep cap. Surfaced
  // in the roster so a manager sees "14 / 20" without opening the Field view.
  const realConversationCap = evaluateRealConversationCap({
    rows: realConversationRows,
    now: new Date(),
  });

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
    industries: consultantIndustryBreakdown(industryCerts),
    academyLevel: highestAcademyLevel(academyCredits),
    academyRankLabel: academyRankLabel(academyCredits),
    academyCreditCents: sumCreditCents(academyCredits),
    realConversationsThisMonth: realConversationCap.count,
    realConversationCap: realConversationCap.limit,
  };
}

// Group a consultant's per-industry certification rows by track into a compact
// {started, certified} breakdown for the manager roster.
function consultantIndustryBreakdown(
  industryCerts: import("@shared/schema").IndustryCertification[],
) {
  const byTrack = (track: Track) => {
    const rows = industryCerts.filter((c) => normalizeTrack(c.track) === track);
    return {
      started: rows
        .map((r) => ({ vertical: r.vertical, level: r.currentLevel, certified: r.currentLevel === "certified" }))
        .sort((a, b) => a.vertical.localeCompare(b.vertical)),
      certifiedCount: rows.filter((r) => r.currentLevel === "certified").length,
    };
  };
  return { consulting: byTrack("consulting"), leadership: byTrack("leadership") };
}

// The highest Academy level a consultant has earned (their rank), or 0 if none.
function highestAcademyLevel(academyCredits: import("@shared/schema").AcademyCredit[]): number {
  return academyCredits.reduce((max, c) => Math.max(max, c.level), 0);
}

// The display label for a consultant's Academy rank (highest earned level), or null.
function academyRankLabel(academyCredits: import("@shared/schema").AcademyCredit[]): string | null {
  const level = highestAcademyLevel(academyCredits);
  return level >= 1 ? LEVEL_LABELS[level as AcademyLevel] : null;
}

function sumCreditCents(academyCredits: import("@shared/schema").AcademyCredit[]): number {
  return academyCredits.reduce((sum, c) => sum + c.amountCents, 0);
}

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
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

    const consultantIds = officeUsers.filter((u) => u.role === "consultant").map((u) => u.id);
    const [officeIndustryCerts, officeCredits, officeRealConversations] = await Promise.all([
      storage.listIndustryCertificationsByUserIds(consultantIds),
      storage.listAcademyCreditsByOffice(officeId),
      storage.listRealConversationsByOffice(officeId),
    ]);

    const sessionsByUser = new Map<number, Session[]>();
    for (const s of officeSessions) {
      const list = sessionsByUser.get(s.userId) ?? [];
      list.push(s);
      sessionsByUser.set(s.userId, list);
    }
    const industryCertsByUser = groupBy(officeIndustryCerts, (c) => c.userId);
    const creditsByUser = groupBy(officeCredits, (c) => c.userId);
    // Grouped by the SUBJECT rep so the meter counts submissions ABOUT each rep.
    const realConversationsByRep = groupBy(officeRealConversations, (r) => r.subjectRepUserId);

    const consultants = officeUsers
      .filter((u) => u.role === "consultant")
      .map((u) =>
        buildConsultantSummary(
          u,
          sessionsByUser.get(u.id) ?? [],
          allScenarios,
          industryCertsByUser.get(u.id) ?? [],
          creditsByUser.get(u.id) ?? [],
          realConversationsByRep.get(u.id) ?? [],
        ),
      );

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

    const [userSessions, allScenarios, targetIndustryCerts, targetCredits, targetRealConversations] =
      await Promise.all([
        storage.listSessionsByUser(userId),
        storage.listScenarios(),
        storage.listIndustryCertificationsByUser(userId),
        storage.listAcademyCreditsByUser(userId),
        storage.listRealConversationsBySubjectRep(userId),
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
      consultant: buildConsultantSummary(
        target,
        userSessions,
        allScenarios,
        targetIndustryCerts,
        targetCredits,
        targetRealConversations,
      ),
      sessions,
    });
  });

  // Field view: a consultant's REAL conversation submissions (as opposed to the
  // practice sessions returned above), for the manager's Practice vs Field toggle.
  // Same office-scoped manager/QA authorization as the rest of the roster, and it
  // 404s for a user outside the office, so a manager can never read another
  // office's field data. Rows are decorated with submitter attribution so the UI
  // can flag manager-submitted entries.
  app.get("/api/offices/:officeId/consultants/:userId/real-conversations", async (req, res) => {
    const officeId = Number(req.params.officeId);
    const userId = Number(req.params.userId);
    const requesterId = Number(req.query.requesterId);
    const auth = await authorizeRosterRequest(requesterId, officeId);
    if (!auth.ok) return res.status(auth.status).json({ message: auth.message });

    const target = await storage.getUser(userId);
    if (!target || target.officeId !== officeId || target.role !== "consultant") {
      return res.status(404).json({ message: "Consultant not found in this office" });
    }

    const rows = await storage.listRealConversationsBySubjectRep(userId);
    res.json(await decorateRealConversations(rows));
  });
}

// ===========================================================================
// Manager command-center dashboard analytics. A single aggregate payload the
// redesigned manager dashboard renders from, computed entirely from REAL office
// data (users/sessions/scenarios). Every widget honestly reports zero/empty
// state when the office has no consultants or completed sessions yet.
//
// IMPORTANT (per-stage SOLVE scoring): the AI coach persists a five-DIMENSION
// discovery rubric per session (sessions.rubricScores JSON: needsDiscovery,
// objectionPrevention, trustBuilding, naturalClose, relationshipContinuity), NOT
// scores keyed to the SOLVE stage names (Situation/Open/Listen/Visualize/
// Engineer). `discoveryDimensions` below aggregates those REAL persisted rubric
// dimensions; it never fabricates stage-named scores.
// ===========================================================================

// The consulting discovery-rubric dimensions, in display order, with the short
// labels used on the radar. Mirrors RUBRIC_LABELS in results.tsx but trimmed for
// a compact axis tick. These are the only per-session sub-scores actually stored.
const DISCOVERY_DIMENSIONS: { key: string; label: string }[] = [
  { key: "needsDiscovery", label: "Needs discovery" },
  { key: "objectionPrevention", label: "Objection prevention" },
  { key: "trustBuilding", label: "Trust building" },
  { key: "naturalClose", label: "Natural close" },
  { key: "relationshipContinuity", label: "Relationship continuity" },
];

// One trailing week of practice counts as "this period" for the KPI strip.
const DASHBOARD_PERIOD_DAYS = 7;

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// The four real certification tiers, in progression order. A consultant's tier
// is their consulting level UNLESS they've earned consulting certification, in
// which case they sit at the top "Certified" tier (matches the roster CertPill,
// which keys off consultingCertified).
const TIER_ORDER = ["Beginner", "Intermediate", "Advanced", "Certified"] as const;

function consultantTier(user: User): string {
  if (user.consultingCertified) return "Certified";
  const lvl = capitalize(user.currentLevel);
  return (TIER_ORDER as readonly string[]).includes(lvl) ? lvl : "Beginner";
}

// ===========================================================================
// Practice streaks + peer rankings (gamified layer). Both are DERIVED from the
// same real session/score data the roster and manager dashboard already read,
// so they can never disagree with those views. Gated behind the paid Manager
// Dashboard add-on (office.managerItemId) at the route layer.
// ===========================================================================

// A session counts toward a streak day only if it INDIVIDUALLY scored at or
// above this bar. This is deliberately its OWN threshold, separate from the
// 85-point certification-advancement bar (ADVANCE_THRESHOLD): a "keep showing
// up" streak is easier to sustain than certification progress on purpose.
export const STREAK_QUALIFYING_SCORE = 70;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Current practice streak: the number of consecutive calendar days (server/UTC
// day) ending today on which the consultant completed at least one session
// scored >= STREAK_QUALIFYING_SCORE. Multiple qualifying sessions on one day
// count once. Today gets a grace window: if there is no qualifying session yet
// today but there was one yesterday, the streak is still alive (the current day
// has not fully "passed"). A calendar day that passes with no qualifying
// session resets the streak to 0.
export function computeStreak(
  sessions: Pick<Session, "status" | "score" | "completedAt" | "createdAt">[],
  now: Date = new Date(),
): number {
  const qualifyingDays = new Set<string>();
  for (const s of sessions) {
    if (s.status !== "completed" || s.score === null || (s.score as number) < STREAK_QUALIFYING_SCORE) continue;
    const when = s.completedAt ?? s.createdAt;
    if (!when) continue;
    qualifyingDays.add(when.slice(0, 10));
  }
  if (qualifyingDays.size === 0) return 0;

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let cursor = today;
  if (!qualifyingDays.has(utcDayKey(cursor))) {
    // Grace: the current day may simply not be done yet, so fall back to
    // yesterday. If neither today nor yesterday qualifies, a full day has
    // passed with no practice and the streak has reset.
    cursor = new Date(cursor.getTime() - ONE_DAY_MS);
    if (!qualifyingDays.has(utcDayKey(cursor))) return 0;
  }

  let streak = 0;
  while (qualifyingDays.has(utcDayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - ONE_DAY_MS);
  }
  return streak;
}

function groupSessionsByUser(sessions: Session[]): Map<number, Session[]> {
  const byUser = new Map<number, Session[]>();
  for (const s of sessions) {
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }
  return byUser;
}

// Peer ranking metric (documented once, used by BOTH the consultant mini
// dashboard and the manager Streaks & Rankings block so they always agree):
// consultants are ranked by their AVERAGE score across completed, scored
// sessions, highest first. A consultant with no scored sessions has a null
// average and sorts to the bottom, but is still assigned a rank so "#12 of 12"
// stays meaningful.
export function rankConsultantsByAverageScore(
  consultants: User[],
  sessionsByUser: Map<number, Session[]>,
): { id: number; averageScore: number | null }[] {
  return consultants
    .map((u) => {
      const scored = (sessionsByUser.get(u.id) ?? []).filter(
        (s) => s.status === "completed" && s.score !== null,
      );
      const averageScore = scored.length
        ? scored.reduce((sum, s) => sum + (s.score as number), 0) / scored.length
        : null;
      return { id: u.id, averageScore };
    })
    .sort((a, b) => (b.averageScore ?? -1) - (a.averageScore ?? -1));
}

// Pure builder for the consultant mini-dashboard payload, split out from the
// route so it can be unit-tested with in-memory fixtures. Assumes entitlement
// has already been checked by the caller (the route gates on managerItemId).
export function buildConsultantDashboard(
  user: User,
  officeUsers: User[],
  officeSessions: Session[],
  allScenarios: Scenario[],
  now: Date = new Date(),
) {
  const consultants = officeUsers.filter((u) => u.role === "consultant");
  const sessionsByUser = groupSessionsByUser(officeSessions);
  const mySessions = sessionsByUser.get(user.id) ?? [];

  const ranking = rankConsultantsByAverageScore(consultants, sessionsByUser);
  const position = ranking.findIndex((r) => r.id === user.id);

  // Progress toward the next certification level on the consulting track. Reuses
  // the exact advancement logic (scoresForTrackAtLevel/countQualifyingSessions)
  // so this never disagrees with the scenarios-page banner. Read-only: it never
  // triggers or alters advancement.
  const level = user.currentLevel;
  const scoresAtLevel = scoresForTrackAtLevel("consulting", level, mySessions, allScenarios);
  const qualifyingSessions = Math.min(countQualifyingSessions(scoresAtLevel), REQUIRED_QUALIFYING_SESSIONS);
  const levelIdx = (LEVEL_ORDER as readonly string[]).indexOf(level);
  const nextLevel = levelIdx >= 0 && levelIdx < LEVEL_ORDER.length - 1 ? LEVEL_ORDER[levelIdx + 1] : null;

  return {
    entitled: true as const,
    streak: {
      current: computeStreak(mySessions, now),
      qualifyingScore: STREAK_QUALIFYING_SCORE,
    },
    rank: {
      // 1-based position among office consultants; null if this user is not a
      // consultant (e.g. a manager viewing their own stats).
      position: position === -1 ? null : position + 1,
      outOf: consultants.length,
      metric: "averageScore" as const,
    },
    certification: {
      level,
      nextLevel,
      certified: user.consultingCertified,
      qualifyingSessions,
      requiredSessions: REQUIRED_QUALIFYING_SESSIONS,
    },
  };
}

// Manager Streaks & Rankings block: one row per consultant with their current
// practice streak and peer rank, sorted by rank (best first). Same ranking
// metric as the consultant view (see rankConsultantsByAverageScore).
export function buildStreaksAndRankings(
  consultants: User[],
  sessionsByUser: Map<number, Session[]>,
  now: Date,
) {
  const ranking = rankConsultantsByAverageScore(consultants, sessionsByUser);
  const rankById = new Map(ranking.map((r, i) => [r.id, i + 1]));
  return consultants
    .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      streak: computeStreak(sessionsByUser.get(u.id) ?? [], now),
      rank: rankById.get(u.id) ?? null,
      outOf: consultants.length,
    }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}

// Pure aggregation of the manager dashboard payload, split out from the route so
// it can be unit-tested with in-memory fixtures. `now` is injectable so the
// "this period" window is deterministic in tests.
export function buildDashboardStats(
  officeUsers: User[],
  officeSessions: Session[],
  allScenarios: Scenario[],
  now: Date = new Date(),
  academyCredits: import("@shared/schema").AcademyCredit[] = [],
) {
  const scenarioById = new Map(allScenarios.map((s) => [s.id, s]));
  const consultants = officeUsers.filter((u) => u.role === "consultant");

  const completed = officeSessions.filter((s) => s.status === "completed");
  const scored = completed.filter((s) => s.score !== null);

  const teamAverageScore = scored.length
    ? Math.round(scored.reduce((sum, s) => sum + (s.score as number), 0) / scored.length)
    : null;

  const periodSince = new Date(now.getTime() - DASHBOARD_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const practiceSessionsThisPeriod = completed.filter(
    (s) => s.completedAt && new Date(s.completedAt) >= periodSince,
  ).length;

  const certificationsEarned = consultants.filter((u) => u.consultingCertified).length;
  const activeConsultants = consultants.filter((u) => u.seatActive).length;

  // Team average score by calendar day (UTC) of completion. Only scored sessions
  // contribute; days with no scored session simply don't appear.
  const byDay = new Map<string, { total: number; count: number }>();
  for (const s of scored) {
    const day = (s.completedAt ?? s.createdAt).slice(0, 10);
    const bucket = byDay.get(day) ?? { total: 0, count: 0 };
    bucket.total += s.score as number;
    bucket.count += 1;
    byDay.set(day, bucket);
  }
  const scoreOverTime = Array.from(byDay.entries())
    .map(([date, { total, count }]) => ({
      date,
      averageScore: Math.round(total / count),
      sessions: count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Per-dimension discovery-rubric averages across completed CONSULTING sessions
  // whose stored rubric parses to the consulting shape. Null when there are none,
  // so the client shows an honest empty state instead of a flat zero radar.
  const dimTotals = new Map<string, { total: number; count: number }>();
  for (const s of completed) {
    const scenario = scenarioById.get(s.scenarioId);
    if (scenarioTrack(scenario?.track) !== "consulting") continue;
    if (!s.rubricScores) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(s.rubricScores);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.needsDiscovery !== "number") continue;
    for (const { key } of DISCOVERY_DIMENSIONS) {
      const value = parsed[key];
      if (typeof value !== "number") continue;
      const bucket = dimTotals.get(key) ?? { total: 0, count: 0 };
      bucket.total += value;
      bucket.count += 1;
      dimTotals.set(key, bucket);
    }
  }
  const discoveryDimensions = dimTotals.size
    ? DISCOVERY_DIMENSIONS.map(({ key, label }) => {
        const bucket = dimTotals.get(key);
        return {
          key,
          label,
          average: bucket ? Math.round(bucket.total / bucket.count) : 0,
        };
      })
    : null;

  // Leaderboard: every consultant with their average over scored sessions,
  // ranked best-first. Consultants with no scored sessions (averageScore null)
  // sort to the bottom so the client can show them with an honest empty score.
  const sessionsByUser = new Map<number, Session[]>();
  for (const s of officeSessions) {
    const list = sessionsByUser.get(s.userId) ?? [];
    list.push(s);
    sessionsByUser.set(s.userId, list);
  }
  const leaderboard = consultants
    .map((u) => {
      const userScored = (sessionsByUser.get(u.id) ?? []).filter(
        (s) => s.status === "completed" && s.score !== null,
      );
      const averageScore = userScored.length
        ? Math.round(userScored.reduce((sum, s) => sum + (s.score as number), 0) / userScored.length)
        : null;
      return {
        id: u.id,
        displayName: u.displayName,
        averageScore,
        sessionsCompleted: userScored.length,
        tier: consultantTier(u),
      };
    })
    .sort((a, b) => (b.averageScore ?? -1) - (a.averageScore ?? -1));

  const levelDistribution = TIER_ORDER.map((tier) => ({
    tier,
    count: consultants.filter((u) => consultantTier(u) === tier).length,
  }));

  // Streaks & rankings: each consultant's current practice streak and peer rank.
  // Only reachable once the route has confirmed the office holds the paid
  // Manager Dashboard add-on, so no additional gating is needed here.
  const streaksAndRankings = buildStreaksAndRankings(consultants, sessionsByUser, now);

  const vertTotals = new Map<string, number>();
  for (const s of completed) {
    const scenario = scenarioById.get(s.scenarioId);
    const vertical = scenario?.vertical ?? "unknown";
    vertTotals.set(vertical, (vertTotals.get(vertical) ?? 0) + 1);
  }
  const verticalBreakdown = Array.from(vertTotals.entries())
    .map(([vertical, count]) => ({ vertical, count }))
    .sort((a, b) => b.count - a.count);

  return {
    period: { label: "This week", days: DASHBOARD_PERIOD_DAYS, since: periodSince.toISOString() },
    kpis: {
      teamAverageScore,
      practiceSessionsThisPeriod,
      certificationsEarned,
      activeConsultants,
      consultantCount: consultants.length,
    },
    scoreOverTime,
    discoveryDimensions,
    leaderboard,
    levelDistribution,
    verticalBreakdown,
    streaksAndRankings,
    totals: {
      completed: completed.length,
      inProgress: officeSessions.length - completed.length,
    },
    // SOLVE Success Investment credits earned by this office (sum of all earned
    // credit rows). "available" is simply the total earned: there is no
    // spend-down ledger, so earned == available.
    academyCredits: {
      totalCents: academyCredits.reduce((sum, c) => sum + c.amountCents, 0),
      availableCents: academyCredits.reduce((sum, c) => sum + c.amountCents, 0),
      display: formatCents(academyCredits.reduce((sum, c) => sum + c.amountCents, 0)),
    },
  };
}

export function registerManagerDashboardRoutes(app: Express): void {
  // Office-scoped aggregate analytics for the manager command center. Reuses the
  // same manager/QA + own-office authorization as the roster routes.
  app.get("/api/manager/dashboard-stats", async (req, res) => {
    const requesterId = Number(req.query.requesterId);
    if (!requesterId) {
      return res.status(400).json({ message: "requesterId is required" });
    }
    const requester = await storage.getUser(requesterId);
    if (!requester) return res.status(401).json({ message: "Unknown user" });
    if (requester.role !== "manager" && requester.role !== "qa") {
      return res.status(403).json({ message: "Only a manager or QA can view dashboard analytics" });
    }

    // The manager dashboard itself is the paid add-on: an office without the
    // Manager Dashboard line (office.managerItemId unset) is not entitled to it.
    // This route previously had NO such check (role-only); see PR notes.
    // Demo accounts bypass this gate, matching checkSeatAccess: the founder's
    // live sales-demo office is billing-active but never bought the add-on, and
    // must keep showing the full dashboard.
    const office = await storage.getOffice(requester.officeId);
    if (!requester.isDemoAccount && !office?.managerItemId) {
      return res.status(403).json({ message: "The Manager Dashboard add-on is not active for this office." });
    }

    const [officeUsers, officeSessions, allScenarios, officeCredits] = await Promise.all([
      storage.listUsersByOffice(requester.officeId),
      storage.listSessionsByOffice(requester.officeId),
      storage.listScenarios(),
      storage.listAcademyCreditsByOffice(requester.officeId),
    ]);

    res.json(buildDashboardStats(officeUsers, officeSessions, allScenarios, new Date(), officeCredits));
  });
}

export function registerConsultantDashboardRoutes(app: Express): void {
  // Consultant-facing gamified mini dashboard: current practice streak, peer
  // rank, and progress toward the next certification level. Gated behind the
  // paid Manager Dashboard add-on (office.managerItemId): when the office has
  // not paid, we return a clean { entitled: false } empty state and leak NO
  // streak/ranking data, so the client can omit the widget entirely.
  // Demo accounts bypass this gate, matching checkSeatAccess: the founder's
  // live sales-demo office is billing-active but never bought the add-on, and
  // must keep showing the widget.
  app.get("/api/consultant/dashboard", async (req, res) => {
    const requesterId = Number(req.query.requesterId);
    if (!requesterId) return res.status(400).json({ message: "requesterId is required" });
    const user = await storage.getUser(requesterId);
    if (!user) return res.status(401).json({ message: "Unknown user" });

    const office = await storage.getOffice(user.officeId);
    if (!user.isDemoAccount && !office?.managerItemId) {
      return res.json({ entitled: false });
    }

    const [officeUsers, officeSessions, allScenarios] = await Promise.all([
      storage.listUsersByOffice(user.officeId),
      storage.listSessionsByOffice(user.officeId),
      storage.listScenarios(),
    ]);

    res.json(buildConsultantDashboard(user, officeUsers, officeSessions, allScenarios));
  });
}

// ===========================================================================
// Public, UNAUTHENTICATED demo dashboard.
//
// Serves ONLY the seeded "Demo Office" (invite code DEMO2024) sample roster —
// the same fabricated dataset used for live sales demos (Sofia Castellano et
// al.), never a real customer's office. This route:
//   - reads NO session/cookie and uses NO auth middleware, and
//   - resolves a single fixed demo office by its known invite code, so there
//     is no code path from here into any real office's data, and
//   - is strictly read-only (returns data; exposes no mutation), and
//   - replaces the office invite code with the literal string "DEMO" so the
//     real seeded code (DEMO2024) never leaves the server.
// The whole per-consultant detail history is included so the client renders
// the entire dashboard (including the drill-down panel) from this one payload,
// never issuing a second, authenticated request.
// ===========================================================================
const PUBLIC_DEMO_OFFICE_INVITE_CODE = "DEMO2024";

export function registerPublicDemoDashboardRoute(app: Express): void {
  app.get("/api/public/demo-dashboard", async (_req, res) => {
    const office = await storage.getOfficeByInviteCode(PUBLIC_DEMO_OFFICE_INVITE_CODE);
    if (!office) {
      return res.status(503).json({ message: "Demo dashboard is temporarily unavailable." });
    }

    const [officeUsers, officeSessions, allScenarios] = await Promise.all([
      storage.listUsersByOffice(office.id),
      storage.listSessionsByOffice(office.id),
      storage.listScenarios(),
    ]);

    const sessionsByUser = new Map<number, Session[]>();
    for (const s of officeSessions) {
      const list = sessionsByUser.get(s.userId) ?? [];
      list.push(s);
      sessionsByUser.set(s.userId, list);
    }
    const scenarioById = new Map(allScenarios.map((s) => [s.id, s]));

    const consultantUsers = officeUsers.filter((u) => u.role === "consultant");
    const consultants = consultantUsers.map((u) =>
      buildConsultantSummary(u, sessionsByUser.get(u.id) ?? [], allScenarios),
    );

    // Per-consultant session history keyed by consultant id, mirroring the
    // authenticated detail route's shape so the client's read-only drill-down
    // panel needs no second call.
    const details: Record<number, unknown> = {};
    for (const u of consultantUsers) {
      const userSessions = sessionsByUser.get(u.id) ?? [];
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
      details[u.id] = {
        consultant: buildConsultantSummary(u, userSessions, allScenarios),
        sessions,
      };
    }

    // Office-wide stat cards, mirroring the authenticated manager dashboard.
    const completedSessions = officeSessions.filter((s) => s.status === "completed");
    const scored = completedSessions.filter((s) => s.score !== null);
    const avgScore = scored.length
      ? Math.round(scored.reduce((sum, s) => sum + (s.score as number), 0) / scored.length)
      : null;

    res.json({
      office: {
        name: office.name,
        // Literal override for the public route — the real seeded invite code
        // (DEMO2024) is intentionally never sent to the client.
        inviteCode: "DEMO",
        subscriptionStatus: office.subscriptionStatus,
      },
      stats: {
        completed: completedSessions.length,
        avgScore,
        inProgress: officeSessions.length - completedSessions.length,
      },
      consultants,
      details,
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
  // Free-path offices awaiting admin activation can register/log in but not practice.
  // Checked before the Stripe gate so pending offices show the activation message.
  if (office.status === "pending") {
    return { ok: false, status: 403, message: "Your office activates as soon as payment is complete. Once it is, you can start practicing right away." };
  }
  if (!officeIsActive(office)) {
    return { ok: false, status: 402, message: "Your office subscription is inactive. Billing must be brought current to continue practicing." };
  }
  if (!user.seatActive) {
    return { ok: false, status: 402, message: "You don't have an active training seat yet." };
  }
  return { ok: true };
}

// Monthly fair-use practice cap for a consultant seat. Sums the user's ended
// sessions for the current calendar month and reports whether they're in the
// warn band or fully blocked. Demo/founder accounts (isDemoAccount) bypass the
// cap, matching the permanently-free convention used by checkSeatAccess. Callers
// use this at every new-session start point; the seat gate is checked separately.
async function checkPracticeCap(userId: number): Promise<PracticeCapStatus> {
  const user = await storage.getUser(userId);
  const sessions = await storage.listSessionsByUser(userId);
  return evaluatePracticeCap({
    sessions,
    now: new Date(),
    isDemoAccount: user?.isDemoAccount ?? false,
  });
}


// On-disk cache path for a message's synthesized audio. Keyed by message id so
// the stream endpoint can reuse a previously rendered file (replay) instead of
// re-synthesizing.
function audioPathForMsg(msgId: string): string {
  return path.join(AUDIO_DIR, `${msgId}.mp3`);
}

type MsgAudioStatus = "ready" | "failed";

async function updateSessionMsgAudioStatus(sessionId: number, msgId: string, status: MsgAudioStatus): Promise<void> {
  const latest = await storage.getSession(sessionId);
  if (!latest) return;
  const transcript: TranscriptMessage[] = JSON.parse(latest.transcript);
  const idx = transcript.findIndex((m) => m.msgId === msgId);
  if (idx === -1) return;
  transcript[idx] = { ...transcript[idx], audioStatus: status };
  await storage.updateSession(sessionId, { transcript: JSON.stringify(transcript) });
}

async function updateDemoMsgAudioStatus(sessionId: number, msgId: string, status: MsgAudioStatus): Promise<void> {
  const latest = await storage.getDemoSession(sessionId);
  if (!latest) return;
  const transcript: TranscriptMessage[] = JSON.parse(latest.transcript);
  const idx = transcript.findIndex((m) => m.msgId === msgId);
  if (idx === -1) return;
  transcript[idx] = { ...transcript[idx], audioStatus: status };
  await storage.updateDemoSession(sessionId, { transcript: JSON.stringify(transcript) });
}

interface StreamMessageAudioOptions {
  msgId: string;
  text: string;
  voice: string;
  instructions?: string;
  setStatus: (status: MsgAudioStatus) => Promise<void>;
}

// Stream a reply's TTS audio to the client while teeing it to disk. If the file
// already exists (a replay or a duplicate request) it is served directly. When
// synthesis finishes the persisted file is written and the message is marked
// "ready"; on failure the message is marked "failed" so the client loop moves on.
async function streamMessageAudio(res: Response, opts: StreamMessageAudioOptions): Promise<void> {
  const filePath = audioPathForMsg(opts.msgId);
  res.setHeader("Content-Type", "audio/mpeg");

  if (fsSync.existsSync(filePath)) {
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(filePath);
    return;
  }

  try {
    const stream = await synthesizeSpeechStream(opts.text, opts.voice, opts.instructions);
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      res.write(buf);
    }
    res.end();
    await fs.writeFile(filePath, Buffer.concat(chunks));
    await opts.setStatus("ready");
  } catch (err) {
    console.error("Streaming TTS failed:", err);
    await opts.setStatus("failed").catch(() => {});
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  }
}

// On-disk cache path for one sentence's synthesized audio within a streamed
// reply. Keyed by message id + sentence index so the SSE endpoint can write and
// the existing /api/audio/:filename route can serve each sentence clip.
function sentenceAudioPath(msgId: string, index: number): string {
  return path.join(AUDIO_DIR, `${msgId}-${index}.mp3`);
}

// Recomputes the within-level difficulty escalation tier for a session. Pulled
// out of the message route so the streaming turn endpoint derives the identical
// tier (it is deterministic from already-completed sessions, so it stays stable
// across a session's turns and keeps the customer-reply prompt prefix cacheable).
// Defaults to base (tier 0) if the lookup fails, so it can never break a turn.
async function computeSessionEscalationTier(session: Session, scenario: Scenario): Promise<number> {
  try {
    const track = scenarioTrack(scenario.track);
    const [allSessions, allScenarios] = await Promise.all([
      storage.listSessionsByUser(session.userId),
      storage.listScenarios(),
    ]);
    const scoresAtLevel = scoresForTrackAtLevel(track, scenario.difficulty, allSessions, allScenarios);
    return computeEscalationTier(countQualifyingSessions(scoresAtLevel));
  } catch {
    return 0;
  }
}

// Fills in a previously-created placeholder customer message with its final text
// and audio status once the streamed reply has finished. Keeps replay working:
// the persisted content is what /audio-stream re-synthesizes for later playback.
async function updateSessionMsgContentAndStatus(
  sessionId: number,
  msgId: string,
  content: string,
  status: MsgAudioStatus,
): Promise<void> {
  const latest = await storage.getSession(sessionId);
  if (!latest) return;
  const transcript: TranscriptMessage[] = JSON.parse(latest.transcript);
  const idx = transcript.findIndex((m) => m.msgId === msgId);
  if (idx === -1) return;
  transcript[idx] = { ...transcript[idx], content, audioStatus: status };
  await storage.updateSession(sessionId, { transcript: JSON.stringify(transcript) });
}

interface RunTurnStreamOptions {
  msgId: string;
  session: Session;
  scenario: Scenario;
  voice: string;
  instructions?: string;
  persist: (content: string, status: MsgAudioStatus) => Promise<void>;
}

// Drives one streamed customer turn over Server-Sent Events. Streams the reply
// text, and for each completed sentence starts TTS immediately (overlapping
// continued generation) while emitting `sentence` events strictly in order so
// the client can queue them gaplessly. Emits a final `done` (or `error`) event
// and persists the full reply text + audio status when finished.
async function runTurnStream(res: Response, opts: RunTurnStreamOptions): Promise<void> {
  const { msgId, session, scenario, voice, instructions, persist } = opts;

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

  const transcript: TranscriptMessage[] = JSON.parse(session.transcript);
  // The LLM should see the history through the consultant's latest turn, not the
  // empty placeholder we are about to fill.
  const history = transcript.filter((m) => m.msgId !== msgId);

  const escalationTier = await computeSessionEscalationTier(session, scenario);
  const variantSection = sessionVariantSection(scenario, session);

  let anyAudio = false;
  // Serializes SSE emission in sentence order even though each sentence's TTS
  // runs concurrently with generation and with the other sentences.
  let emitChain: Promise<void> = Promise.resolve();

  const handleSentence = (sentence: string, index: number) => {
    const ttsPromise = synthesizeSpeech(sentence, voice, instructions)
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
        audioUrl: ok ? `/api/audio/${msgId}-${index}.mp3` : null,
      });
    });
  };

  let fullText = "";
  try {
    fullText = await streamCustomerReply(
      personaCoreFor(scenario),
      history,
      scenario.difficulty,
      escalationTier,
      variantSection,
      handleSentence,
    );
    await emitChain;
    await persist(fullText, anyAudio ? "ready" : "failed");
    sse("done", { msgId, text: fullText });
  } catch (err) {
    console.error("Turn stream failed:", err);
    await emitChain.catch(() => {});
    // Persist whatever text was generated so the transcript is never left blank.
    await persist(fullText, "failed").catch(() => {});
    sse("error", { message: "reply_failed" });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
