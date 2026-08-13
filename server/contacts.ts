import { z } from "zod";
import type { Contact, InsertContactEvent, InsertContact } from "@shared/schema";

// ---------------------------------------------------------------------------
// CRM domain constants + validation. Shared by the admin API routes and the
// migration/backfill defaults. Kept dependency-free (no DB/Express) so the
// event-logging and filtering logic can be unit-tested directly.
// ---------------------------------------------------------------------------

export const CONTACT_TYPES = ["speaking", "consulting", "book", "training", "role_play", "general"] as const;
// "voice_demo" = auto-created the moment a demo visitor verifies their email
// code (POST /api/demo/verify), kept distinct from "role_play" (the optional
// post-demo CTA form) so the two lead sources stay separately filterable.
export const CONTACT_SOURCES = ["website", "book", "speaking", "referral", "role_play", "manual", "voice_demo"] as const;
export const CONTACT_PRIORITIES = ["high", "medium", "low"] as const;
export const CONTACT_STATUSES = ["new", "contacted", "converted"] as const;

// Backfill/creation defaults (also asserted by the migration).
export const DEFAULT_TYPE = "general";
export const DEFAULT_SOURCE = "website";
export const DEFAULT_PRIORITY = "medium";
export const DEFAULT_STATUS = "new";

// Source tag for Contacts auto-created from a verified voice-demo signup (see
// enrollDemoVoiceContact below), and the type they're filed under (an existing
// enum value — demo/practice sessions fit "role_play" best).
export const VOICE_DEMO_SOURCE = "voice_demo";
export const VOICE_DEMO_TYPE = "role_play";

export type ContactType = (typeof CONTACT_TYPES)[number];
export type ContactSource = (typeof CONTACT_SOURCES)[number];
export type ContactPriority = (typeof CONTACT_PRIORITIES)[number];
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const contactTypeSchema = z.enum(CONTACT_TYPES);
export const contactSourceSchema = z.enum(CONTACT_SOURCES);
export const contactPrioritySchema = z.enum(CONTACT_PRIORITIES);
export const contactStatusSchema = z.enum(CONTACT_STATUSES);

// Body accepted by PATCH /api/admin/contacts/:id. Every field is optional; a
// request may update any subset plus optionally append a freeform note. An
// empty-string owner clears the owner; followUpDate accepts an ISO date/empty.
export const contactPatchSchema = z
  .object({
    status: contactStatusSchema.optional(),
    priority: contactPrioritySchema.optional(),
    owner: z.string().trim().max(200).nullable().optional(),
    followUpDate: z.string().trim().max(40).nullable().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export type ContactPatch = z.infer<typeof contactPatchSchema>;

// Normalize the loose incoming patch into the fields actually written to the
// row (owner/followUpDate empty-string -> null; note is not a column).
export function normalizeContactPatch(patch: ContactPatch): Partial<Contact> {
  const out: Partial<Contact> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.priority !== undefined) out.priority = patch.priority;
  if (patch.owner !== undefined) out.owner = patch.owner ? patch.owner : null;
  if (patch.followUpDate !== undefined) out.followUpDate = patch.followUpDate ? patch.followUpDate : null;
  return out;
}

function displayOwner(owner: string | null | undefined): string {
  return owner && owner.trim() ? owner : "unassigned";
}

function displayDate(value: string | null | undefined): string {
  if (!value) return "none";
  // Show just the calendar date when it's an ISO timestamp; leave other strings as-is.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
}

// Compare an existing contact with an incoming patch (+ optional note) and
// produce the timeline events that should be appended. Pure: does not touch the
// DB. `contactId`, `actor`, and `createdAt` are stamped onto every event.
export function buildContactUpdateEvents(
  existing: Pick<Contact, "id" | "status" | "priority" | "owner" | "followUpDate">,
  patch: ContactPatch,
  opts: { actor: string; now: string },
): InsertContactEvent[] {
  const events: InsertContactEvent[] = [];
  const base = { contactId: existing.id, actor: opts.actor, createdAt: opts.now };

  if (patch.status !== undefined && patch.status !== existing.status) {
    events.push({ ...base, eventType: "status_changed", description: `Status changed from ${existing.status} to ${patch.status}` });
  }
  if (patch.priority !== undefined && patch.priority !== existing.priority) {
    events.push({ ...base, eventType: "priority_changed", description: `Priority changed from ${existing.priority} to ${patch.priority}` });
  }
  if (patch.owner !== undefined) {
    const nextOwner = patch.owner ? patch.owner : null;
    if (nextOwner !== (existing.owner ?? null)) {
      events.push({ ...base, eventType: "owner_changed", description: `Owner changed from ${displayOwner(existing.owner)} to ${displayOwner(nextOwner)}` });
    }
  }
  if (patch.followUpDate !== undefined) {
    const nextFollow = patch.followUpDate ? patch.followUpDate : null;
    if (nextFollow !== (existing.followUpDate ?? null)) {
      events.push({ ...base, eventType: "follow_up_changed", description: `Follow-up date changed from ${displayDate(existing.followUpDate)} to ${displayDate(nextFollow)}` });
    }
  }
  if (patch.note !== undefined && patch.note.trim()) {
    events.push({ ...base, eventType: "note", description: patch.note.trim() });
  }
  return events;
}

// True when a contact's followUpDate is today or in the past (relative to
// `now`). Null/blank follow-ups are never due. Used for the "due for follow-up"
// dashboard cue.
export function isFollowUpDue(followUpDate: string | null | undefined, now: Date = new Date()): boolean {
  if (!followUpDate) return false;
  const due = new Date(followUpDate);
  if (Number.isNaN(due.getTime())) return false;
  const dueDay = due.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return dueDay <= today;
}

// Which archived state to include in a list. Defaults to "active" so archived
// contacts are hidden from the normal view but still reachable via "archived".
export const CONTACT_ARCHIVE_VIEWS = ["active", "archived", "all"] as const;
export type ContactArchiveView = (typeof CONTACT_ARCHIVE_VIEWS)[number];

export type ContactFilters = {
  type?: string;
  priority?: string;
  status?: string;
  owner?: string;
  archived?: ContactArchiveView;
};

// Apply the admin list filters in memory. Exact match per provided field;
// unknown/blank filter values are ignored. Archived state defaults to "active".
export function filterContacts(contacts: Contact[], filters: ContactFilters): Contact[] {
  const view: ContactArchiveView = filters.archived ?? "active";
  return contacts.filter((c) => {
    if (view === "active" && c.archivedAt) return false;
    if (view === "archived" && !c.archivedAt) return false;
    if (filters.type && c.type !== filters.type) return false;
    if (filters.priority && c.priority !== filters.priority) return false;
    if (filters.status && c.status !== filters.status) return false;
    if (filters.owner && (c.owner ?? "") !== filters.owner) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Hard-delete cascade. Permanently removing a contact must clear the rows that
// reference it, in a foreign-key-safe order, inside one transaction. The order
// and the "detach (null out) rather than delete" rule for office_setup_tokens
// are the important, testable part; the concrete DB writes are injected by
// storage.deleteContact so this stays dependency-free and unit-testable.
// ---------------------------------------------------------------------------
export interface ContactCascade {
  // 1. lead_drip_emails.contact_id is NOT NULL -> delete those rows first.
  deleteLeadDripEmails(contactId: number): Promise<void>;
  // 2. contact_events.contact_id is NOT NULL -> delete those rows next.
  deleteContactEvents(contactId: number): Promise<void>;
  // 3. office_setup_tokens.contact_id is nullable -> null it out, keep the token
  //    row as an audit record (do NOT delete it).
  detachOfficeSetupTokens(contactId: number): Promise<void>;
  // 4. finally the contact row itself.
  deleteContactRow(contactId: number): Promise<void>;
}

export async function runContactCascade(contactId: number, ops: ContactCascade): Promise<void> {
  await ops.deleteLeadDripEmails(contactId);
  await ops.deleteContactEvents(contactId);
  await ops.detachOfficeSetupTokens(contactId);
  await ops.deleteContactRow(contactId);
}

// Body accepted by POST /api/admin/contacts/bulk-delete: a non-empty list of
// unique positive integer contact ids.
export const bulkDeleteContactsSchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
  })
  .strict();

export type BulkDeleteContacts = z.infer<typeof bulkDeleteContactsSchema>;

// Sort by followUpDate. Contacts with no follow-up sort last (they are not
// pending action). Ascending = soonest/most-overdue first.
export function sortByFollowUp(contacts: Contact[], direction: "asc" | "desc" = "asc"): Contact[] {
  const sign = direction === "desc" ? -1 : 1;
  return [...contacts].sort((a, b) => {
    const av = a.followUpDate ?? "";
    const bv = b.followUpDate ?? "";
    if (!av && !bv) return 0;
    if (!av) return 1; // nulls always last regardless of direction
    if (!bv) return -1;
    return av < bv ? -1 * sign : av > bv ? 1 * sign : 0;
  });
}

// ---------------------------------------------------------------------------
// Voice-demo Contact auto-creation. A demo visitor only ever gives an email
// (no name), so we derive a simple display name from the local-part. Kept
// intentionally simple: split on common separators, capitalize each word.
// Not meant to be a real name parser — just friendlier than a bare email in
// the admin Contacts list.
// ---------------------------------------------------------------------------
export function humanizeEmailLocalPart(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local
    .split(/[.\-_+]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return email;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Field mapping for a Contact created from a verified voice-demo signup.
// Shared by the live /api/demo/verify handler (Part 1) and the one-off
// backfill script (Part 2) so the two never drift apart. `createdAt` is
// supplied by the caller: "now" for a live verification, or the original
// demo_signups.created_at value when backfilling a past signup.
export function buildVoiceDemoContact(email: string, createdAt: string): InsertContact {
  return {
    name: humanizeEmailLocalPart(email),
    email,
    company: null,
    message: "Signed up for the SOLVE voice demo.",
    referredBy: null,
    source: VOICE_DEMO_SOURCE,
    type: VOICE_DEMO_TYPE,
    priority: DEFAULT_PRIORITY,
    status: DEFAULT_STATUS,
    createdAt,
    archivedAt: null,
  };
}

// True if any contact in the list is already a "voice_demo"-sourced row for
// this email (case-insensitive). Deliberately narrow: a visitor filling the
// separate CTA form (source "role_play") should NOT block this check — both
// are legitimate, distinct interactions worth tracking separately.
export function hasVoiceDemoContact(contacts: Pick<Contact, "email" | "source">[], email: string): boolean {
  const target = email.trim().toLowerCase();
  return contacts.some((c) => c.source === VOICE_DEMO_SOURCE && c.email.trim().toLowerCase() === target);
}

export interface DemoVoiceContactDeps {
  storage: {
    listContacts(filters?: ContactFilters, sort?: "followUp"): Promise<Contact[]>;
    createLead(lead: InsertContact): Promise<Contact>;
  };
  now?: () => Date;
}

// Auto-create a Contact for a demo signup on its FIRST verification. Additive
// and best-effort: mirrors the reliability posture of enrollDemoDrip — never
// throws, so it can be fired-and-forgotten (`void enrollDemoVoiceContact(...)`)
// from the verify handler without ever blocking or changing its response.
// Idempotency: checks for an existing "voice_demo"-sourced contact for this
// email first (across archived + active, so an archived duplicate can never
// slip through) and skips creation if one already exists.
export async function enrollDemoVoiceContact(deps: DemoVoiceContactDeps, signup: { email: string }): Promise<void> {
  try {
    const existing = await deps.storage.listContacts({ archived: "all" });
    if (hasVoiceDemoContact(existing, signup.email)) return;
    const now = deps.now ? deps.now() : new Date();
    await deps.storage.createLead(buildVoiceDemoContact(signup.email, now.toISOString()));
  } catch (err) {
    console.warn(`[contacts] Failed to auto-create voice-demo contact for ${signup.email}:`, err);
  }
}
