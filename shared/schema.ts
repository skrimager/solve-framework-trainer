import { pgTable, text, integer, boolean, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// An office/organization tenant. Each office has its own manager(s), consultants,
// and (via user ownership) its own pool of role-play sessions.
export const offices = pgTable("offices", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // office / business name
  inviteCode: text("invite_code").notNull().unique(), // short random code consultants use to join
  createdAt: text("created_at").notNull(),
  // --- Stripe billing (one Stripe subscription per office) ---
  stripeCustomerId: text("stripe_customer_id"), // set when the manager first checks out
  stripeSubscriptionId: text("stripe_subscription_id"), // the office's single subscription
  subscriptionStatus: text("subscription_status").notNull().default("incomplete"), // Stripe status: incomplete | active | past_due | canceled | unpaid | trialing
  managerItemId: text("manager_item_id"), // subscription item id for the flat annual Manager Dashboard line
  seatItemId: text("seat_item_id"), // subscription item id for the tiered monthly Consultant Seat line (added lazily on first seat)
  activeSeatCount: integer("active_seat_count").notNull().default(0), // number of paid seats currently reflected in Stripe quantity
});

export const insertOfficeSchema = createInsertSchema(offices).omit({
  id: true,
});

export type InsertOffice = z.infer<typeof insertOfficeSchema>;
export type Office = typeof offices.$inferSelect;

// Roles: manager (sees all reps' sessions + analytics), consultant (does role-plays),
// qa (reviews transcripts/scores for quality assurance)
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  officeId: integer("office_id").notNull().references(() => offices.id), // every user belongs to exactly one office
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull(), // 'manager' | 'consultant' | 'qa'
  displayName: text("display_name").notNull(),
  currentLevel: text("current_level").notNull().default("beginner"), // Consulting-track level: 'beginner' | 'intermediate' | 'advanced' (advanced is the ceiling) — auto-advances at 85%+ average score
  leadershipLevel: text("leadership_level").notNull().default("beginner"), // Leadership/Conflict-Management track level, tracked independently from currentLevel so a user can be Advanced in one track and Beginner in the other
  // A paid, occupied consultant seat. Set true only after the office's Stripe seat
  // quantity has been incremented for this user (consultants and managers who buy
  // their own training seat). Gates access to roleplay/session creation.
  seatActive: boolean("seat_active").notNull().default(false),
  // QA/demo accounts are permanently free: they never consume a paid seat nor count
  // toward activeSeatCount, and are exempt from the seat access gate.
  isDemoAccount: boolean("is_demo_account").notNull().default(false),
  // Certification is a distinct, sequential state AFTER reaching Advanced on a track:
  // reaching Advanced only makes a user eligible to sit the exam; these flags flip
  // true only once BOTH the written test and the final expert scenario are passed.
  // Tracked fully independently per track, exactly like currentLevel/leadershipLevel.
  consultingCertified: boolean("consulting_certified").notNull().default(false),
  consultingCertifiedAt: text("consulting_certified_at"), // ISO timestamp when consulting certification was earned
  leadershipCertified: boolean("leadership_certified").notNull().default(false),
  leadershipCertifiedAt: text("leadership_certified_at"), // ISO timestamp when leadership certification was earned
});

export const insertUserSchema = createInsertSchema(users).pick({
  officeId: true,
  username: true,
  password: true,
  role: true,
  displayName: true,
  currentLevel: true,
  leadershipLevel: true,
  seatActive: true,
  isDemoAccount: true,
  consultingCertified: true,
  consultingCertifiedAt: true,
  leadershipCertified: true,
  leadershipCertifiedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// A discovery-training scenario (e.g. Manufactured Housing customer persona)
export const scenarios = pgTable("scenarios", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  vertical: text("vertical").notNull(), // consulting: 'manufactured_housing' | 'manufactured_housing_community' | 'real_estate' | 'apartment_rental' | 'auto_sales' | 'hvac_service' | 'hvac_sales' | 'plumbing' | 'financial_advisor' | 'insurance_auto' | 'home_improvement' (consolidated kitchen/bathroom/bedroom/windows/etc.) | 'pool_landscaping'; leadership: 'upset_customer_service' | 'employee_grievance' | 'peer_conflict'
  track: text("track").notNull().default("consulting"), // 'consulting' | 'leadership' — which top-level training track this scenario belongs to; existing rows backfill to 'consulting'
  // INTERNAL-ONLY real-estate transaction-type classifier. Never surfaced in any
  // trainee-facing UI or scenario picker: realtors should practice both listings
  // and purchases without forewarning, so which type a scenario is stays a
  // surprise. Read ONLY by the scoring/rubric logic (see closeExpectationForTransactionType
  // in server/llm.ts) to pick the right same-day-close expectation baseline.
  // 'manufactured_community' | 'manufactured_dealer' | 're_listing_agent' | 're_buyer_agent';
  // null for every non-real-estate / non-manufactured-housing scenario.
  transactionType: text("transaction_type"),
  description: text("description").notNull(), // internal-only summary shown to managers/QA, never to the consultant before/during a session
  customerPersona: text("customer_persona").notNull(), // system prompt describing the simulated customer
  gender: text("gender").notNull(), // 'male' | 'female' — single source of truth that must match the persona's avatar image; deterministically gates TTS voice selection so the heard voice can never be the wrong gender for the shown face
  difficulty: text("difficulty").notNull(), // 'beginner' | 'intermediate' | 'advanced'
  briefing: text("briefing").notNull().default(""), // consultant-facing setup: the setting + any technical terms shown before the role-play starts
  active: boolean("active").notNull().default(true),
});

export const insertScenarioSchema = createInsertSchema(scenarios).omit({
  id: true,
});

export type InsertScenario = z.infer<typeof insertScenarioSchema>;
export type Scenario = typeof scenarios.$inferSelect;

// A single discovery-training session (role-play attempt) by a consultant
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  scenarioId: integer("scenario_id").notNull(),
  status: text("status").notNull().default("in_progress"), // 'in_progress' | 'saved' | 'completed'
  transcript: text("transcript").notNull().default("[]"), // JSON array of {role, content, audioUrl?}
  score: integer("score"), // 0-100 overall, set on completion
  rubricScores: text("rubric_scores"), // JSON: per-dimension scores, set on completion
  feedback: text("feedback"), // narrative feedback, set on completion
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
  savedAt: text("saved_at"), // set when the consultant chooses "Save for Later" on an incomplete session
  // Practice time this session consumed, in seconds. Populated when the session
  // reaches a terminal state (completed or saved-for-later), computed from
  // createdAt to that end. Null while in progress. Summed per calendar month to
  // enforce the monthly fair-use practice cap (see server/fairUse.ts). Attributed
  // to the month the session was created in, so June time never counts in July.
  durationSeconds: integer("duration_seconds"),
});

export const insertSessionSchema = createInsertSchema(sessions).omit({
  id: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

// A single message in the SOLVE Coach follow-up Q&A thread that a trainee can
// have with the AI after a scenario's rubric feedback is shown. The thread is
// scoped to one scenario attempt (sessionId) and one trainee (userId). When the
// trainee starts a NEW scenario attempt, their prior threads are soft-cleared
// (cleared=true) so a fresh attempt never shows the last attempt's conversation.
// Managers/QA can read a trainee's still-active (cleared=false) thread but never
// post — role authorship is fixed to 'trainee' | 'coach'.
export const coachingMessages = pgTable("coaching_messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  userId: integer("user_id").notNull(), // the trainee who owns the attempt/thread
  role: text("role").notNull(), // 'trainee' | 'coach'
  content: text("content").notNull(),
  cleared: boolean("cleared").notNull().default(false), // soft-clear flag: hidden once the trainee begins a new attempt
  createdAt: text("created_at").notNull(),
});

export const insertCoachingMessageSchema = createInsertSchema(coachingMessages).omit({
  id: true,
});

export type InsertCoachingMessage = z.infer<typeof insertCoachingMessageSchema>;
export type CoachingMessage = typeof coachingMessages.$inferSelect;

// A single certification-exam attempt for one track. The two-part exam (written
// test + final expert scenario) is tracked here start-to-finish. `overallPassed`
// is only true once BOTH parts pass; that is the event that flips the user's
// per-track `*Certified` flag. Attempts are per-track and never shared between
// tracks (a consulting attempt can never certify leadership and vice versa).
export const certificationAttempts = pgTable("certification_attempts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  track: text("track").notNull(), // 'consulting' | 'leadership'
  startedAt: text("started_at").notNull(),
  questionIds: text("question_ids").notNull().default("[]"), // JSON array of the 30 drawn question ids, so grading re-derives the exact set
  writtenScore: integer("written_score"), // percent correct (0-100), set on written submission
  writtenPassed: boolean("written_passed").notNull().default(false),
  scenarioSessionId: integer("scenario_session_id"), // FK into sessions — the final expert roleplay, created only after the written test passes
  scenarioScore: integer("scenario_score"), // 0-100 overall from scoreTranscript, set when that session completes
  scenarioPassed: boolean("scenario_passed").notNull().default(false),
  overallPassed: boolean("overall_passed").notNull().default(false), // true only when writtenPassed AND scenarioPassed
  completedAt: text("completed_at"), // set when the attempt reaches a terminal state (both parts scored)
});

export const insertCertificationAttemptSchema = createInsertSchema(certificationAttempts).omit({
  id: true,
});

export type InsertCertificationAttempt = z.infer<typeof insertCertificationAttemptSchema>;
export type CertificationAttempt = typeof certificationAttempts.$inferSelect;

// Transcript message shape (stored as JSON text in sessions.transcript)
export const transcriptMessageSchema = z.object({
  role: z.enum(["customer", "consultant"]),
  content: z.string(),
  audioUrl: z.string().optional(),
  audioStatus: z.enum(["none", "pending", "ready", "failed"]).optional(),
  msgId: z.string().optional(),
  timestamp: z.string(),
});
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

// Audit log of processed Stripe webhook events. `stripeEventId` is unique so a
// redelivered event is a no-op (idempotency guard).
export const billingEvents = pgTable("billing_events", {
  id: serial("id").primaryKey(),
  stripeEventId: text("stripe_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  officeId: integer("office_id"), // resolved office, if known
  payloadSummary: text("payload_summary"), // small JSON summary for debugging (not the full event)
  createdAt: text("created_at").notNull(),
});

export const insertBillingEventSchema = createInsertSchema(billingEvents).omit({
  id: true,
});

export type InsertBillingEvent = z.infer<typeof insertBillingEventSchema>;
export type BillingEvent = typeof billingEvents.$inferSelect;

// A single top-level "Solve Admin" account. Structurally separate from the
// office-scoped users table: it has NO officeId and never participates in the
// manager/consultant hierarchy or seat billing. Its own login/session path keeps
// an admin session from ever being confused with a regular user session.
export const adminUsers = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(), // scrypt hash: "salt:derivedKey" (hex)
  createdAt: text("created_at").notNull(),
});

export const insertAdminUserSchema = createInsertSchema(adminUsers).omit({
  id: true,
});

export type InsertAdminUser = z.infer<typeof insertAdminUserSchema>;
export type AdminUser = typeof adminUsers.$inferSelect;

// The unified CRM contact table (evolved from the original marketing-site
// `leads` table — see migration 0007). EVERY contact, regardless of source
// (website, book, speaking, consulting, referral, role-play, manual entry),
// lives here tagged by `type`, with full history in `contact_events`.
// The public marketing "Request Access" form still POSTs to /api/leads and
// creates a row here with type "general" / source "website".
export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company"), // office / company name (optional)
  message: text("message"), // optional free-text from the submitter
  status: text("status").notNull().default("new"), // pipeline stage: 'new' | 'contacted' | 'converted'
  // What kind of contact this is. Drives future routing/forms (Phase 2+):
  // 'speaking' | 'consulting' | 'book' | 'training' | 'role_play' | 'general'.
  type: text("type").notNull().default("general"),
  // Where the contact originated: 'website' | 'book' | 'speaking' | 'referral'
  // | 'role_play' | 'manual' (extensible). Existing/marketing rows -> 'website'.
  source: text("source").notNull().default("website"),
  priority: text("priority").notNull().default("medium"), // 'high' | 'medium' | 'low'
  owner: text("owner"), // team member handling it (nullable; one admin today, designed for many)
  followUpDate: text("follow_up_date"), // ISO timestamp of the next scheduled follow-up (nullable)
  createdAt: text("created_at").notNull(),
});

export const insertContactSchema = createInsertSchema(contacts).omit({
  id: true,
});

export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contacts.$inferSelect;

// Backward-compatible aliases. The public lead-capture endpoint and the
// notification email module still speak in terms of "Lead"; a Lead is simply a
// Contact. Kept so those call sites need no churn during this phase.
export type Lead = Contact;
export type InsertLead = InsertContact;
export const leads = contacts;
export const insertLeadSchema = insertContactSchema;

// Append-only timeline of every meaningful change to a contact (created, status
// changed, note added, priority/owner/follow-up changed). Populated automatically
// by the admin API — see server/contacts.ts. `actor` is who made the change
// ("admin"/"system" for now; designed for named team members later).
export const contactEvents = pgTable("contact_events", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  eventType: text("event_type").notNull(), // 'created' | 'status_changed' | 'priority_changed' | 'owner_changed' | 'follow_up_changed' | 'note'
  description: text("description").notNull(), // human readable, e.g. "Status changed from new to contacted"
  actor: text("actor"), // who performed the change (nullable)
  createdAt: text("created_at").notNull(),
});

export const insertContactEventSchema = createInsertSchema(contactEvents).omit({
  id: true,
});

export type InsertContactEvent = z.infer<typeof insertContactEventSchema>;
export type ContactEvent = typeof contactEvents.$inferSelect;

// An anonymous page-view logged by the marketing site's tracking snippet. No PII,
// no cookies/fingerprinting — visitorToken is a fresh random per page load.
export const visitorPageViews = pgTable("visitor_page_views", {
  id: serial("id").primaryKey(),
  path: text("path").notNull(),
  referrer: text("referrer"),
  visitorToken: text("visitor_token"), // opaque per-page-load token, not tied to identity
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull(),
});

export const insertVisitorPageViewSchema = createInsertSchema(visitorPageViews).omit({
  id: true,
});

export type InsertVisitorPageView = z.infer<typeof insertVisitorPageViewSchema>;
export type VisitorPageView = typeof visitorPageViews.$inferSelect;

// A public "Free Voice Demo" signup, keyed by email. One row per email captures
// the email-verification state AND the all-time usage counter that enforces the
// 3-free-sessions-per-email limit. This is intentionally separate from the
// seat-gated `users` table: demo visitors are anonymous and never become users,
// so they must not touch office/seat billing. The email+6-digit-code
// verification IS the auth for the demo (no shared login).
export const demoSignups = pgTable("demo_signups", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  code: text("code"), // current 6-digit verification code (nullable once consumed/expired)
  codeExpiresAt: text("code_expires_at"), // ISO timestamp; code is invalid past this
  verified: boolean("verified").notNull().default(false), // flips true once any code is confirmed
  sessionsUsed: integer("sessions_used").notNull().default(0), // all-time started demo sessions; capped at 3
  createdAt: text("created_at").notNull(),
  lastSentAt: text("last_sent_at"), // ISO timestamp of the most recent code email (for resend cadence/visibility)
});

export const insertDemoSignupSchema = createInsertSchema(demoSignups).omit({ id: true });
export type InsertDemoSignup = z.infer<typeof insertDemoSignupSchema>;
export type DemoSignup = typeof demoSignups.$inferSelect;

// A single public demo roleplay attempt. Mirrors the fields of `sessions` that
// the shared voice pipeline + scoring rubric touch (transcript/score/rubric/
// feedback), but lives in its own table so anonymous demo traffic never mixes
// with real trainee sessions, office analytics, or level progression.
export const demoSessions = pgTable("demo_sessions", {
  id: serial("id").primaryKey(),
  signupId: integer("signup_id").notNull().references(() => demoSignups.id),
  email: text("email").notNull(), // denormalized for simple admin listing/filtering
  scenarioId: integer("scenario_id").notNull(),
  status: text("status").notNull().default("in_progress"), // 'in_progress' | 'completed'
  transcript: text("transcript").notNull().default("[]"), // same JSON shape as sessions.transcript
  score: integer("score"),
  rubricScores: text("rubric_scores"),
  feedback: text("feedback"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
  // Abuse-protection signals captured at session start. deviceFingerprint is the
  // client-side FingerprintJS hash (nullable: privacy tools can block it), used
  // for the 3-sessions-per-device cap. ipAddress backs the durable 6-per-IP /
  // 30-day cap. sessionNumber is this session's 1-based ordinal for the email,
  // used to unlock voice only on the third (final) free session.
  deviceFingerprint: text("device_fingerprint"),
  ipAddress: text("ip_address"),
  sessionNumber: integer("session_number").notNull().default(1),
});

export const insertDemoSessionSchema = createInsertSchema(demoSessions).omit({ id: true });
export type InsertDemoSession = z.infer<typeof insertDemoSessionSchema>;
export type DemoSession = typeof demoSessions.$inferSelect;

// ===========================================================================
// Opportunity Intelligence — admin-only lead-generation + email-drip system for
// SOLVE Framework's OWN marketing. Entirely separate from trainee-facing data
// (users/sessions/scenarios) and from the inbound CRM (contacts): these rows are
// OUTBOUND prospects discovered externally (Apollo/SimilarWeb, run out-of-band)
// and warmed with a scheduled three-step discovery-training email sequence.
// `segment` and `geography` are deliberately free-text (NOT enums) so new
// markets/verticals need no schema change — the first test market is Phoenix, AZ
// but geography is never hardcoded.
// ===========================================================================

// One weekly discovery batch: the result of running a segment × geography search
// externally. A batch is reviewed in the admin console, then Approved (which
// schedules its whole outreach sequence) or Rejected (outreach never sends).
export const prospectSearches = pgTable("prospect_searches", {
  id: serial("id").primaryKey(),
  segment: text("segment").notNull(), // free-text market segment, e.g. "manufactured_housing"
  geography: text("geography").notNull(), // free-text, e.g. "Phoenix, AZ"
  runAt: text("run_at").notNull(), // ISO timestamp the external discovery run completed
  resultsCount: integer("results_count").notNull().default(0), // number of companies in the batch
  status: text("status").notNull().default("pending_review"), // 'pending_review' | 'approved' | 'rejected'
});

export const insertProspectSearchSchema = createInsertSchema(prospectSearches).omit({ id: true });
export type InsertProspectSearch = z.infer<typeof insertProspectSearchSchema>;
export type ProspectSearch = typeof prospectSearches.$inferSelect;

// A prospect company surfaced by discovery. Not directly linked to a search row:
// its association to a batch is via its contacts' outreach (outreach.searchId),
// mirroring how discovery writes companies once and may reference them across
// steps.
export const prospectCompanies = pgTable("prospect_companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain"), // company website domain (nullable)
  segment: text("segment").notNull(), // free-text, matches the search segment
  city: text("city"),
  state: text("state"),
  employeeCount: integer("employee_count"),
  signalType: text("signal_type").notNull(), // 'hiring' | 'growth' | 'news' (free-text, extensible)
  signalDetail: text("signal_detail").notNull(), // human-readable reason this company surfaced
  source: text("source").notNull(), // 'apollo' | 'similarweb' (free-text, extensible)
  discoveredAt: text("discovered_at").notNull(), // ISO timestamp
  status: text("status").notNull().default("new"), // 'new' | 'contacted' | 'replied' | 'converted' | 'dead'
});

export const insertProspectCompanySchema = createInsertSchema(prospectCompanies).omit({ id: true });
export type InsertProspectCompany = z.infer<typeof insertProspectCompanySchema>;
export type ProspectCompany = typeof prospectCompanies.$inferSelect;

// A named contact at a prospect company — the actual outreach recipient.
export const prospectContacts = pgTable("prospect_contacts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => prospectCompanies.id),
  fullName: text("full_name").notNull(),
  title: text("title").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  linkedinUrl: text("linkedin_url"),
  createdAt: text("created_at").notNull(),
});

export const insertProspectContactSchema = createInsertSchema(prospectContacts).omit({ id: true });
export type InsertProspectContact = z.infer<typeof insertProspectContactSchema>;
export type ProspectContact = typeof prospectContacts.$inferSelect;

// One email in a contact's three-step discovery-training drip. Created as `draft`
// when a batch is inserted. Approving the batch flips step-1 to `scheduled` for
// now, step-2 for now+3d, step-3 for now+7d. The scheduled sender sends any
// `scheduled` row whose scheduledAt has passed, then sets it `sent`.
export const prospectOutreach = pgTable("prospect_outreach", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => prospectContacts.id),
  searchId: integer("search_id").notNull().references(() => prospectSearches.id),
  sequenceStep: integer("sequence_step").notNull(), // 1 | 2 | 3
  emailSubject: text("email_subject").notNull(),
  emailBody: text("email_body").notNull(),
  scheduledAt: text("scheduled_at"), // ISO timestamp; set on approval, null while draft
  sentAt: text("sent_at"), // ISO timestamp; set by the sender
  status: text("status").notNull().default("draft"), // 'draft' | 'scheduled' | 'sent' | 'replied' | 'stopped'
});

export const insertProspectOutreachSchema = createInsertSchema(prospectOutreach).omit({ id: true });
export type InsertProspectOutreach = z.infer<typeof insertProspectOutreachSchema>;
export type ProspectOutreach = typeof prospectOutreach.$inferSelect;

// Append-only activity log for a prospect contact (email opened, replied, bounced).
export const prospectActivity = pgTable("prospect_activity", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => prospectContacts.id),
  eventType: text("event_type").notNull(), // 'opened' | 'replied' | 'bounced' | 'sent' (free-text, extensible)
  eventDetail: text("event_detail").notNull(),
  occurredAt: text("occurred_at").notNull(), // ISO timestamp
});

export const insertProspectActivitySchema = createInsertSchema(prospectActivity).omit({ id: true });
export type InsertProspectActivity = z.infer<typeof insertProspectActivitySchema>;
export type ProspectActivity = typeof prospectActivity.$inferSelect;

// ===========================================================================
// Inbound-lead welcome drip. A separate table (NOT prospect_outreach) so the
// inbound day 0/3/7 sequence auto-enrolled from POST /api/leads is never mixed
// into the admin OUTBOUND prospecting batches/views. One row per step of an
// inbound contact's three-step sequence: step 1 is the day-0 welcome (recorded
// as `sent` because it's dispatched inline at capture time), steps 2 and 3 are
// the day-3 and day-7 follow-ups the shared background sender delivers when due.
// ===========================================================================
export const leadDripEmails = pgTable("lead_drip_emails", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  sequenceStep: integer("sequence_step").notNull(), // 1 (day 0 welcome) | 2 (day 3) | 3 (day 7)
  emailSubject: text("email_subject").notNull(),
  emailBody: text("email_body").notNull(), // plain text; rendered to HTML at send time
  scheduledAt: text("scheduled_at"), // ISO timestamp this step is due to send
  sentAt: text("sent_at"), // ISO timestamp set once actually sent
  status: text("status").notNull().default("scheduled"), // 'scheduled' | 'sent' | 'stopped'
});

export const insertLeadDripEmailSchema = createInsertSchema(leadDripEmails).omit({ id: true });
export type InsertLeadDripEmail = z.infer<typeof insertLeadDripEmailSchema>;
export type LeadDripEmail = typeof leadDripEmails.$inferSelect;

// Rubric scores shape (stored as JSON text in sessions.rubricScores)
export const rubricScoresSchema = z.object({
  needsDiscovery: z.number(), // "drill vs. hole" — uncovering real need vs. stated request
  objectionPrevention: z.number(), // depth of early discovery reducing objections
  trustBuilding: z.number(), // trust signal independent of the close
  naturalClose: z.number(), // close references customer's own words, not pressure-based
  relationshipContinuity: z.number(), // follow-up / next-steps signal
});
export type RubricScores = z.infer<typeof rubricScoresSchema>;

// Rubric scores shape for Leadership / Conflict-Management sessions (stored the
// same way as RubricScores — as JSON text in sessions.rubricScores). Which
// shape a row holds is disambiguated by the session's scenario `track`.
export const leadershipRubricScoresSchema = z.object({
  activeListening: z.number(), // let the person fully vent before responding; no interrupting/defending
  empathyAcknowledgment: z.number(), // named/validated the person's feeling before problem-solving
  rootCauseDiscovery: z.number(), // asked questions to find the real issue vs. reacting to the surface complaint
  solutionVisualization: z.number(), // co-created what a good outcome looks like with the other party, not unilaterally
  blamelessResolution: z.number(), // resolution offered without blaming the client/customer OR the company/coworker
});
export type LeadershipRubricScores = z.infer<typeof leadershipRubricScoresSchema>;
