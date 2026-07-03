import { pgTable, text, integer, boolean, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Roles: manager (sees all reps' sessions + analytics), consultant (does role-plays),
// qa (reviews transcripts/scores for quality assurance)
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull(), // 'manager' | 'consultant' | 'qa'
  displayName: text("display_name").notNull(),
  currentLevel: text("current_level").notNull().default("beginner"), // 'beginner' | 'intermediate' | 'advanced' | 'certified' — auto-advances at 85%+ average score
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  role: true,
  displayName: true,
  currentLevel: true,
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

// Rubric scores shape (stored as JSON text in sessions.rubricScores)
export const rubricScoresSchema = z.object({
  needsDiscovery: z.number(), // "drill vs. hole" — uncovering real need vs. stated request
  objectionPrevention: z.number(), // depth of early discovery reducing objections
  trustBuilding: z.number(), // trust signal independent of the close
  naturalClose: z.number(), // close references customer's own words, not pressure-based
  relationshipContinuity: z.number(), // follow-up / next-steps signal
});
export type RubricScores = z.infer<typeof rubricScoresSchema>;
