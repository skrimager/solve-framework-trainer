import type { OfficeSignup } from "@shared/schema";
import { planForSeatCount, isEnterpriseSeatCount } from "@shared/pricing";

// ---------------------------------------------------------------------------
// Self-serve manager/office signup logic. Kept pure (no DB/HTTP) so it can be
// unit-tested directly, mirroring server/demo.ts. The email-verification
// primitives themselves (6-digit code generation, expiry, constant-time
// validation, email normalization) are REUSED from server/demo.ts rather than
// duplicated. This file only adds the signup-specific pieces on top: a resend
// cooldown, the office-setup input validation, and the transactional email
// bodies for the verification code and consultant enrollment.
// ---------------------------------------------------------------------------

// Minimum seconds between verification-code sends for one signup, so a resend
// button cannot be hammered into an email flood. The legitimate "I didn't get
// it" resend after ~30s is unaffected.
export const SIGNUP_RESEND_COOLDOWN_MS = 30 * 1000;

// True if a fresh code may be sent now given the last send time. A missing
// lastSentAt (never sent) always allows a send. Unparseable timestamps are
// treated as "long ago" so a bad value never permanently blocks the buyer.
export function canResendSignupCode(
  signup: Pick<OfficeSignup, "lastSentAt">,
  now = Date.now(),
): boolean {
  if (!signup.lastSentAt) return true;
  const last = Date.parse(signup.lastSentAt);
  if (Number.isNaN(last)) return true;
  return now - last >= SIGNUP_RESEND_COOLDOWN_MS;
}

// Validate the office-setup inputs the verified buyer submits before payment
// (step 3/4). Returns a typed error message string on failure, or null when the
// inputs are valid. Seat count must map to a real self-serve tier; 36+ is
// Enterprise and routed to a custom quote (never self-serve checkout).
export function validateOfficeSetupInput(input: {
  company: string;
  managerName: string;
  username: string;
  password: string;
  seatCount: number;
}): string | null {
  if (!input.company.trim()) return "Company name is required.";
  if (!input.managerName.trim()) return "Your name is required.";
  if (!input.username.trim()) return "A username is required.";
  if (input.password.length < 6) return "Please choose a password of at least 6 characters.";
  if (!Number.isInteger(input.seatCount) || input.seatCount < 1) {
    return "Choose at least one consultant seat.";
  }
  if (isEnterpriseSeatCount(input.seatCount)) {
    return "36 or more consultants is Enterprise. Contact us for a custom quote.";
  }
  if (!planForSeatCount(input.seatCount)) {
    return "That seat count is not available for self-serve checkout.";
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Verification-code email for the manager signup (step 2). Mirrors the demo
// code email but speaks to a business buyer setting up an office rather than an
// anonymous demo visitor. Copy stays in the knowledgeable-partner tone with no
// hype or false urgency.
export function buildSignupVerificationEmail(code: string): { subject: string; html: string } {
  const subject = `Your SOLVE Framework verification code: ${code}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;">
  <h2 style="margin:0 0 12px;color:#0A1A30;">Confirm your email to set up your office</h2>
  <p style="margin:0 0 16px;">Enter this code to verify your email and continue setting up your SOLVE Framework office:</p>
  <p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:0 0 16px;color:#0A1A30;">${escapeHtml(code)}</p>
  <p style="margin:0;color:#555;">This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>
</div>`;
  return { subject, html };
}

// Consultant enrollment email (step 6). Sent to each consultant the manager
// enrolls by email. Gives them the office invite code and a link to activate
// their own account. The manager can also just hand out the code directly (the
// existing self-join path is unchanged); this email is the additional, guided
// path into that same invite-code system. `activateUrl` deep-links the register
// page with the code prefilled.
export interface ConsultantEnrollmentDetails {
  officeName: string;
  inviteCode: string;
  activateUrl: string;
}

export function buildConsultantEnrollmentEmail(
  details: ConsultantEnrollmentDetails,
): { subject: string; html: string; text: string } {
  const subject = `You've been enrolled in the SOLVE Academy`;
  const lines = [
    `You've been enrolled in the SOLVE Academy by your team at ${details.officeName}.`,
    "",
    "SOLVE Academy is where your team practices discovery conversations and sharpens the discovery architecture behind every great client relationship.",
    "",
    "To activate your account:",
    `1. Open the activation page: ${details.activateUrl}`,
    `2. Enter your office invite code: ${details.inviteCode}`,
    "3. Choose a username, add your name (or a screen name), and you're in. A profile photo is optional and can be added anytime.",
    "",
    "Once you activate, you'll land in your practice dashboard, ready for your first discovery session.",
    "",
    "If you have any questions, just reply to this email.",
  ];
  const text = lines.join("\n");
  const htmlBody = lines
    .map((line) => {
      if (line === "") return "<br>";
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
