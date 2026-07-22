import { createHmac, timingSafeEqual } from "node:crypto";
import { APP_URL } from "./stripe";

// ---------------------------------------------------------------------------
// One-click unsubscribe for the NEW lifecycle emails (demo-activation drip +
// monthly "Practice makes money" email). None existed in the codebase before, so
// this is the minimal, self-contained mechanism they all share. It intentionally
// does NOT touch the existing inbound/outbound drips.
//
// A signed, non-expiring token encodes the recipient's normalized email so the
// public GET /api/unsubscribe route can add them to email_suppressions without a
// login. The signing mirrors the demo access token in server/demo.ts (b64url
// payload + "." + HMAC-SHA256 signature) rather than inventing a new scheme.
// Kept pure (no DB/HTTP) so it can be unit-tested directly.
// ---------------------------------------------------------------------------

function unsubscribeSecret(): string {
  // Reuse the demo session secret when a dedicated one is not set, so the token
  // is signed with a real secret in every environment the demo already runs in.
  return (
    process.env.UNSUBSCRIBE_SECRET ||
    process.env.DEMO_SESSION_SECRET ||
    "solve-unsubscribe-dev-secret-change-me"
  );
}

// Match the demo token's email normalization so a token minted for "A@B.com "
// verifies to the same "a@b.com" the suppression list is keyed on.
export function normalizeUnsubEmail(email: string): string {
  return email.trim().toLowerCase();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

type UnsubscribePayload = { email: string };

// A stable, non-expiring token for a recipient's email. Unsubscribe links must
// keep working indefinitely, so unlike the demo token there is no `exp`.
export function signUnsubscribeToken(email: string): string {
  const payload: UnsubscribePayload = { email: normalizeUnsubEmail(email) };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", unsubscribeSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

// Returns the normalized email if the token is well-formed and the signature
// matches, else null. Constant-time signature compare, like the demo token.
export function verifyUnsubscribeToken(token: string | undefined): string | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", unsubscribeSecret()).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as UnsubscribePayload;
    if (typeof payload.email !== "string" || !payload.email) return null;
    return payload.email;
  } catch {
    return null;
  }
}

// The absolute unsubscribe URL for a recipient. APP_URL is the deployed app
// origin in production (falls back to localhost in dev).
export function unsubscribeUrl(email: string): string {
  return `${APP_URL}/api/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(email))}`;
}

// The plain-text footer appended to every new lifecycle email. `reason` explains
// why they received it. The bare URL is linkified by inboundBodyToHtml at render
// time, so no HTML is needed here. Two leading blank lines separate it from the
// body. No em-dashes, "practice" not "training" (brand voice).
export function unsubscribeFooter(email: string, reason: string): string {
  return `\n\n${reason} If you would rather not receive these, you can opt out here: ${unsubscribeUrl(email)}`;
}

// The confirmation page shown after a successful (or already-processed)
// unsubscribe. Plain, on-brand (navy heading, orange accent), framework-free.
export function unsubscribeConfirmationHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed - SOLVE Framework</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#0A1A30;">
  <div style="max-width:520px;margin:64px auto;padding:32px;background:#ffffff;border-radius:8px;border-top:4px solid #E06D00;">
    <h1 style="margin:0 0 12px;font-size:22px;color:#0A1A30;">You are unsubscribed</h1>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">You will no longer receive demo or monthly practice emails from the SOLVE Framework.</p>
    <p style="margin:0;font-size:15px;line-height:1.5;">Changed your mind? Just reply to any earlier email and we will add you back.</p>
  </div>
</body>
</html>`;
}

// The page shown when the token is missing or invalid. Still returns a friendly
// message rather than an error dump.
export function unsubscribeInvalidHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe link problem - SOLVE Framework</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#0A1A30;">
  <div style="max-width:520px;margin:64px auto;padding:32px;background:#ffffff;border-radius:8px;border-top:4px solid #0A1A30;">
    <h1 style="margin:0 0 12px;font-size:22px;color:#0A1A30;">This link is not valid</h1>
    <p style="margin:0;font-size:15px;line-height:1.5;">We could not read that unsubscribe link. Please reply to any email from us and we will opt you out manually.</p>
  </div>
</body>
</html>`;
}
