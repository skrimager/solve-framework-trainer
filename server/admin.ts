import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import type { Office } from "@shared/schema";
import {
  officeIsActive,
  planForSeatCount,
  isEnterpriseSeatCount,
} from "./billing";

// --- Admin session config ---------------------------------------------------
// The admin account is a true top-level account: its session lives in a
// distinctly named cookie so it can never be confused with (or leak into) the
// office-scoped manager/consultant flow, which uses no server cookie at all.
export const ADMIN_SESSION_COOKIE = "solve_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function sessionSecret(): string {
  return process.env.ADMIN_SESSION_SECRET || "solve-admin-dev-secret-change-me";
}

// --- Password hashing --------------------------------------------------------
// scrypt via Node's built-in crypto (no new auth dependency). Format is
// "salt:derivedKey" in hex. verifyPassword is constant-time.
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const keyBuf = Buffer.from(key, "hex");
  const derived = scryptSync(password, salt, keyBuf.length);
  return keyBuf.length === derived.length && timingSafeEqual(keyBuf, derived);
}

// --- Signed session token ----------------------------------------------------
// A self-contained HMAC-signed token: base64url(payload) + "." + hmac. No server
// store needed (single admin, internal tool). Tampering or expiry -> invalid.
type SessionPayload = { adminId: number; username: string; exp: number };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signAdminSession(adminId: number, username: string, now = Date.now()): string {
  const payload: SessionPayload = { adminId, username, exp: now + SESSION_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyAdminSession(token: string | undefined, now = Date.now()): SessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- CSV export --------------------------------------------------------------
// Minimal RFC-4180-ish CSV. Values are quoted when they contain a comma, quote,
// or newline; embedded quotes are doubled. null/undefined become empty strings.
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<T extends Record<string, unknown>>(
  columns: { key: keyof T; header: string }[],
  rows: T[],
): string {
  const head = columns.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(",")).join("\n");
  return body ? `${head}\n${body}` : head;
}

// --- Sales aggregation -------------------------------------------------------
// Per-office subscription/revenue rows derived from the billing fields already
// stored per office (populated by the Stripe webhook sync). MRR uses the Pricing
// v2 flat-per-tier model (see billing.ts): every seat in an office bills at the
// single flat rate of the tier its total seat count lands in — NOT graduated math.
// The optional Manager Dashboard fee is counted only when the add-on is active,
// at the office's current tier rate. Enterprise (36+) offices are custom quotes
// and are tracked separately, not folded into the standard MRR formula.

// Seat MRR for an office of `seatCount` seats under flat-per-tier pricing:
//   1 seat = $49, 5 = $245, 6 = $270, 20 = $900, 21 = $861, 35 = $1,435.
// NOTE: because this is flat-per-tier (not graduated), a larger seat count can
// cost LESS than a smaller one across a tier boundary — e.g. 21 seats ($861) is
// cheaper than 20 seats ($900). This is the founder-confirmed intended behavior,
// not a bug to "fix" here. Enterprise (36+) has no self-serve rate → returns 0.
export function calculateSeatMRR(seatCount: number): number {
  if (seatCount <= 0) return 0;
  const plan = planForSeatCount(seatCount);
  if (!plan) return 0; // Enterprise (36+): custom quote, tracked separately
  return seatCount * plan.seatRate;
}

// Dashboard MRR: only offices with the add-on actually active (a dashboard line
// exists on the subscription) contribute, at their CURRENT tier's dashboard rate.
export function dashboardMRR(office: Office): number {
  if (!office.managerItemId) return 0; // add-on not active → $0 dashboard
  const plan = planForSeatCount(office.activeSeatCount ?? 0);
  if (!plan) return 0; // Enterprise handled separately
  return plan.dashboardRate;
}

export type SalesRow = {
  officeId: number;
  officeName: string;
  subscriptionStatus: string;
  status: string; // provisioning status: 'active' | 'pending'
  active: boolean;
  seatCount: number;
  seatsMrr: number;
  managerMrr: number;
  mrr: number;
  isEnterprise: boolean;
  hasStripeCustomer: boolean;
  archivedAt: string | null;
};

export function computeSalesRow(office: Office): SalesRow {
  const active = officeIsActive(office);
  const seatCount = office.activeSeatCount ?? 0;
  const isEnterprise = isEnterpriseSeatCount(seatCount);
  // Enterprise offices are custom quotes — excluded from the standard MRR formula.
  const seats = active && !isEnterprise ? calculateSeatMRR(seatCount) : 0;
  const managerMrr = active && !isEnterprise ? dashboardMRR(office) : 0;
  const mrr = Math.round((seats + managerMrr) * 100) / 100;
  return {
    officeId: office.id,
    officeName: office.name,
    subscriptionStatus: office.subscriptionStatus,
    status: office.status,
    active,
    seatCount,
    seatsMrr: seats,
    managerMrr,
    mrr,
    isEnterprise,
    hasStripeCustomer: Boolean(office.stripeCustomerId),
    archivedAt: office.archivedAt ?? null,
  };
}

export function summarizeSales(
  offices: Office[],
): { rows: SalesRow[]; totalMrr: number; activeOffices: number; enterpriseOffices: number } {
  const rows = offices.map(computeSalesRow);
  const totalMrr = Math.round(rows.reduce((sum, r) => sum + r.mrr, 0) * 100) / 100;
  const activeOffices = rows.filter((r) => r.active).length;
  const enterpriseOffices = rows.filter((r) => r.isEnterprise).length;
  return { rows, totalMrr, activeOffices, enterpriseOffices };
}

// --- In-memory per-IP rate limiter ------------------------------------------
// Fixed-window limiter for the public endpoints (leads, track-visit). Not a
// distributed limiter — just basic abuse protection for a single instance.
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private limit: number, private windowMs: number) {}

  check(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  // Drop expired windows so the map doesn't grow unbounded on a long-lived process.
  sweep(now = Date.now()): void {
    for (const key of Array.from(this.hits.keys())) {
      const entry = this.hits.get(key);
      if (entry && entry.resetAt <= now) this.hits.delete(key);
    }
  }
}
