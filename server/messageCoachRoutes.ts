import type { Express } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { isStripeConfigured } from "./stripe";
import { normalizeEmail } from "./demo";
import {
  MESSAGE_COACH_PRICE_CENTS,
  scoreOutreachMessage,
  createMessageCoachCheckout,
  findPurchaseForCheckoutSession,
  type MessageCoachResponder,
} from "./messageCoach";

// HTTP surface for Message Coach v1. Kept in its own file, registered from
// server/routes.ts with a single registerMessageCoachRoutes(app) call, rather
// than inlined into that file's route list. Same arrangement as
// server/demoV2Routes.ts.
//
// EVERY route here 404s unless MESSAGE_COACH_ENABLED === "true". The flag is
// read per request, not captured at import time, so a test can flip it and so
// nothing about the deployed build depends on when the module loaded. Default
// off: any value other than the exact string "true", including unset, keeps the
// whole feature dark.

export function messageCoachEnabled(): boolean {
  return process.env.MESSAGE_COACH_ENABLED === "true";
}

// The seat gate, injected rather than imported, because the real one
// (checkSeatAccess) lives in server/routes.ts and importing it here would make
// the two modules circular. routes.ts passes its own function in, so there is
// exactly one implementation of "does this user hold an active paid seat" in the
// codebase and this feature does not get a second, drifting copy.
export type SeatGate = (
  userId: number,
) => Promise<{ ok: true } | { ok: false; status: number; message: string }>;

const INDUSTRIES = ["Auto", "Real Estate", "Mortgage", "Home Services", "Other"] as const;

// The message is capped so a pasted novel cannot run up an unbounded model bill.
// 4000 characters is far longer than any real cold text, email or DM.
const MAX_MESSAGE_CHARS = 4000;

const scoreBodySchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(200).optional(),
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  industry: z.enum(INDUSTRIES).optional(),
  // Returned by Stripe in the success redirect. The client never sends a
  // database id: a Checkout Session id cannot be enumerated, and resolving it
  // server side is what ties a purchase to the signup that actually bought it.
  paidCheckoutSessionId: z.string().trim().min(1).max(200).optional(),
  // Present when a logged-in member uses the tool. Same convention as the other
  // routes in this codebase, which take the acting user's id in the body.
  userId: z.coerce.number().int().positive().optional(),
});

const checkoutBodySchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().max(120).optional(),
});

// Shown when the free score is spent and no credit is available. 402 is the
// status the client keys its paywall state on.
const PAYMENT_REQUIRED = {
  message: "You have used your free score. Additional scores are $4.99 each.",
  priceCents: MESSAGE_COACH_PRICE_CENTS,
} as const;

export function registerMessageCoachRoutes(
  app: Express,
  opts: { responder?: MessageCoachResponder; seatGate?: SeatGate } = {},
): void {
  const responder = opts.responder;
  const seatGate = opts.seatGate;
  const scoreDeps = responder ? { responder } : {};

  // Lets the page render its "not available" state, and lets the client show the
  // right price without hardcoding it.
  app.get("/api/message-coach/config", (_req, res) => {
    if (!messageCoachEnabled()) return res.status(404).json({ message: "Not found" });
    res.json({ enabled: true, priceCents: MESSAGE_COACH_PRICE_CENTS, industries: INDUSTRIES });
  });

  app.post("/api/message-coach/score", async (req, res) => {
    if (!messageCoachEnabled()) return res.status(404).json({ message: "Not found" });

    const parsed = scoreBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "A message is required." });
    }
    const { message, userId, paidCheckoutSessionId } = parsed.data;
    const industry = parsed.data.industry ?? null;

    // --- Member path: an active paid seat skips the free/paid gating entirely.
    // Checked before any email handling, because a member has already been
    // captured as a user and must not be asked for their email again.
    if (userId !== undefined && seatGate) {
      const access = await seatGate(userId);
      if (access.ok) {
        const user = await storage.getUser(userId);
        let result;
        try {
          result = await scoreOutreachMessage(message, industry, scoreDeps);
        } catch (err: any) {
          console.error("Message Coach scoring failed:", err);
          return res.status(502).json({ message: "We could not score that message. Please try again." });
        }
        await storage.createMessageCoachScore({
          signupId: null,
          officeId: user?.officeId ?? null,
          industry,
          messageText: message,
          score: result.score,
          stalledStep: result.stalledStep,
          coaching: result.coaching,
          rewrite: result.rewrite,
          source: "member",
          createdAt: new Date().toISOString(),
        });
        return res.json({ ...result, source: "member" });
      }
      // Not an active seat. Fall through to the public free/paid path, which
      // needs an email like any other anonymous visitor.
    }

    if (!parsed.data.email) {
      return res.status(400).json({ message: "An email address is required." });
    }
    const email = normalizeEmail(parsed.data.email);
    const name = parsed.data.name ?? null;

    let signup = await storage.getMessageCoachSignupByEmail(email);
    if (!signup) {
      signup = await storage.createMessageCoachSignup({
        email,
        name,
        createdAt: new Date().toISOString(),
        freeScoreUsedAt: null,
      });
    }

    // --- Paid path: the visitor is quoting a completed Checkout Session.
    if (paidCheckoutSessionId) {
      const purchase = await findPurchaseForCheckoutSession(paidCheckoutSessionId);
      if (!purchase || purchase.signupId !== signup.id) {
        return res.status(404).json({ message: "We could not find that purchase." });
      }
      if (purchase.status === "pending") {
        // The webhook has not landed yet. Not an error, and not a reason to give
        // the score away: the client retries.
        return res.status(409).json({ message: "Your payment is still confirming. Give it a moment." });
      }
      if (purchase.status !== "paid") {
        return res.status(409).json({ message: "That purchase has already been used." });
      }

      // Claim FIRST, in one conditional update, so two requests quoting the same
      // purchase cannot both be scored. Only then call the model.
      const claimed = await storage.claimMessageCoachPaidPurchase(purchase.id);
      if (!claimed) {
        return res.status(409).json({ message: "That purchase has already been used." });
      }

      let result;
      try {
        result = await scoreOutreachMessage(message, industry, scoreDeps);
      } catch (err: any) {
        // The buyer paid. A model failure must not silently eat their credit, so
        // the claim is released and they can retry with the same purchase.
        await storage.updateMessageCoachPaidPurchase(purchase.id, {
          status: "paid",
          consumedAt: null,
        });
        console.error("Message Coach scoring failed:", err);
        return res.status(502).json({ message: "We could not score that message. Please try again." });
      }

      const score = await storage.createMessageCoachScore({
        signupId: signup.id,
        officeId: null,
        industry,
        messageText: message,
        score: result.score,
        stalledStep: result.stalledStep,
        coaching: result.coaching,
        rewrite: result.rewrite,
        source: "paid",
        createdAt: new Date().toISOString(),
      });
      await storage.updateMessageCoachPaidPurchase(purchase.id, { consumedByScoreId: score.id });
      return res.json({ ...result, source: "paid" });
    }

    // --- Free path: one score per email, ever. The IS NULL check lives inside
    // the update, so the free score is spent before the model is called and two
    // simultaneous requests cannot both win it.
    const claimedFree = await storage.claimFreeMessageCoachScore(
      signup.id,
      new Date().toISOString(),
    );
    if (!claimedFree) {
      // Free score already spent and no purchase quoted. Return without calling
      // the model: a request that is going to be refused must never cost an API
      // call.
      return res.status(402).json(PAYMENT_REQUIRED);
    }

    let result;
    try {
      result = await scoreOutreachMessage(message, industry, scoreDeps);
    } catch (err: any) {
      // Give the free score back rather than burning it on our own failure.
      await storage.updateMessageCoachSignup(signup.id, { freeScoreUsedAt: null });
      console.error("Message Coach scoring failed:", err);
      return res.status(502).json({ message: "We could not score that message. Please try again." });
    }

    await storage.createMessageCoachScore({
      signupId: signup.id,
      officeId: null,
      industry,
      messageText: message,
      score: result.score,
      stalledStep: result.stalledStep,
      coaching: result.coaching,
      rewrite: result.rewrite,
      source: "free",
      createdAt: new Date().toISOString(),
    });
    return res.json({ ...result, source: "free" });
  });

  // Creates the $4.99 Checkout Session and returns the URL to redirect to. Same
  // isStripeConfigured() boundary as the demo purchase route.
  app.post("/api/message-coach/checkout", async (req, res) => {
    if (!messageCoachEnabled()) return res.status(404).json({ message: "Not found" });
    if (!isStripeConfigured()) return res.status(503).json({ message: "Billing is not configured" });

    const parsed = checkoutBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "A valid email address is required." });
    }
    const email = normalizeEmail(parsed.data.email);

    let signup = await storage.getMessageCoachSignupByEmail(email);
    if (!signup) {
      signup = await storage.createMessageCoachSignup({
        email,
        name: parsed.data.name ?? null,
        createdAt: new Date().toISOString(),
        freeScoreUsedAt: null,
      });
    }

    try {
      const url = await createMessageCoachCheckout({ signupId: signup.id, email });
      res.json({ url });
    } catch (err: any) {
      console.error("Message Coach checkout creation failed:", err);
      res.status(500).json({ message: "We couldn't open checkout. Please try again." });
    }
  });
}
