import type { Lead } from "@shared/schema";
import { buildVerificationEmail } from "./demo";

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
