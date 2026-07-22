import type { IStorage } from "./storage";
import type { DemoSignup, DemoSession } from "@shared/schema";
import { sendInboundEmail } from "./notifications";
import { inboundBodyToHtml } from "./opportunities";
import { unsubscribeFooter, normalizeUnsubEmail } from "./unsubscribe";

// ===========================================================================
// Demo-activation drip.
//
// Auto-enrolled when a demo visitor verifies their code (demo_signups.verified
// flips true) via /api/demo/verify. Three steps, keyed to a demo_signups row
// (not a contact), so this never mixes with the inbound welcome drip or the
// admin OUTBOUND prospecting batches. Step 1 (day 0) is the welcome, dispatched
// inline at verify and recorded `sent`; steps 2 (day 1) and 3 (day 3) are
// scheduled for the shared background sender to deliver when due.
//
// Copy rules (enforced by tests): brand voice uses "practice", never
// "train"/"training"; no em-dashes; navy/orange only. Every email carries the
// one-click unsubscribe footer. This is strictly additive and does NOT touch
// the existing inbound/outbound drips.
// ===========================================================================

// Offsets from verify time, in days. Step 1 goes out immediately; the two
// follow-ups are day 1 and day 3.
export const DEMO_DRIP_STEP_OFFSET_DAYS: Record<number, number> = { 1: 0, 2: 1, 3: 3 };
export const DEMO_DRIP_STEPS = [1, 2, 3] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// The free demo and the convert-to-paid destination. Both live on the public
// marketing site; reuse them rather than inventing new URLs.
const DEMO_URL = "https://www.solveframework.com/demo";
const GET_STARTED_URL = "https://www.solveframework.com";

const DEMO_DRIP_STATUS_SCHEDULED = "scheduled" as const;
const DEMO_DRIP_STATUS_SENT = "sent" as const;
const DEMO_DRIP_STATUS_STOPPED = "stopped" as const;

export const DEMO_DAY0_SUBJECT = "Your SOLVE demo is ready. Start practicing.";
export const DEMO_DAY1_SUBJECT = "How did your first practice session go?";
export const DEMO_DAY3_SUBJECT = "A few things your demo does not show you yet";

// The ISO scheduledAt for a given step, relative to `nowMs`.
export function demoScheduledAtForStep(step: number, nowMs: number): string {
  const offset = DEMO_DRIP_STEP_OFFSET_DAYS[step] ?? 0;
  return new Date(nowMs + offset * DAY_MS).toISOString();
}

// Day 0 welcome: confirms the three free sessions and the SOLVE Coach scoring,
// and points them at the demo to start practicing.
export function buildDemoDay0Body(email: string): string {
  const body = `Welcome to the SOLVE Framework demo.

Your demo includes three free practice sessions. Pick a conversation that feels close to one you actually have, and just talk to it the way you naturally would. There are no scripts and no gotcha questions.

After each session, your SOLVE Coach reviews the conversation and scores it, then shows you which questions uncovered the real motivations, where you could have built more trust, and what to do differently next time.

Start practicing here: ${DEMO_URL}

The value is not in finishing quickly. It is in learning one thing that makes your next real conversation better.

The SOLVE Framework team`;
  return body + unsubscribeFooter(email, "You are getting this because you started a SOLVE Framework demo.");
}

// Day 1 follow-up. Personalized with the visitor's score and feedback when a
// completed demo session exists by send time; otherwise a gentle nudge to use
// the free sessions. `session` is the latest completed, scored demo session.
export function buildDemoDay1Body(email: string, session?: DemoSessionSummary | null): string {
  let core: string;
  if (session && typeof session.score === "number") {
    const feedbackLine = session.feedback
      ? `\n\nHere is what your SOLVE Coach highlighted:\n\n${session.feedback.trim()}`
      : "";
    core = `You ran your first SOLVE practice session, and your SOLVE Coach scored it ${session.score} out of 100.

That number is just a starting point. The real growth comes from running another session and watching what changes when you ask one more discovery question before you offer a solution.${feedbackLine}

You still have free sessions left. Try another one here: ${DEMO_URL}`;
  } else {
    core = `A day ago you unlocked your SOLVE Framework demo, and your three free practice sessions are still sitting there whenever you are ready.

If you have not run one yet, no pressure. Pick any conversation that feels close to a real one you have often, and just talk to it the way you naturally would. Your SOLVE Coach will score it and show you exactly where you can improve.

Start your first session here: ${DEMO_URL}`;
  }
  return core + unsubscribeFooter(email, "You are getting this because you started a SOLVE Framework demo.");
}

// Day 3 follow-up: convert-to-paid. References what the full product adds beyond
// the demo's three-session cap: the full scenario library, the manager
// dashboard, and the certification path.
export function buildDemoDay3Body(email: string): string {
  const body = `Your SOLVE demo gave you three practice sessions. A full account removes that cap and opens up what the demo does not show you yet.

With a full account you get:

- The complete scenario library, so you can practice the exact conversations your role runs into
- A manager dashboard, so a team can see skill grow week over week
- A clear path to certification, so progress is something you can measure and not just hope for

If building consistent discovery skill is on your radar, the easiest next step is to get started:

Get Started: ${GET_STARTED_URL}

If the timing is not right, no worries at all. Your practice sessions taught you something already, and that is the whole point.

The SOLVE Framework team`;
  return body + unsubscribeFooter(email, "You are getting this because you started a SOLVE Framework demo.");
}

export interface DemoSessionSummary {
  score: number | null;
  feedback: string | null;
}

export interface DemoDripStep {
  step: number;
  emailSubject: string;
  emailBody: string;
}

// The full three-step sequence for one signup. Step 2's body is built with no
// session context here; the sender re-personalizes it at send time from the
// visitor's latest completed session.
export function buildDemoDripSequence(email: string): DemoDripStep[] {
  return [
    { step: 1, emailSubject: DEMO_DAY0_SUBJECT, emailBody: buildDemoDay0Body(email) },
    { step: 2, emailSubject: DEMO_DAY1_SUBJECT, emailBody: buildDemoDay1Body(email, null) },
    { step: 3, emailSubject: DEMO_DAY3_SUBJECT, emailBody: buildDemoDay3Body(email) },
  ];
}

export interface DemoEnrollDeps {
  storage: Pick<IStorage, "createDemoDripEmail" | "getEmailSuppression">;
  send: typeof sendInboundEmail;
  now?: () => Date;
}

// Auto-enroll one NEWLY verified demo signup. Sends the day-0 welcome inline
// (best-effort), records step 1 as `sent`, and schedules steps 2 (+1d) and 3
// (+3d). If the email is already suppressed, nothing is sent and every step is
// recorded `stopped` so the row stays self-describing. Best-effort end to end:
// never throws, so it can be fired without awaiting from the verify handler.
export async function enrollDemoDrip(
  deps: DemoEnrollDeps,
  signup: Pick<DemoSignup, "id" | "email">,
): Promise<void> {
  try {
    const now = deps.now ? deps.now() : new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const suppressed = await deps.storage.getEmailSuppression(normalizeUnsubEmail(signup.email));
    const sequence = buildDemoDripSequence(signup.email);

    for (const step of sequence) {
      if (suppressed) {
        await deps.storage.createDemoDripEmail({
          signupId: signup.id,
          sequenceStep: step.step,
          emailSubject: step.emailSubject,
          emailBody: step.emailBody,
          scheduledAt: demoScheduledAtForStep(step.step, nowMs),
          sentAt: null,
          status: DEMO_DRIP_STATUS_STOPPED,
        });
        continue;
      }
      if (step.step === 1) {
        await deps.send(signup.email, step.emailSubject, inboundBodyToHtml(step.emailBody), step.emailBody);
        await deps.storage.createDemoDripEmail({
          signupId: signup.id,
          sequenceStep: step.step,
          emailSubject: step.emailSubject,
          emailBody: step.emailBody,
          scheduledAt: nowIso,
          sentAt: nowIso,
          status: DEMO_DRIP_STATUS_SENT,
        });
      } else {
        await deps.storage.createDemoDripEmail({
          signupId: signup.id,
          sequenceStep: step.step,
          emailSubject: step.emailSubject,
          emailBody: step.emailBody,
          scheduledAt: demoScheduledAtForStep(step.step, nowMs),
          sentAt: null,
          status: DEMO_DRIP_STATUS_SCHEDULED,
        });
      }
    }
  } catch (err) {
    console.warn(`[demoDrip] Failed to enroll demo signup ${signup.id} in activation drip:`, err);
  }
}

// The latest completed, scored session for a signup, or null. Used to
// personalize the day-1 email at send time.
function latestScoredSession(sessions: DemoSession[]): DemoSessionSummary | null {
  const scored = sessions.filter((s) => s.status === "completed" && typeof s.score === "number");
  if (scored.length === 0) return null;
  const latest = scored[scored.length - 1];
  return { score: latest.score, feedback: latest.feedback };
}

export interface DemoDripSendDeps {
  storage: Pick<
    IStorage,
    "listDueDemoDripEmails" | "getDemoSignup" | "listDemoSessionsBySignup" | "updateDemoDripEmail" | "getEmailSuppression"
  >;
  send: typeof sendInboundEmail;
  now?: () => Date;
}

// Send every scheduled demo-drip step whose scheduledAt has passed. Idempotent
// like the lead drip: a row is only fetched while `scheduled` and flipped to
// `sent` only on a real 2xx, so a failed send stays scheduled for the next tick.
// Suppressed recipients are marked `stopped` (not `sent`) and skipped. Step 2 is
// re-personalized here from the visitor's latest completed session. Never throws.
export async function sendDueDemoDripEmails(deps: DemoDripSendDeps): Promise<{ sent: number; failed: number; stopped: number }> {
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const due = await deps.storage.listDueDemoDripEmails(nowIso);
  let sent = 0;
  let failed = 0;
  let stopped = 0;

  for (const row of due) {
    const signup = await deps.storage.getDemoSignup(row.signupId);
    if (!signup) {
      failed += 1;
      continue;
    }
    const suppressed = await deps.storage.getEmailSuppression(normalizeUnsubEmail(signup.email));
    if (suppressed) {
      await deps.storage.updateDemoDripEmail(row.id, { status: DEMO_DRIP_STATUS_STOPPED });
      stopped += 1;
      continue;
    }

    let body = row.emailBody;
    if (row.sequenceStep === 2) {
      const sessions = await deps.storage.listDemoSessionsBySignup(row.signupId);
      body = buildDemoDay1Body(signup.email, latestScoredSession(sessions));
    }

    const ok = await deps.send(signup.email, row.emailSubject, inboundBodyToHtml(body), body);
    if (!ok) {
      failed += 1;
      continue; // stays `scheduled`; retried next tick
    }
    await deps.storage.updateDemoDripEmail(row.id, { status: DEMO_DRIP_STATUS_SENT, sentAt: nowIso, emailBody: body });
    sent += 1;
  }
  return { sent, failed, stopped };
}
