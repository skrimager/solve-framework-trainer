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
  currentLevel: text("current_level").notNull().default("beginner"), // 'beginner' | 'intermediate' | 'advanced' | 'certified' — auto-advances at 85%+ average score
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
  vertical: text("vertical").notNull(), // 'manufactured_housing' | 'real_estate' | 'apartment_rental' | 'auto_sales' | 'hvac_service' | 'hvac_sales' | 'plumbing' | 'financial_advisor' | 'insurance_auto'
  description: text("description").notNull(), // internal-only summary shown to managers/QA, never to the consultant before/during a session
  customerPersona: text("customer_persona").notNull(), // system prompt describing the simulated customer
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

// Rubric scores shape (stored as JSON text in sessions.rubricScores)
export const rubricScoresSchema = z.object({
  needsDiscovery: z.number(), // "drill vs. hole" — uncovering real need vs. stated request
  objectionPrevention: z.number(), // depth of early discovery reducing objections
  trustBuilding: z.number(), // trust signal independent of the close
  naturalClose: z.number(), // close references customer's own words, not pressure-based
  relationshipContinuity: z.number(), // follow-up / next-steps signal
});
export type RubricScores = z.infer<typeof rubricScoresSchema>;
