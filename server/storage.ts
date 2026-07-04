import { users, scenarios, sessions, offices, billingEvents, adminUsers, leads, visitorPageViews, certificationAttempts } from '@shared/schema';
import type { User, InsertUser, Scenario, InsertScenario, Session, InsertSession, Office, InsertOffice, BillingEvent, InsertBillingEvent, AdminUser, InsertAdminUser, Lead, InsertLead, VisitorPageView, InsertVisitorPageView, CertificationAttempt, InsertCertificationAttempt } from '@shared/schema';
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, inArray, and, desc } from "drizzle-orm";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required (Postgres connection string)");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

export const db = drizzle(pool);

export interface IStorage {
  createOffice(office: InsertOffice): Promise<Office>;
  getOffice(id: number): Promise<Office | undefined>;
  getOfficeByInviteCode(inviteCode: string): Promise<Office | undefined>;
  getOfficeByStripeCustomerId(customerId: string): Promise<Office | undefined>;
  getOfficeByStripeSubscriptionId(subscriptionId: string): Promise<Office | undefined>;
  updateOffice(id: number, patch: Partial<Office>): Promise<Office | undefined>;

  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, patch: Partial<InsertUser>): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  listUsersByOffice(officeId: number): Promise<User[]>;
  // Count paid consultant seats in an office (role 'consultant' or a manager who bought
  // their own training seat), excluding demo/QA accounts. This is the source of truth
  // for the Stripe seat quantity.
  countPaidSeats(officeId: number): Promise<number>;

  getBillingEventByStripeId(stripeEventId: string): Promise<BillingEvent | undefined>;
  recordBillingEvent(event: InsertBillingEvent): Promise<BillingEvent>;

  listScenarios(): Promise<Scenario[]>;
  getScenario(id: number): Promise<Scenario | undefined>;
  getScenarioBySlug(slug: string): Promise<Scenario | undefined>;
  createScenario(scenario: InsertScenario): Promise<Scenario>;
  updateScenario(id: number, patch: Partial<InsertScenario>): Promise<Scenario | undefined>;

  createSession(session: InsertSession): Promise<Session>;
  getSession(id: number): Promise<Session | undefined>;
  updateSession(id: number, patch: Partial<InsertSession>): Promise<Session | undefined>;
  listSessionsByUser(userId: number): Promise<Session[]>;
  listAllSessions(): Promise<Session[]>;
  listSessionsByOffice(officeId: number): Promise<Session[]>;

  getAdminByUsername(username: string): Promise<AdminUser | undefined>;
  createAdmin(admin: InsertAdminUser): Promise<AdminUser>;

  createLead(lead: InsertLead): Promise<Lead>;
  listLeads(): Promise<Lead[]>;
  updateLeadStatus(id: number, status: string): Promise<Lead | undefined>;

  createVisitorPageView(view: InsertVisitorPageView): Promise<VisitorPageView>;
  listVisitorPageViews(limit?: number): Promise<VisitorPageView[]>;

  listOffices(): Promise<Office[]>;

  createCertificationAttempt(attempt: InsertCertificationAttempt): Promise<CertificationAttempt>;
  getCertificationAttempt(id: number): Promise<CertificationAttempt | undefined>;
  getCertificationAttemptByScenarioSession(sessionId: number): Promise<CertificationAttempt | undefined>;
  updateCertificationAttempt(id: number, patch: Partial<InsertCertificationAttempt>): Promise<CertificationAttempt | undefined>;
  listCertificationAttemptsByUser(userId: number): Promise<CertificationAttempt[]>;
}

export class DatabaseStorage implements IStorage {
  async createOffice(office: InsertOffice): Promise<Office> {
    const rows = await db.insert(offices).values(office).returning();
    return rows[0];
  }

  async getOffice(id: number): Promise<Office | undefined> {
    const rows = await db.select().from(offices).where(eq(offices.id, id));
    return rows[0];
  }

  async getOfficeByInviteCode(inviteCode: string): Promise<Office | undefined> {
    const rows = await db.select().from(offices).where(eq(offices.inviteCode, inviteCode));
    return rows[0];
  }

  async getOfficeByStripeCustomerId(customerId: string): Promise<Office | undefined> {
    const rows = await db.select().from(offices).where(eq(offices.stripeCustomerId, customerId));
    return rows[0];
  }

  async getOfficeByStripeSubscriptionId(subscriptionId: string): Promise<Office | undefined> {
    const rows = await db.select().from(offices).where(eq(offices.stripeSubscriptionId, subscriptionId));
    return rows[0];
  }

  async updateOffice(id: number, patch: Partial<Office>): Promise<Office | undefined> {
    const { id: _ignore, ...rest } = patch as Partial<Office> & { id?: number };
    const rows = await db.update(offices).set(rest).where(eq(offices.id, id)).returning();
    return rows[0];
  }

  async getUser(id: number): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.id, id));
    return rows[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.username, username));
    return rows[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const rows = await db.insert(users).values(insertUser).returning();
    return rows[0];
  }

  async updateUser(id: number, patch: Partial<InsertUser>): Promise<User | undefined> {
    const rows = await db.update(users).set(patch).where(eq(users.id, id)).returning();
    return rows[0];
  }

  async listUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async listUsersByOffice(officeId: number): Promise<User[]> {
    return db.select().from(users).where(eq(users.officeId, officeId));
  }

  async countPaidSeats(officeId: number): Promise<number> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.officeId, officeId), eq(users.seatActive, true), eq(users.isDemoAccount, false)));
    return rows.length;
  }

  async getBillingEventByStripeId(stripeEventId: string): Promise<BillingEvent | undefined> {
    const rows = await db.select().from(billingEvents).where(eq(billingEvents.stripeEventId, stripeEventId));
    return rows[0];
  }

  async recordBillingEvent(event: InsertBillingEvent): Promise<BillingEvent> {
    const rows = await db.insert(billingEvents).values(event).returning();
    return rows[0];
  }

  async listScenarios(): Promise<Scenario[]> {
    return db.select().from(scenarios);
  }

  async getScenario(id: number): Promise<Scenario | undefined> {
    const rows = await db.select().from(scenarios).where(eq(scenarios.id, id));
    return rows[0];
  }

  async getScenarioBySlug(slug: string): Promise<Scenario | undefined> {
    const rows = await db.select().from(scenarios).where(eq(scenarios.slug, slug));
    return rows[0];
  }

  async createScenario(scenario: InsertScenario): Promise<Scenario> {
    const rows = await db.insert(scenarios).values(scenario).returning();
    return rows[0];
  }

  async updateScenario(id: number, patch: Partial<InsertScenario>): Promise<Scenario | undefined> {
    const rows = await db.update(scenarios).set(patch).where(eq(scenarios.id, id)).returning();
    return rows[0];
  }

  async createSession(session: InsertSession): Promise<Session> {
    const rows = await db.insert(sessions).values(session).returning();
    return rows[0];
  }

  async getSession(id: number): Promise<Session | undefined> {
    const rows = await db.select().from(sessions).where(eq(sessions.id, id));
    return rows[0];
  }

  async updateSession(id: number, patch: Partial<InsertSession>): Promise<Session | undefined> {
    const rows = await db.update(sessions).set(patch).where(eq(sessions.id, id)).returning();
    return rows[0];
  }

  async listSessionsByUser(userId: number): Promise<Session[]> {
    return db.select().from(sessions).where(eq(sessions.userId, userId));
  }

  async listAllSessions(): Promise<Session[]> {
    return db.select().from(sessions);
  }

  async listSessionsByOffice(officeId: number): Promise<Session[]> {
    const officeUsers = await db.select({ id: users.id }).from(users).where(eq(users.officeId, officeId));
    const userIds = officeUsers.map((u) => u.id);
    if (userIds.length === 0) return [];
    return db.select().from(sessions).where(inArray(sessions.userId, userIds));
  }

  async getAdminByUsername(username: string): Promise<AdminUser | undefined> {
    const rows = await db.select().from(adminUsers).where(eq(adminUsers.username, username));
    return rows[0];
  }

  async createAdmin(admin: InsertAdminUser): Promise<AdminUser> {
    const rows = await db.insert(adminUsers).values(admin).returning();
    return rows[0];
  }

  async createLead(lead: InsertLead): Promise<Lead> {
    const rows = await db.insert(leads).values(lead).returning();
    return rows[0];
  }

  async listLeads(): Promise<Lead[]> {
    return db.select().from(leads).orderBy(desc(leads.id));
  }

  async updateLeadStatus(id: number, status: string): Promise<Lead | undefined> {
    const rows = await db.update(leads).set({ status }).where(eq(leads.id, id)).returning();
    return rows[0];
  }

  async createVisitorPageView(view: InsertVisitorPageView): Promise<VisitorPageView> {
    const rows = await db.insert(visitorPageViews).values(view).returning();
    return rows[0];
  }

  async listVisitorPageViews(limit = 1000): Promise<VisitorPageView[]> {
    return db.select().from(visitorPageViews).orderBy(desc(visitorPageViews.id)).limit(limit);
  }

  async listOffices(): Promise<Office[]> {
    return db.select().from(offices);
  }

  async createCertificationAttempt(attempt: InsertCertificationAttempt): Promise<CertificationAttempt> {
    const rows = await db.insert(certificationAttempts).values(attempt).returning();
    return rows[0];
  }

  async getCertificationAttempt(id: number): Promise<CertificationAttempt | undefined> {
    const rows = await db.select().from(certificationAttempts).where(eq(certificationAttempts.id, id));
    return rows[0];
  }

  async getCertificationAttemptByScenarioSession(sessionId: number): Promise<CertificationAttempt | undefined> {
    const rows = await db
      .select()
      .from(certificationAttempts)
      .where(eq(certificationAttempts.scenarioSessionId, sessionId));
    return rows[0];
  }

  async updateCertificationAttempt(id: number, patch: Partial<InsertCertificationAttempt>): Promise<CertificationAttempt | undefined> {
    const rows = await db.update(certificationAttempts).set(patch).where(eq(certificationAttempts.id, id)).returning();
    return rows[0];
  }

  async listCertificationAttemptsByUser(userId: number): Promise<CertificationAttempt[]> {
    return db.select().from(certificationAttempts).where(eq(certificationAttempts.userId, userId)).orderBy(desc(certificationAttempts.id));
  }
}

export const storage = new DatabaseStorage();
