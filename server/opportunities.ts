import type { IStorage } from "./storage";
import type { ProspectOutreach } from "@shared/schema";
import { sendProspectEmail } from "./notifications";

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
// directly instead of booting this.
export function startOutreachScheduler(storage: DripDeps["storage"]): void {
  if (schedulerHandle) return;
  schedulerHandle = setInterval(() => {
    sendDueOutreach({ storage, send: sendProspectEmail }).catch((err) => {
      console.error("[opportunities] drip sender tick failed:", err);
    });
  }, DRIP_INTERVAL_MS);
  // Don't keep the event loop alive solely for the drip timer.
  if (typeof schedulerHandle.unref === "function") schedulerHandle.unref();
}
