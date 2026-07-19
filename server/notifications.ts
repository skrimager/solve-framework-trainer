import type { Lead } from "@shared/schema";
import { buildVerificationEmail } from "./demo";
import { APP_URL } from "./stripe";

// Lead-notification emails via the Resend HTTP API. No SDK dependency: we POST
// directly to https://api.resend.com/emails with a plain fetch.
//
// The API key comes from process.env.RESEND_API_KEY (set on Render, never
// committed). Sending is best-effort — every failure path logs a warning and
// resolves without throwing, so a lead is never lost just because the email
// could not be sent.

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "SOLVE Framework <notifications@solveframework.com>";
const TO_ADDRESS = "hello@solveframework.com";
// Inbound-lead mail (welcome + day 3/7 drip) is a personal note "from Wade", so
// it goes out from the friendly hello@ mailbox rather than the notifications@
// system address. Same Resend account/API key/verified domain — no new sender
// identity or credentials.
const INBOUND_FROM_ADDRESS = "SOLVE Framework <hello@solveframework.com>";

// Human-friendly labels for known lead columns; anything else falls back to the
// raw key so newly-added fields still show up in the email.
const FIELD_LABELS: Record<string, string> = {
  id: "ID",
  name: "Name",
  email: "Email",
  phone: "Phone",
  company: "Company",
  message: "Message",
  source: "Source form",
  status: "Status",
  type: "Type",
  priority: "Priority",
  owner: "Owner",
  followUpDate: "Follow-up date",
  createdAt: "Timestamp",
};

// Test seam: inject a fake fetch so unit tests need no network or real key.
type FetchFn = typeof fetch;
let _fetch: FetchFn | null = null;

export function __setFetchForTests(fake: FetchFn | null): void {
  _fetch = fake;
}

function getFetch(): FetchFn {
  return _fetch ?? fetch;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

// Table-based, fully inline-styled CTA button for transactional emails. Email
// clients strip <style> blocks and mishandle <button>, so the button is an
// anchor styled inline inside a single-cell table for reliable rendering across
// Gmail, Outlook, and Apple Mail. Brand colors: orange fill with a navy border
// and white label. Lime is intentionally not used here (reserved for admin).
function renderEmailButton(label: string, url: string): string {
  const safeLabel = escapeHtml(label);
  const safeUrl = escapeHtml(url);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;border-collapse:separate;">` +
    `<tr><td style="border-radius:6px;background-color:#E06D00;">` +
    `<a href="${safeUrl}" target="_blank" rel="noopener" ` +
    `style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;` +
    `font-size:15px;font-weight:bold;line-height:1;color:#ffffff;text-decoration:none;` +
    `border:1px solid #0A1A30;border-radius:6px;">${safeLabel}</a>` +
    `</td></tr></table>`
  );
}

export function buildLeadEmail(lead: Lead): { subject: string; html: string } {
  const name = (lead.name ?? "").trim() || "Unknown";
  const source = (lead.source ?? "").trim() || "no source";
  const subject = `New Lead: ${name} (${source})`;

  // Include every field present on the lead so any future column is captured
  // automatically. Skip null/undefined/empty values to keep the email clean.
  const rows = Object.entries(lead)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => {
      const label = escapeHtml(labelFor(key));
      const rendered = escapeHtml(String(value)).replace(/\n/g, "<br>");
      return `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;vertical-align:top;">${label}</td><td style="padding:4px 0;">${rendered}</td></tr>`;
    })
    .join("");

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">
  <h2 style="margin:0 0 12px;">New lead submitted</h2>
  <table style="border-collapse:collapse;">${rows}</table>
</div>`;

  return { subject, html };
}

// Best-effort: sends the notification email and never throws. Callers can fire
// this without awaiting; any error (missing key, network, non-2xx) is logged.
export async function sendLeadNotification(lead: Lead): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[notifications] RESEND_API_KEY is not set; skipping lead notification email.",
    );
    return;
  }

  try {
    const { subject, html } = buildLeadEmail(lead);
    const res = await getFetch()(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [TO_ADDRESS],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        `[notifications] Resend returned ${res.status} for lead ${lead.id}: ${detail}`,
      );
    }
  } catch (err) {
    console.warn(
      `[notifications] Failed to send lead notification email for lead ${lead.id}:`,
      err,
    );
  }
}

// Sends one outbound prospect-outreach email through the SAME Resend transport
// (same RESEND_API_KEY, same from address) used for lead/demo mail — no new key.
// Returns whether the send succeeded so the drip sender only marks a row `sent`
// on a real 2xx. Never throws.
export async function sendProspectEmail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[notifications] RESEND_API_KEY is not set; skipping prospect outreach email.");
    return false;
  }
  try {
    const res = await getFetch()(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[notifications] Resend returned ${res.status} for prospect email to ${to}: ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[notifications] Failed to send prospect outreach email to ${to}:`, err);
    return false;
  }
}

// Sends one inbound-lead email (the day-0 welcome or a day-3/7 drip follow-up)
// through the SAME Resend transport as the founder/prospect mail — same
// RESEND_API_KEY, same verified domain — but from the friendly hello@ mailbox.
// Best-effort: returns whether the send succeeded (so the background drip sender
// only marks a step `sent` on a real 2xx) and never throws. `text` is the plain
// fallback shown by clients that don't render HTML.
export async function sendInboundEmail(
  to: string,
  subject: string,
  html: string,
  text?: string,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[notifications] RESEND_API_KEY is not set; skipping inbound lead email.");
    return false;
  }
  try {
    const body: Record<string, unknown> = { from: INBOUND_FROM_ADDRESS, to: [to], subject, html };
    if (text) body.text = text;
    const res = await getFetch()(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[notifications] Resend returned ${res.status} for inbound email to ${to}: ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[notifications] Failed to send inbound lead email to ${to}:`, err);
    return false;
  }
}

// --- Self-serve paid signup emails (items 5 and 7) --------------------------

export interface PaidOfficeDetails {
  officeName: string;
  inviteCode: string;
  seatCount: number;
  dashboard: boolean;
  stripeSubscriptionId?: string | null;
  contactEmail?: string | null;
}

// Buyer-facing access email sent right after a paid checkout provisions the office
// (item 5): invite code, how the team joins, the Command Center link, and a short
// first-week plan. Personal "from hello@" note, same friendly transport as the
// welcome drip. Plain-text is authored and rendered to matching HTML.
export function buildPaidWelcomeEmail(details: PaidOfficeDetails): { subject: string; html: string; text: string } {
  const commandCenterUrl = `${APP_URL}/#/manager-login`;
  const subject = `Your SOLVE Framework office is ready: ${details.officeName}`;
  // Sentinel marks where the primary call-to-action button is injected in the
  // HTML render. The plain-text version keeps a spelled-out link on its own line
  // so text-only clients still get a usable URL.
  const ctaMarker = "__CTA_BUTTON__";
  const lines = [
    `Welcome to SOLVE Framework, and thanks for setting up ${details.officeName}.`,
    "",
    `Your office is active. Here is everything you need to get your team practicing.`,
    "",
    `Team invite code: ${details.inviteCode}`,
    "",
    "How your consultants join:",
    `1. Send them the Command Center link: ${commandCenterUrl}`,
    `2. Have each consultant register and enter the invite code ${details.inviteCode}.`,
    "3. They will land in their practice dashboard, ready for their first discovery session.",
    "",
    "Your first week:",
    "Day 1: Log in to the Command Center and invite your consultants.",
    "Day 2: Have each consultant run their first practice discovery conversation.",
    "Day 3: Review scores together and pick one skill to focus on.",
    "Day 5: Run a second round and compare progress in the Command Center.",
    "",
    ctaMarker,
    "",
    "If you have any questions, just reply to this email.",
  ];
  const text = lines
    .map((line) => (line === ctaMarker ? `Open your Command Center: ${commandCenterUrl}` : line))
    .join("\n");

  const htmlBody = lines
    .map((line) => {
      if (line === "") return "<br>";
      if (line === ctaMarker) return renderEmailButton("Open your Command Center", commandCenterUrl);
      const escaped = escapeHtml(line).replace(
        /(https?:\/\/[^\s]+)/g,
        (url) => `<a href="${url}">${url}</a>`,
      );
      return `<p style="margin:0 0 8px;">${escaped}</p>`;
    })
    .join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">${htmlBody}</div>`;

  return { subject, html, text };
}

export async function sendPaidWelcomeEmail(to: string, details: PaidOfficeDetails): Promise<boolean> {
  const { subject, html, text } = buildPaidWelcomeEmail(details);
  return sendInboundEmail(to, subject, html, text);
}

// Admin notification of a completed paid checkout (item 7). Goes to the same
// hello@ recipient as lead notifications, via the notifications@ system address.
export async function sendPaidCheckoutAdminNotification(details: PaidOfficeDetails): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[notifications] RESEND_API_KEY is not set; skipping paid checkout admin notification.");
    return;
  }
  try {
    const rows: Array<[string, string]> = [
      ["Office", details.officeName],
      ["Consultant seats", String(details.seatCount)],
      ["Manager Dashboard", details.dashboard ? "Yes" : "No"],
      ["Stripe subscription", details.stripeSubscriptionId ?? "n/a"],
      ["Buyer email", details.contactEmail ?? "n/a"],
    ];
    const tableRows = rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;">${escapeHtml(label)}</td><td style="padding:4px 0;">${escapeHtml(value)}</td></tr>`,
      )
      .join("");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">
  <h2 style="margin:0 0 12px;">New paid office signup</h2>
  <table style="border-collapse:collapse;">${tableRows}</table>
</div>`;
    const res = await getFetch()(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [TO_ADDRESS],
        subject: `New paid office signup: ${details.officeName}`,
        html,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[notifications] Resend returned ${res.status} for paid signup notice: ${detail}`);
    }
  } catch (err) {
    console.warn("[notifications] Failed to send paid checkout admin notification:", err);
  }
}

// Sends a public demo's 6-digit verification code to the visitor's own email,
// reusing the exact same Resend transport as sendLeadNotification. Unlike the
// best-effort lead email, the code IS the demo's auth, so this returns whether
// the send succeeded — the caller surfaces a retry to the visitor on false.
export async function sendDemoVerificationCode(email: string, code: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[notifications] RESEND_API_KEY is not set; cannot send demo verification code.",
    );
    return false;
  }

  try {
    const { subject, html } = buildVerificationEmail(code);
    const res = await getFetch()(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[notifications] Resend returned ${res.status} for demo code to ${email}: ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[notifications] Failed to send demo verification code to ${email}:`, err);
    return false;
  }
}
