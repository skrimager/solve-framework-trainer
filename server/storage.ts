import { users, scenarios, sessions, offices, billingEvents, adminUsers, contacts, contactEvents, visitorPageViews, certificationAttempts, demoSignups, demoSessions, prospectSearches, prospectCompanies, prospectContacts, prospectOutreach, prospectActivity, leadDripEmails, coachingMessages } from '@shared/schema';
import type { User, InsertUser, Scenario, InsertScenario, Session, InsertSession, Office, InsertOffice, BillingEvent, InsertBillingEvent, AdminUser, InsertAdminUser, Contact, InsertContact, ContactEvent, InsertContactEvent, Lead, InsertLead, VisitorPageView, InsertVisitorPageView, CertificationAttempt, InsertCertificationAttempt, DemoSignup, InsertDemoSignup, DemoSession, InsertDemoSession, ProspectSearch, InsertProspectSearch, ProspectCompany, InsertProspectCompany, ProspectContact, InsertProspectContact, ProspectOutreach, InsertProspectOutreach, ProspectActivity, InsertProspectActivity, LeadDripEmail, InsertLeadDripEmail, CoachingMessage, InsertCoachingMessage } from '@shared/schema';
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, inArray, and, desc, lte } from "drizzle-orm";
import { filterContacts, sortByFollowUp, type ContactFilters } from "./contacts";

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

  // Contact CRM. `createLead`/`listLeads`/`updateLeadStatus` are retained as
  // backward-compatible aliases for the public /api/leads flow and the legacy
  // /api/admin/leads routes (a Lead is a Contact).
  createContact(contact: InsertContact): Promise<Contact>;
  listContacts(filters?: ContactFilters, sort?: "followUp"): Promise<Contact[]>;
  getContact(id: number): Promise<Contact | undefined>;
  updateContact(id: number, patch: Partial<Contact>): Promise<Contact | undefined>;
  createContactEvent(event: InsertContactEvent): Promise<ContactEvent>;
  listContactEvents(contactId: number): Promise<ContactEvent[]>;

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

  // Public "Free Voice Demo". Signups are keyed by email (one row per email, holds
  // verification-code state + the all-time usage counter). Sessions are anonymous
  // demo roleplays, kept fully separate from seat-gated `sessions`.
  getDemoSignupByEmail(email: string): Promise<DemoSignup | undefined>;
  createDemoSignup(signup: InsertDemoSignup): Promise<DemoSignup>;
  updateDemoSignup(id: number, patch: Partial<InsertDemoSignup>): Promise<DemoSignup | undefined>;
  listDemoSignups(): Promise<DemoSignup[]>;
  createDemoSession(session: InsertDemoSession): Promise<DemoSession>;
  getDemoSession(id: number): Promise<DemoSession | undefined>;
  updateDemoSession(id: number, patch: Partial<InsertDemoSession>): Promise<DemoSession | undefined>;
  listDemoSessions(): Promise<DemoSession[]>;

  // --- Opportunity Intelligence (admin-only outbound lead-gen + drip) ---
  createProspectSearch(search: InsertProspectSearch): Promise<ProspectSearch>;
  getProspectSearch(id: number): Promise<ProspectSearch | undefined>;
  listProspectSearches(): Promise<ProspectSearch[]>;
  updateProspectSearch(id: number, patch: Partial<InsertProspectSearch>): Promise<ProspectSearch | undefined>;

  createProspectCompany(company: InsertProspectCompany): Promise<ProspectCompany>;
  getProspectCompaniesByIds(ids: number[]): Promise<ProspectCompany[]>;

  createProspectContact(contact: InsertProspectContact): Promise<ProspectContact>;
  getProspectContact(id: number): Promise<ProspectContact | undefined>;
  getProspectContactsByIds(ids: number[]): Promise<ProspectContact[]>;

  createProspectOutreach(outreach: InsertProspectOutreach): Promise<ProspectOutreach>;
  getProspectOutreach(id: number): Promise<ProspectOutreach | undefined>;
  listProspectOutreachBySearch(searchId: number): Promise<ProspectOutreach[]>;
  listDueProspectOutreach(nowIso: string): Promise<ProspectOutreach[]>;
  updateProspectOutreach(id: number, patch: Partial<InsertProspectOutreach>): Promise<ProspectOutreach | undefined>;

  createProspectActivity(activity: InsertProspectActivity): Promise<ProspectActivity>;
  listRecentProspectActivity(limit?: number): Promise<ProspectActivity[]>;

  // --- Inbound-lead welcome drip (day 0/3/7 auto-enrolled from /api/leads) ---
  createLeadDripEmail(email: InsertLeadDripEmail): Promise<LeadDripEmail>;
  listDueLeadDripEmails(nowIso: string): Promise<LeadDripEmail[]>;
  listLeadDripEmailsByContact(contactId: number): Promise<LeadDripEmail[]>;
  updateLeadDripEmail(id: number, patch: Partial<InsertLeadDripEmail>): Promise<LeadDripEmail | undefined>;

  // --- SOLVE Coach follow-up Q&A ---
  createCoachingMessage(message: InsertCoachingMessage): Promise<CoachingMessage>;
  // Only the still-active (cleared=false) thread for a session, oldest-first for display.
  listCoachingMessagesBySession(sessionId: number): Promise<CoachingMessage[]>;
  // Soft-clear every still-active thread a trainee owns (called when they start a new attempt).
  clearCoachingMessagesForUser(userId: number): Promise<void>;
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

  async createContact(contact: InsertContact): Promise<Contact> {
    const rows = await db.insert(contacts).values(contact).returning();
    const created = rows[0];
    // Every contact starts its timeline with a "created" event so no history is empty.
    await db.insert(contactEvents).values({
      contactId: created.id,
      eventType: "created",
      description: "Lead created",
      actor: "system",
      createdAt: created.createdAt,
    });
    return created;
  }

  async listContacts(filters: ContactFilters = {}, sort?: "followUp"): Promise<Contact[]> {
    const all = await db.select().from(contacts).orderBy(desc(contacts.id));
    const filtered = filterContacts(all, filters);
    return sort === "followUp" ? sortByFollowUp(filtered, "asc") : filtered;
  }

  async getContact(id: number): Promise<Contact | undefined> {
    const rows = await db.select().from(contacts).where(eq(contacts.id, id));
    return rows[0];
  }

  async updateContact(id: number, patch: Partial<Contact>): Promise<Contact | undefined> {
    const { id: _ignore, ...rest } = patch as Partial<Contact> & { id?: number };
    const rows = await db.update(contacts).set(rest).where(eq(contacts.id, id)).returning();
    return rows[0];
  }

  async createContactEvent(event: InsertContactEvent): Promise<ContactEvent> {
    const rows = await db.insert(contactEvents).values(event).returning();
    return rows[0];
  }

  async listContactEvents(contactId: number): Promise<ContactEvent[]> {
    // Newest first — most useful ordering for the dashboard timeline.
    return db
      .select()
      .from(contactEvents)
      .where(eq(contactEvents.contactId, contactId))
      .orderBy(desc(contactEvents.id));
  }

  // --- Backward-compatible lead aliases ---
  async createLead(lead: InsertLead): Promise<Lead> {
    return this.createContact(lead);
  }

  async listLeads(): Promise<Lead[]> {
    return db.select().from(contacts).orderBy(desc(contacts.id));
  }

  async updateLeadStatus(id: number, status: string): Promise<Lead | undefined> {
    const rows = await db.update(contacts).set({ status }).where(eq(contacts.id, id)).returning();
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

  async getDemoSignupByEmail(email: string): Promise<DemoSignup | undefined> {
    const rows = await db.select().from(demoSignups).where(eq(demoSignups.email, email));
    return rows[0];
  }

  async createDemoSignup(signup: InsertDemoSignup): Promise<DemoSignup> {
    const rows = await db.insert(demoSignups).values(signup).returning();
    return rows[0];
  }

  async updateDemoSignup(id: number, patch: Partial<InsertDemoSignup>): Promise<DemoSignup | undefined> {
    const rows = await db.update(demoSignups).set(patch).where(eq(demoSignups.id, id)).returning();
    return rows[0];
  }

  async listDemoSignups(): Promise<DemoSignup[]> {
    return db.select().from(demoSignups).orderBy(desc(demoSignups.id));
  }

  async createDemoSession(session: InsertDemoSession): Promise<DemoSession> {
    const rows = await db.insert(demoSessions).values(session).returning();
    return rows[0];
  }

  async getDemoSession(id: number): Promise<DemoSession | undefined> {
    const rows = await db.select().from(demoSessions).where(eq(demoSessions.id, id));
    return rows[0];
  }

  async updateDemoSession(id: number, patch: Partial<InsertDemoSession>): Promise<DemoSession | undefined> {
    const rows = await db.update(demoSessions).set(patch).where(eq(demoSessions.id, id)).returning();
    return rows[0];
  }

  async listDemoSessions(): Promise<DemoSession[]> {
    return db.select().from(demoSessions).orderBy(desc(demoSessions.id));
  }

  // --- Opportunity Intelligence ---
  async createProspectSearch(search: InsertProspectSearch): Promise<ProspectSearch> {
    const rows = await db.insert(prospectSearches).values(search).returning();
    return rows[0];
  }

  async getProspectSearch(id: number): Promise<ProspectSearch | undefined> {
    const rows = await db.select().from(prospectSearches).where(eq(prospectSearches.id, id));
    return rows[0];
  }

  async listProspectSearches(): Promise<ProspectSearch[]> {
    return db.select().from(prospectSearches).orderBy(desc(prospectSearches.id));
  }

  async updateProspectSearch(id: number, patch: Partial<InsertProspectSearch>): Promise<ProspectSearch | undefined> {
    const rows = await db.update(prospectSearches).set(patch).where(eq(prospectSearches.id, id)).returning();
    return rows[0];
  }

  async createProspectCompany(company: InsertProspectCompany): Promise<ProspectCompany> {
    const rows = await db.insert(prospectCompanies).values(company).returning();
    return rows[0];
  }

  async getProspectCompaniesByIds(ids: number[]): Promise<ProspectCompany[]> {
    if (ids.length === 0) return [];
    return db.select().from(prospectCompanies).where(inArray(prospectCompanies.id, ids));
  }

  async createProspectContact(contact: InsertProspectContact): Promise<ProspectContact> {
    const rows = await db.insert(prospectContacts).values(contact).returning();
    return rows[0];
  }

  async getProspectContact(id: number): Promise<ProspectContact | undefined> {
    const rows = await db.select().from(prospectContacts).where(eq(prospectContacts.id, id));
    return rows[0];
  }

  async getProspectContactsByIds(ids: number[]): Promise<ProspectContact[]> {
    if (ids.length === 0) return [];
    return db.select().from(prospectContacts).where(inArray(prospectContacts.id, ids));
  }

  async createProspectOutreach(outreach: InsertProspectOutreach): Promise<ProspectOutreach> {
    const rows = await db.insert(prospectOutreach).values(outreach).returning();
    return rows[0];
  }

  async getProspectOutreach(id: number): Promise<ProspectOutreach | undefined> {
    const rows = await db.select().from(prospectOutreach).where(eq(prospectOutreach.id, id));
    return rows[0];
  }

  async listProspectOutreachBySearch(searchId: number): Promise<ProspectOutreach[]> {
    return db.select().from(prospectOutreach).where(eq(prospectOutreach.searchId, searchId)).orderBy(prospectOutreach.id);
  }

  async listDueProspectOutreach(nowIso: string): Promise<ProspectOutreach[]> {
    return db
      .select()
      .from(prospectOutreach)
      .where(and(eq(prospectOutreach.status, "scheduled"), lte(prospectOutreach.scheduledAt, nowIso)))
      .orderBy(prospectOutreach.id);
  }

  async updateProspectOutreach(id: number, patch: Partial<InsertProspectOutreach>): Promise<ProspectOutreach | undefined> {
    const rows = await db.update(prospectOutreach).set(patch).where(eq(prospectOutreach.id, id)).returning();
    return rows[0];
  }

  async createProspectActivity(activity: InsertProspectActivity): Promise<ProspectActivity> {
    const rows = await db.insert(prospectActivity).values(activity).returning();
    return rows[0];
  }

  async listRecentProspectActivity(limit = 200): Promise<ProspectActivity[]> {
    return db.select().from(prospectActivity).orderBy(desc(prospectActivity.id)).limit(limit);
  }

  // --- Inbound-lead welcome drip ---
  async createLeadDripEmail(email: InsertLeadDripEmail): Promise<LeadDripEmail> {
    const rows = await db.insert(leadDripEmails).values(email).returning();
    return rows[0];
  }

  async listDueLeadDripEmails(nowIso: string): Promise<LeadDripEmail[]> {
    return db
      .select()
      .from(leadDripEmails)
      .where(and(eq(leadDripEmails.status, "scheduled"), lte(leadDripEmails.scheduledAt, nowIso)))
      .orderBy(leadDripEmails.id);
  }

  async listLeadDripEmailsByContact(contactId: number): Promise<LeadDripEmail[]> {
    return db.select().from(leadDripEmails).where(eq(leadDripEmails.contactId, contactId)).orderBy(leadDripEmails.id);
  }

  async updateLeadDripEmail(id: number, patch: Partial<InsertLeadDripEmail>): Promise<LeadDripEmail | undefined> {
    const rows = await db.update(leadDripEmails).set(patch).where(eq(leadDripEmails.id, id)).returning();
    return rows[0];
  }

  // --- SOLVE Coach follow-up Q&A ---
  async createCoachingMessage(message: InsertCoachingMessage): Promise<CoachingMessage> {
    const rows = await db.insert(coachingMessages).values(message).returning();
    return rows[0];
  }

  async listCoachingMessagesBySession(sessionId: number): Promise<CoachingMessage[]> {
    return db
      .select()
      .from(coachingMessages)
      .where(and(eq(coachingMessages.sessionId, sessionId), eq(coachingMessages.cleared, false)))
      .orderBy(coachingMessages.id);
  }

  async clearCoachingMessagesForUser(userId: number): Promise<void> {
    await db
      .update(coachingMessages)
      .set({ cleared: true })
      .where(and(eq(coachingMessages.userId, userId), eq(coachingMessages.cleared, false)));
  }
}

export const storage = new DatabaseStorage();
