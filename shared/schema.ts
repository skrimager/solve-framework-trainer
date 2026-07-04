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
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// A discovery-training scenario (e.g. Manufactured Housing customer persona)
export const scenarios = pgTable("scenarios", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  vertical: text("vertical").notNull(), // consulting: 'manufactured_housing' | 'real_estate' | 'apartment_rental' | 'auto_sales' | 'hvac_service' | 'hvac_sales' | 'plumbing' | 'financial_advisor' | 'insurance_auto'; leadership: 'upset_customer_service' | 'employee_grievance' | 'peer_conflict'
  track: text("track").notNull().default("consulting"), // 'consulting' | 'leadership' — which top-level training track this scenario belongs to; existing rows backfill to 'consulting'
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
});

export const insertSessionSchema = createInsertSchema(sessions).omit({
  id: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

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

// A lead captured from the marketing site's "Request Access" form (replaces the
// old mailto: CTA). status is admin-updatable inline: new | contacted | converted.
export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company"), // office / company name (optional)
  message: text("message"), // optional free-text
  status: text("status").notNull().default("new"), // 'new' | 'contacted' | 'converted'
  source: text("source"), // which CTA/plan the lead came from (optional)
  createdAt: text("created_at").notNull(),
});

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
});

export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;

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
