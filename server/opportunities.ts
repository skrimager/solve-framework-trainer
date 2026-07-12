import type { IStorage } from "./storage";
import type { Contact, ProspectOutreach } from "@shared/schema";
import { sendProspectEmail, sendInboundEmail } from "./notifications";

// ===========================================================================
// Opportunity Intelligence: outbound discovery-training drip logic.
//
// Copy rules (enforced by tests): user-facing prospect copy uses "discovery
// training" / "discovery architecture" language — never "sales" or
// "AI roleplay". No internal cost/profit figures ever appear in an email.
// ===========================================================================

// Step offsets from batch-approval time. Step 1 goes out immediately; the two
// follow-ups are spaced 3 and 7 days out.
export const SEQUENCE_STEP_OFFSET_DAYS: Record<number, number> = { 1: 0, 2: 3, 3: 7 };
export const SEQUENCE_STEPS = [1, 2, 3] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// Free demo lives on the public marketing site; CTA every email points here.
const DEMO_URL = "https://www.solveframework.com/demo";

// The ISO scheduledAt for a given sequence step, relative to `nowMs`.
export function scheduledAtForStep(step: number, nowMs: number): string {
  const offset = SEQUENCE_STEP_OFFSET_DAYS[step] ?? 0;
  return new Date(nowMs + offset * DAY_MS).toISOString();
}

// Map a free-text segment (as stored on a search/company) onto a canonical drip
// angle. Unknown segments fall back to a general discovery-training angle, so a
// brand-new market never breaks batch creation.
export function normalizeSegment(segment: string): string {
  const s = (segment ?? "").toLowerCase();
  if (s.includes("manufactured") || s.includes("housing") || s.includes("mobile home")) return "manufactured_housing";
  if (s.includes("hvac") || s.includes("plumb") || s.includes("home service") || s.includes("home_service") || s.includes("home improvement")) return "home_services";
  if (s.includes("auto") || s.includes("car ") || s.includes("dealer")) return "auto_dealership";
  if (s.includes("mortgage") || s.includes("lend") || s.includes("loan") || s.includes("bank")) return "mortgage_lending";
  if (s.includes("rental") || s.includes("equipment")) return "equipment_rental";
  if (s.includes("conflict") || s.includes("customer service") || s.includes("grievance")) return "conflict_service";
  return "general";
}

// The distinct opening angle per segment. This is the ONLY segment-specific
// paragraph; the rest of every email carries the four required mentions.
const SEGMENT_ANGLE: Record<string, string> = {
  manufactured_housing:
    "In manufactured-housing communities, the difference between a full lot and an empty one usually comes down to how consistently your resident-facing team handles the first conversation — and how calmly they defuse the tense ones. Staff turnover makes that consistency hard to hold.",
  home_services:
    "In HVAC and home services, the tech who slows down to diagnose what's actually frustrating the homeowner — not just the unit — is the one who earns the repeat call and the referral. Most training only drills the repair, not that conversation.",
  auto_dealership:
    "The pressure-close still lingers on a lot of showroom floors, and it quietly kills referrals. Buyers who feel discovered rather than pushed come back, and they send their family. The hard part is retraining that instinct across a whole team.",
  mortgage_lending:
    "Loan officers and bankers are guiding people through one of the biggest financial decisions of their lives. When that conversation is built on discovery instead of pressure, borrowers trust the recommendation — and refer the next one.",
  equipment_rental:
    "In B2B equipment rental, the rep who uncovers the job behind the request rents the right machine, avoids the returns, and becomes the first call next season. That's a discovery skill, and it's learnable.",
  conflict_service:
    "For service businesses that live and die on reviews, the moment an upset customer or a frustrated employee escalates is the moment that matters most. De-escalation and root-cause discovery can be trained the same way any other skill is.",
  general:
    "The teams that win the second conversation are the ones that uncover the real need in the first one. Discovery is a trainable skill — most organizations just never get to practice it under realistic pressure.",
};

// A short subject per step, kept discovery-framed (never "sales").
const STEP_SUBJECT: Record<number, (company: string) => string> = {
  1: (company) => `A discovery-training idea for ${company}`,
  2: (company) => `Following up: building discovery skill at ${company}`,
  3: (company) => `Last note — a free discovery demo for ${company}`,
};

export interface SequenceContext {
  contactName: string;
  companyName: string;
}

export interface DraftedEmail {
  step: number;
  emailSubject: string;
  emailBody: string;
}

// Build the full three-step discovery-training drip for one contact. Every step
// mentions: live role-play scenarios, scoring/tracking, the path to
// certification, and the free-demo CTA — per the feature spec.
export function buildSequence(segment: string, ctx: SequenceContext): DraftedEmail[] {
  const canonical = normalizeSegment(segment);
  const angle = SEGMENT_ANGLE[canonical] ?? SEGMENT_ANGLE.general;
  const firstName = ctx.contactName.trim().split(/\s+/)[0] || "there";

  const capabilities =
    "SOLVE is a discovery-training platform: your people practice live role-play scenarios with realistic customers, every session is scored and tracked so managers can see skill grow week over week, and reps work along a clear path to certification.";
  const cta = `You can try a live role-play yourself, free, in about five minutes: ${DEMO_URL}.`;

  const bodies: Record<number, string> = {
    1: `Hi ${firstName},

${angle}

${capabilities}

${cta}

Open to a quick look?

— The SOLVE Framework team`,
    2: `Hi ${firstName},

Circling back in case my first note got buried. ${angle}

The reason teams stick with SOLVE is the feedback loop: live role-play scenarios, scored and tracked per rep, all building toward certification — so improvement is something you can actually measure, not just hope for.

${cta}

Happy to share how other ${canonical.replace(/_/g, " ")} teams have used it.

— The SOLVE Framework team`,
    3: `Hi ${firstName},

I'll keep this short. If building consistent discovery skill is on your radar, the easiest next step is to feel it firsthand.

SOLVE gives your team live role-play scenarios, scoring and progress tracking, and a path to certification — and you can experience a scored session yourself for free, no commitment: ${DEMO_URL}.

If the timing isn't right, no worries at all — just reply and I'll close the loop.

— The SOLVE Framework team`,
  };

  return SEQUENCE_STEPS.map((step) => ({
    step,
    emailSubject: STEP_SUBJECT[step](ctx.companyName),
    emailBody: bodies[step],
  }));
}

// Render a plain-text email body as minimal, safe HTML for Resend.
export function outreachBodyToHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;white-space:pre-wrap;">${escaped.replace(/\n/g, "<br>")}</div>`;
}

// Pure planning of an approval: given a batch's draft outreach rows and the
// approval time, return the per-row status/scheduledAt patches. Step-1 rows send
// now; step-2/3 are offset. Only `draft` rows are scheduled — anything already
// sent/stopped is left untouched. Extracted so the offset math is unit-testable.
export function planApproval(
  outreach: Pick<ProspectOutreach, "id" | "sequenceStep" | "status">[],
  nowMs: number,
): { id: number; status: "scheduled"; scheduledAt: string }[] {
  return outreach
    .filter((o) => o.status === "draft")
    .map((o) => ({
      id: o.id,
      status: "scheduled" as const,
      scheduledAt: scheduledAtForStep(o.sequenceStep, nowMs),
    }));
}

// Send every scheduled outreach whose scheduledAt has passed. Idempotent: a row
// is only ever fetched while `scheduled`, and is flipped to `sent` only on a
// real 2xx — so an already-sent row is never resent, and a failed send stays
// scheduled for the next tick. Returns counts for logging/tests.
export interface DripDeps {
  storage: Pick<
    IStorage,
    "listDueProspectOutreach" | "getProspectContact" | "updateProspectOutreach" | "createProspectActivity"
  >;
  send: typeof sendProspectEmail;
  now?: () => Date;
}

export async function sendDueOutreach(deps: DripDeps): Promise<{ sent: number; failed: number }> {
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const due = await deps.storage.listDueProspectOutreach(nowIso);
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const contact = await deps.storage.getProspectContact(row.contactId);
    if (!contact) {
      failed += 1;
      continue;
    }
    const ok = await deps.send(contact.email, row.emailSubject, outreachBodyToHtml(row.emailBody));
    if (!ok) {
      failed += 1;
      continue; // stays `scheduled`; retried next tick
    }
    await deps.storage.updateProspectOutreach(row.id, { status: "sent", sentAt: nowIso });
    await deps.storage.createProspectActivity({
      contactId: row.contactId,
      eventType: "sent",
      eventDetail: `Step ${row.sequenceStep} sent: ${row.emailSubject}`,
      occurredAt: nowIso,
    });
    sent += 1;
  }
  return { sent, failed };
}

// How often the scheduled sender wakes up. Spec allows 15–30 min; 20 keeps it
// responsive without hammering Resend.
export const DRIP_INTERVAL_MS = 20 * 60 * 1000;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

// Start the background drip sender. Guarded so repeated calls (or a hot reload)
// never stack multiple intervals. No-op'd in tests, which drive sendDueOutreach
// directly instead of booting this. The SAME timer also flushes the inbound-lead
// welcome drip (day 3/7) so both sequences share one scheduler, not two.
export function startOutreachScheduler(storage: SchedulerStorage): void {
  if (schedulerHandle) return;
  schedulerHandle = setInterval(() => {
    sendDueOutreach({ storage, send: sendProspectEmail }).catch((err) => {
      console.error("[opportunities] drip sender tick failed:", err);
    });
    sendDueLeadDripEmails({ storage, send: sendInboundEmail }).catch((err) => {
      console.error("[opportunities] inbound lead drip sender tick failed:", err);
    });
  }, DRIP_INTERVAL_MS);
  // Don't keep the event loop alive solely for the drip timer.
  if (typeof schedulerHandle.unref === "function") schedulerHandle.unref();
}

// ===========================================================================
// Inbound-lead welcome drip.
//
// Every NEW contact captured via POST /api/leads is auto-enrolled into a
// three-step day 0/3/7 sequence. Step 1 (day 0) is the welcome email, dispatched
// inline at capture and recorded here as already `sent`; steps 2 (day 3) and 3
// (day 7) are scheduled for the shared background sender above to deliver when
// due. This is entirely separate from the admin OUTBOUND prospecting batches:
// different table (lead_drip_emails vs prospect_outreach), different copy,
// different from-address. Pre-existing contacts are never backfilled.
//
// Copy note: the provided welcome/day-3/day-7 bodies are used verbatim. Any
// wording authored here follows the standing "practice"/"discovery" rules —
// never "train" as a verb for the user, never describing the product as "sales".
// ===========================================================================

// Reuse the same free-demo destination the outbound drip and site-wide CTAs
// point at, rather than guessing a new URL.
const INBOUND_DEMO_URL = DEMO_URL;

export const WELCOME_SUBJECT = "Welcome to the SOLVE Framework";
export const INBOUND_DAY3_SUBJECT = "How did your first practice session go?";
export const INBOUND_DAY7_SUBJECT = "The real difference between a script and discovery architecture";

// First token of the contact's name, or empty string if unparseable.
export function inboundFirstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

// Salutation line: personalized when we have a first name, gracefully generic
// ("Hi there,") when the name is empty/unparseable.
function salutation(name: string | null | undefined): string {
  const first = inboundFirstName(name);
  return first ? `Hi ${first},` : "Hi there,";
}

export function buildWelcomeEmailBody(name: string | null | undefined): string {
  return `${salutation(name)}

This is Wade.

First, thank you for giving the SOLVE Framework a chance.

Whether you're in sales, leadership, consulting, customer service, healthcare, real estate, financial services, or another profession entirely, my goal is the same:

Help you become better at helping people make better decisions.

That's what the SOLVE Framework is all about.

This platform wasn't created to teach people how to pressure customers or memorize clever closing techniques. Those skills have their place, but I've learned over the last thirty years that the best professionals earn trust long before they ever ask someone to make a decision.

That's why I built this platform.

Your Free Practice Sessions

Your account includes three complimentary AI practice sessions so you can experience how the platform works.

Choose a scenario that interests you and have a real conversation with our AI coach. There are no tricks, no perfect scripts, and no "gotcha" questions. Simply approach the conversation the way you naturally would.

When you're finished, don't stop there.

Meet Your SOLVE Coach™

This is where the real learning begins.

After every practice session, your SOLVE Coach will review your conversation and provide personalized feedback based on the SOLVE Framework.

You'll discover:

• Which questions uncovered the customer's real motivations.
• Opportunities where you could have built greater trust.
• Discovery questions you may have missed.
• Moments where you spoke too soon—or could have listened longer.
• How to improve your next conversation.

The goal isn't to criticize you.

The goal is to help you improve one conversation at a time.

Because that's how real professionals grow.

Remember…

Customers don't usually object because they're difficult.

They object because they don't yet have enough confidence to make a decision.

The better you become at understanding people, the less you'll need to overcome objections later.

That's the philosophy behind everything you'll find inside the SOLVE Platform.

I genuinely appreciate you taking the time to explore it, and I hope it helps you become more confident, more prepared, and more effective in every conversation you have.

Welcome to the SOLVE Framework.

I'm glad you're here.

Wade Skrimager
Founder, SOLVE Framework™
Helping Professionals Help People Make Better Decisions.

P.S. Don't rush through your practice sessions. The value isn't in finishing quickly—it's in learning something that makes your next real conversation better.`;
}

export function buildInboundDay3Body(name: string | null | undefined): string {
  return `${salutation(name)}

A few days ago you signed up to try the SOLVE Framework — I wanted to check in personally.

If you haven't run a practice session yet, no pressure. Just know your three free sessions are sitting there whenever you're ready. Pick any scenario that feels close to a real conversation you have often, and just talk to it the way you naturally would. That's it.

If you have already run one — did you read your SOLVE Coach feedback afterward? That's genuinely where most people tell me the real "aha" moment happens. The practice conversation teaches you something. The coaching afterward is what actually changes how you show up next time.

Either way, I'd love to hear how it's going.

Wade
Founder, SOLVE Framework™`;
}

export function buildInboundDay7Body(name: string | null | undefined): string {
  return `${salutation(name)}

It's been about a week since you first explored the SOLVE Framework, so I wanted to share one more thought before I let you get back to it.

Most training out there teaches people what to say. Ours teaches you how to think — how to build the right questions in the moment, based on what the other person actually needs, instead of running a script and hoping it fits.

That's the difference between memorizing lines and building real discovery architecture. One works until the conversation goes off-script. The other works every time, because it's built around the person in front of you, not a flowchart.

If you haven't finished your free practice sessions yet, they're still there. And if you're ready to see how this works for your whole team, I'd be glad to walk you through a live demo.

Book a Demo: ${INBOUND_DEMO_URL}

Wade
Founder, SOLVE Framework™`;
}

export interface InboundDripStep {
  step: number;
  emailSubject: string;
  emailBody: string;
}

// The full three-step inbound sequence for one contact, rendered with their name.
export function buildInboundDripSequence(name: string | null | undefined): InboundDripStep[] {
  return [
    { step: 1, emailSubject: WELCOME_SUBJECT, emailBody: buildWelcomeEmailBody(name) },
    { step: 2, emailSubject: INBOUND_DAY3_SUBJECT, emailBody: buildInboundDay3Body(name) },
    { step: 3, emailSubject: INBOUND_DAY7_SUBJECT, emailBody: buildInboundDay7Body(name) },
  ];
}

// Render a plain-text inbound body as minimal, safe HTML for Resend. Escapes
// HTML, turns bare http(s) URLs into anchors (so the day-7 "Book a Demo" link is
// clickable), and preserves paragraph/line breaks via white-space:pre-wrap.
export function inboundBodyToHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const linked = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;white-space:pre-wrap;">${linked.replace(/\n/g, "<br>")}</div>`;
}

const INBOUND_DRIP_STATUS_SCHEDULED = "scheduled" as const;
const INBOUND_DRIP_STATUS_SENT = "sent" as const;

export interface InboundEnrollDeps {
  storage: Pick<IStorage, "createLeadDripEmail">;
  send: typeof sendInboundEmail;
  now?: () => Date;
}

// Auto-enroll one NEW inbound contact into the welcome drip. Sends the day-0
// welcome inline (best-effort) and persists all three steps: step 1 recorded as
// `sent`, steps 2/3 `scheduled` for +3d/+7d so the background sender delivers
// them. Best-effort end to end — never throws, so it can be fired without
// awaiting from the /api/leads handler and can never block or fail lead capture.
export async function enrollInboundLead(
  deps: InboundEnrollDeps,
  contact: Pick<Contact, "id" | "name" | "email">,
): Promise<void> {
  try {
    const now = deps.now ? deps.now() : new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const sequence = buildInboundDripSequence(contact.name);

    for (const step of sequence) {
      if (step.step === 1) {
        // Day 0 welcome: dispatch immediately (best-effort), then record it as
        // sent regardless of transport outcome — it is not retried by the sender.
        await deps.send(
          contact.email,
          step.emailSubject,
          inboundBodyToHtml(step.emailBody),
          step.emailBody,
        );
        await deps.storage.createLeadDripEmail({
          contactId: contact.id,
          sequenceStep: step.step,
          emailSubject: step.emailSubject,
          emailBody: step.emailBody,
          scheduledAt: nowIso,
          sentAt: nowIso,
          status: INBOUND_DRIP_STATUS_SENT,
        });
      } else {
        await deps.storage.createLeadDripEmail({
          contactId: contact.id,
          sequenceStep: step.step,
          emailSubject: step.emailSubject,
          emailBody: step.emailBody,
          scheduledAt: scheduledAtForStep(step.step, nowMs),
          sentAt: null,
          status: INBOUND_DRIP_STATUS_SCHEDULED,
        });
      }
    }
  } catch (err) {
    console.warn(`[opportunities] Failed to enroll inbound lead ${contact.id} in welcome drip:`, err);
  }
}

export interface LeadDripSendDeps {
  storage: Pick<IStorage, "listDueLeadDripEmails" | "getContact" | "updateLeadDripEmail">;
  send: typeof sendInboundEmail;
  now?: () => Date;
}

// Send every scheduled inbound-drip step whose scheduledAt has passed. Idempotent
// like sendDueOutreach: a row is only fetched while `scheduled` and flipped to
// `sent` only on a real 2xx, so a failed send stays scheduled for the next tick
// and a sent row is never resent. Never throws. Returns counts for logging/tests.
export async function sendDueLeadDripEmails(deps: LeadDripSendDeps): Promise<{ sent: number; failed: number }> {
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const due = await deps.storage.listDueLeadDripEmails(nowIso);
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const contact = await deps.storage.getContact(row.contactId);
    if (!contact) {
      failed += 1;
      continue;
    }
    const ok = await deps.send(
      contact.email,
      row.emailSubject,
      inboundBodyToHtml(row.emailBody),
      row.emailBody,
    );
    if (!ok) {
      failed += 1;
      continue; // stays `scheduled`; retried next tick
    }
    await deps.storage.updateLeadDripEmail(row.id, { status: INBOUND_DRIP_STATUS_SENT, sentAt: nowIso });
    sent += 1;
  }
  return { sent, failed };
}

// The scheduler storage surface: outbound prospect drip + inbound lead drip.
export type SchedulerStorage = DripDeps["storage"] & LeadDripSendDeps["storage"];
