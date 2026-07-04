import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import type { Office } from "@shared/schema";
import { officeIsActive } from "./billing";

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
// stored per office (populated by the Stripe webhook sync). MRR is a directional
// estimate from the seat count using the same public volume-tiered seat pricing;
// the flat annual Manager Dashboard fee is amortized to a monthly figure.
const MANAGER_ANNUAL_PRICE = 189;
const MANAGER_MONTHLY = MANAGER_ANNUAL_PRICE / 12;

export function seatMonthlyRate(seatIndex: number): number {
  // seatIndex is 1-based position of the seat within the office.
  if (seatIndex <= 5) return 29;
  if (seatIndex <= 15) return 24;
  return 19;
}

export function seatsMrr(seatCount: number): number {
  let total = 0;
  for (let i = 1; i <= seatCount; i++) total += seatMonthlyRate(i);
  return total;
}

export type SalesRow = {
  officeId: number;
  officeName: string;
  subscriptionStatus: string;
  active: boolean;
  seatCount: number;
  seatsMrr: number;
  managerMrr: number;
  mrr: number;
  hasStripeCustomer: boolean;
};

export function computeSalesRow(office: Office): SalesRow {
  const active = officeIsActive(office);
  const seatCount = office.activeSeatCount ?? 0;
  const seats = active ? seatsMrr(seatCount) : 0;
  // The manager dashboard fee only contributes while the office is active and has
  // actually subscribed (a Stripe customer exists).
  const managerMrr = active && office.stripeCustomerId ? Math.round(MANAGER_MONTHLY * 100) / 100 : 0;
  const mrr = Math.round((seats + managerMrr) * 100) / 100;
  return {
    officeId: office.id,
    officeName: office.name,
    subscriptionStatus: office.subscriptionStatus,
    active,
    seatCount,
    seatsMrr: seats,
    managerMrr,
    mrr,
    hasStripeCustomer: Boolean(office.stripeCustomerId),
  };
}

export function summarizeSales(offices: Office[]): { rows: SalesRow[]; totalMrr: number; activeOffices: number } {
  const rows = offices.map(computeSalesRow);
  const totalMrr = Math.round(rows.reduce((sum, r) => sum + r.mrr, 0) * 100) / 100;
  const activeOffices = rows.filter((r) => r.active).length;
  return { rows, totalMrr, activeOffices };
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
