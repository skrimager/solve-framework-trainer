import { users, scenarios, sessions, offices, billingEvents, adminUsers, contacts, contactEvents, visitorPageViews, certificationAttempts, demoSignups, demoSessions, demoPaidSessions, messageCoachSignups, messageCoachScores, messageCoachPaidPurchases, prospectSearches, prospectCompanies, prospectContacts, prospectOutreach, prospectActivity, leadDripEmails, coachingMessages, alertAcknowledgements, industryCertifications, academyCredits, coinAwards, realConversations, officeSetupTokens, paidOfficeSignups, officeSignups, scoreCache, demoDripEmails, monthlyLifecycleEmails, emailSuppressions, evaluationPurchases, evaluationCreditLedger } from '@shared/schema';
import type { User, InsertUser, Scenario, InsertScenario, Session, InsertSession, Office, InsertOffice, BillingEvent, InsertBillingEvent, AdminUser, InsertAdminUser, Contact, InsertContact, ContactEvent, InsertContactEvent, Lead, InsertLead, VisitorPageView, InsertVisitorPageView, CertificationAttempt, InsertCertificationAttempt, DemoSignup, InsertDemoSignup, DemoSession, InsertDemoSession, DemoPaidSession, InsertDemoPaidSession, MessageCoachSignup, InsertMessageCoachSignup, MessageCoachScore, InsertMessageCoachScore, MessageCoachPaidPurchase, InsertMessageCoachPaidPurchase, ProspectSearch, InsertProspectSearch, ProspectCompany, InsertProspectCompany, ProspectContact, InsertProspectContact, ProspectOutreach, InsertProspectOutreach, ProspectActivity, InsertProspectActivity, LeadDripEmail, InsertLeadDripEmail, CoachingMessage, InsertCoachingMessage, AlertAcknowledgement, InsertAlertAcknowledgement, IndustryCertification, InsertIndustryCertification, AcademyCredit, InsertAcademyCredit, CoinAward, InsertCoinAward, RealConversation, InsertRealConversation, OfficeSetupToken, InsertOfficeSetupToken, PaidOfficeSignup, InsertPaidOfficeSignup, OfficeSignup, InsertOfficeSignup, ScoreCache, InsertScoreCache, DemoDripEmail, InsertDemoDripEmail, MonthlyLifecycleEmail, InsertMonthlyLifecycleEmail, EmailSuppression, InsertEmailSuppression, EvaluationPurchase, InsertEvaluationPurchase, EvaluationCreditLedger, InsertEvaluationCreditLedger } from '@shared/schema';
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, inArray, and, or, desc, lte, isNull, sql } from "drizzle-orm";
import { filterContacts, sortByFollowUp, runContactCascade, type ContactFilters } from "./contacts";
import { runUserCascade, checkUserDeletable, userIsPaying, UserDeleteBlockedError, type UserCascade } from "./users";
import { runOfficeCascade, officeIsPayingCustomer, OfficeDeleteBlockedError } from "./offices";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required (Postgres connection string)");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

export const db = drizzle(pool);

// A drizzle transaction handle (same query builder as `db`).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Build the FK-safe user-delete cascade ops bound to a transaction. Shared by
// deleteUser (single user) and deleteOffice (each of a test office's users), so
// both take the identical dependency-ordered path. real_conversations is keyed
// on EITHER user column; monthly_lifecycle_emails only removes this user's
// paying-user rows (never a demo_signup row that shares the id).
function userCascadeOps(tx: Tx, userId: number): UserCascade {
  return {
    deleteCoachingMessages: async () => {
      await tx.delete(coachingMessages).where(eq(coachingMessages.userId, userId));
    },
    deleteCertificationAttempts: async () => {
      await tx.delete(certificationAttempts).where(eq(certificationAttempts.userId, userId));
    },
    deleteIndustryCertifications: async () => {
      await tx.delete(industryCertifications).where(eq(industryCertifications.userId, userId));
    },
    deleteAcademyCredits: async () => {
      await tx.delete(academyCredits).where(eq(academyCredits.userId, userId));
    },
    deleteCoinAwards: async () => {
      await tx.delete(coinAwards).where(eq(coinAwards.userId, userId));
    },
    deleteRealConversations: async () => {
      await tx
        .delete(realConversations)
        .where(or(eq(realConversations.submittedByUserId, userId), eq(realConversations.subjectRepUserId, userId)));
    },
    deleteMonthlyLifecycleEmails: async () => {
      await tx
        .delete(monthlyLifecycleEmails)
        .where(and(eq(monthlyLifecycleEmails.recipientType, "paying_user"), eq(monthlyLifecycleEmails.recipientId, userId)));
    },
    deleteSessions: async () => {
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    },
    deleteUserRow: async () => {
      await tx.delete(users).where(eq(users.id, userId));
    },
  };
}

export interface IStorage {
  createOffice(office: InsertOffice): Promise<Office>;
  getOffice(id: number): Promise<Office | undefined>;
  getOfficeByInviteCode(inviteCode: string): Promise<Office | undefined>;
  getOfficeByStripeCustomerId(customerId: string): Promise<Office | undefined>;
  getOfficeByStripeSubscriptionId(subscriptionId: string): Promise<Office | undefined>;
  updateOffice(id: number, patch: Partial<Office>): Promise<Office | undefined>;
  // Soft archive / restore (reversible), mirroring archiveContact. Neither
  // touches Stripe or any dependent rows.
  archiveOffice(id: number): Promise<Office | undefined>;
  unarchiveOffice(id: number): Promise<Office | undefined>;
  // Hard, permanent delete of a NON-paying (test/trial) office and its dependent
  // rows in FK-safe order, in one transaction. Throws OfficeDeleteBlockedError if
  // the office is a real paying customer (archive-only). Returns false if the
  // office did not exist.
  deleteOffice(id: number): Promise<boolean>;

  getUser(id: number): Promise<User | undefined>;
  // Hard, permanent delete of a NON-paying user and its dependent rows in FK-safe
  // order, in one transaction. Throws UserDeleteBlockedError if the user has an
  // active paid seat or is the last manager of their office. Returns false if the
  // user did not exist.
  deleteUser(id: number): Promise<boolean>;
  getUserByUsername(username: string): Promise<User | undefined>;
  // Case-insensitive, normalized (trimmed+lowercased at the call site) lookup of
  // every account with a given email on file. Plural because manager/qa accounts
  // in the same office may share one inbox; forgot-username emails all of them.
  getUsersByEmail(email: string): Promise<User[]>;
  // Looks up the single account currently holding a given (unexpired or expired —
  // expiry is checked by the caller so it can distinguish "expired" from "unknown"
  // for a clearer user-facing message) password reset token.
  getUserByPasswordResetToken(token: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, patch: Partial<InsertUser>): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  listUsersByOffice(officeId: number): Promise<User[]>;
  // Count paid consultant seats in an office (role 'consultant' or a manager who bought
  // their own training seat), excluding demo/QA accounts. This is the source of truth
  // for the Stripe seat quantity.
  countPaidSeats(officeId: number): Promise<number>;
  // Evaluation participants do not consume recurring paid seats. This count is
  // the participant-cap backstop used before adding a consultant to an evaluation.
  countEvaluationParticipants(evaluationPurchaseId: number): Promise<number>;
  createEvaluationPurchase(purchase: InsertEvaluationPurchase): Promise<EvaluationPurchase>;
  getEvaluationPurchase(id: number): Promise<EvaluationPurchase | undefined>;
  getEvaluationPurchaseByCheckoutSessionId(sessionId: string): Promise<EvaluationPurchase | undefined>;
  getEvaluationPurchaseByConvertedSubscriptionId(subscriptionId: string): Promise<EvaluationPurchase | undefined>;
  listExpiredUnconvertedEvaluations(nowIso: string): Promise<EvaluationPurchase[]>;
  markEvaluationExpired(id: number, nowIso: string): Promise<void>;
  attachEvaluationConversionSubscription(id: number, subscriptionId: string, nowIso: string): Promise<void>;
  markEvaluationConverted(id: number, subscriptionId: string, nowIso: string): Promise<void>;
  createEvaluationCreditLedger(credit: InsertEvaluationCreditLedger): Promise<EvaluationCreditLedger>;
  markEvaluationCreditRedeemed(evaluationPurchaseId: number, subscriptionId: string, invoiceId: string, nowIso: string): Promise<void>;

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
  deleteSessionsByIds(sessionIds: number[]): Promise<void>;
  deleteCoachingMessagesBySessionIds(sessionIds: number[]): Promise<void>;
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
  // Soft archive / restore (reversible). archiveContact stamps archivedAt;
  // unarchiveContact clears it. Neither touches dependent history rows.
  archiveContact(id: number): Promise<Contact | undefined>;
  unarchiveContact(id: number): Promise<Contact | undefined>;
  // Hard, permanent delete of a contact and its dependent rows in FK-safe order,
  // wrapped in a single transaction. Returns false if the contact did not exist.
  deleteContact(id: number): Promise<boolean>;
  // Delete many contacts, each through the same transactional cascade. Reports
  // which ids were deleted vs. skipped (not found) so callers can surface it.
  bulkDeleteContacts(ids: number[]): Promise<{ deleted: number[]; notFound: number[] }>;
  createContactEvent(event: InsertContactEvent): Promise<ContactEvent>;
  listContactEvents(contactId: number): Promise<ContactEvent[]>;

  createLead(lead: InsertLead): Promise<Lead>;
  listLeads(): Promise<Lead[]>;
  updateLeadStatus(id: number, status: string): Promise<Lead | undefined>;

  createVisitorPageView(view: InsertVisitorPageView): Promise<VisitorPageView>;
  listVisitorPageViews(limit?: number): Promise<VisitorPageView[]>;
  // Standalone analytics rows: no cascade needed (nothing references them).
  // Bulk delete by id and "clear all" both return the number of rows removed.
  deleteVisitorPageViews(ids: number[]): Promise<number>;
  deleteAllVisitorPageViews(): Promise<number>;
  countVisitorPageViews(): Promise<number>;

  listOffices(): Promise<Office[]>;

  createCertificationAttempt(attempt: InsertCertificationAttempt): Promise<CertificationAttempt>;
  getCertificationAttempt(id: number): Promise<CertificationAttempt | undefined>;
  getCertificationAttemptByScenarioSession(sessionId: number): Promise<CertificationAttempt | undefined>;
  updateCertificationAttempt(id: number, patch: Partial<InsertCertificationAttempt>): Promise<CertificationAttempt | undefined>;
  listCertificationAttemptsByUser(userId: number): Promise<CertificationAttempt[]>;

  // --- Per-industry certification progress ---
  getIndustryCertification(userId: number, track: string, vertical: string): Promise<IndustryCertification | undefined>;
  listIndustryCertificationsByUser(userId: number): Promise<IndustryCertification[]>;
  listIndustryCertificationsByUserIds(userIds: number[]): Promise<IndustryCertification[]>;
  createIndustryCertification(cert: InsertIndustryCertification): Promise<IndustryCertification>;
  updateIndustryCertification(id: number, patch: Partial<InsertIndustryCertification>): Promise<IndustryCertification | undefined>;

  // --- SOLVE Success Investment academy credits ---
  createAcademyCredit(credit: InsertAcademyCredit): Promise<AcademyCredit>;
  listAcademyCreditsByUser(userId: number): Promise<AcademyCredit[]>;
  listAcademyCreditsByOffice(officeId: number): Promise<AcademyCredit[]>;
  listAllAcademyCredits(): Promise<AcademyCredit[]>;
  insertCoinAwardIfAbsent(award: InsertCoinAward): Promise<boolean>;
  listCoinAwardsByUser(userId: number): Promise<CoinAward[]>;

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
  // Durable per-device / per-IP counters for the abuse caps. Return the raw rows
  // (small volume per key) so the caller applies the rolling-window filter in
  // pure, unit-tested logic (see countDemoSessionsInIpWindow).
  listDemoSessionsByFingerprint(fingerprint: string): Promise<DemoSession[]>;
  listDemoSessionsByIp(ip: string): Promise<DemoSession[]>;

  // $4.99 one-time purchases of an individual demo practice session (see
  // server/demoPayments.ts). One row per Stripe Checkout Session.
  createDemoPaidSession(data: InsertDemoPaidSession): Promise<DemoPaidSession>;
  getDemoPaidSessionByStripeCheckoutSessionId(id: string): Promise<DemoPaidSession | undefined>;
  updateDemoPaidSession(id: number, patch: Partial<InsertDemoPaidSession>): Promise<DemoPaidSession | undefined>;
  listDemoPaidSessionsBySignup(signupId: number): Promise<DemoPaidSession[]>;
  // Claims the signup's oldest unconsumed 'paid' credit for the given demo
  // session in ONE conditional update, so two concurrent session starts can
  // never spend the same credit twice. Returns the claimed row, or undefined
  // when no credit was available.
  claimOldestPaidDemoSession(signupId: number, demoSessionId: number): Promise<DemoPaidSession | undefined>;

  // --- Message Coach (see server/messageCoach.ts) ---
  // One signup row per email; freeScoreUsedAt is the one-free-score-per-email gate.
  getMessageCoachSignupByEmail(email: string): Promise<MessageCoachSignup | undefined>;
  createMessageCoachSignup(data: InsertMessageCoachSignup): Promise<MessageCoachSignup>;
  updateMessageCoachSignup(id: number, patch: Partial<InsertMessageCoachSignup>): Promise<MessageCoachSignup | undefined>;
  // Spends the one free score in a single conditional update (id +
  // freeScoreUsedAt IS NULL), so two concurrent requests for the same email
  // cannot both come away with a free score. Returns the updated row, or
  // undefined when the free score was already spent.
  claimFreeMessageCoachScore(id: number, usedAt: string): Promise<MessageCoachSignup | undefined>;

  createMessageCoachScore(data: InsertMessageCoachScore): Promise<MessageCoachScore>;

  // $4.99 one-time purchases of an additional score. One row per Stripe Checkout
  // Session, mirroring the demo paid-session methods above.
  createMessageCoachPaidPurchase(data: InsertMessageCoachPaidPurchase): Promise<MessageCoachPaidPurchase>;
  getMessageCoachPaidPurchase(id: number): Promise<MessageCoachPaidPurchase | undefined>;
  getMessageCoachPaidPurchaseByStripeCheckoutSessionId(id: string): Promise<MessageCoachPaidPurchase | undefined>;
  updateMessageCoachPaidPurchase(id: number, patch: Partial<InsertMessageCoachPaidPurchase>): Promise<MessageCoachPaidPurchase | undefined>;
  listMessageCoachPaidPurchasesBySignup(signupId: number): Promise<MessageCoachPaidPurchase[]>;
  // Claims THIS purchase in one conditional update (id + status='paid'), so two
  // concurrent score requests quoting the same purchase cannot both spend it.
  // Returns the claimed row, or undefined when it was not a spendable credit.
  claimMessageCoachPaidPurchase(id: number): Promise<MessageCoachPaidPurchase | undefined>;

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

  // --- Demo-activation drip (day 0/1/3 auto-enrolled from /api/demo/verify) ---
  getDemoSignup(id: number): Promise<DemoSignup | undefined>;
  listDemoSessionsBySignup(signupId: number): Promise<DemoSession[]>;
  createDemoDripEmail(email: InsertDemoDripEmail): Promise<DemoDripEmail>;
  listDueDemoDripEmails(nowIso: string): Promise<DemoDripEmail[]>;
  listDemoDripEmailsBySignup(signupId: number): Promise<DemoDripEmail[]>;
  updateDemoDripEmail(id: number, patch: Partial<InsertDemoDripEmail>): Promise<DemoDripEmail | undefined>;

  // --- Monthly "Practice makes money!" lifecycle email ---
  createMonthlyLifecycleEmail(email: InsertMonthlyLifecycleEmail): Promise<MonthlyLifecycleEmail>;
  listDueMonthlyLifecycleEmails(nowIso: string): Promise<MonthlyLifecycleEmail[]>;
  listMonthlyLifecycleEmails(): Promise<MonthlyLifecycleEmail[]>;
  updateMonthlyLifecycleEmail(id: number, patch: Partial<InsertMonthlyLifecycleEmail>): Promise<MonthlyLifecycleEmail | undefined>;

  // --- One-click unsubscribe suppression (shared by the new lifecycle emails) ---
  createEmailSuppression(suppression: InsertEmailSuppression): Promise<EmailSuppression>;
  getEmailSuppression(email: string): Promise<EmailSuppression | undefined>;

  // --- SOLVE Coach follow-up Q&A ---
  createCoachingMessage(message: InsertCoachingMessage): Promise<CoachingMessage>;
  // Only the still-active (cleared=false) thread for a session, oldest-first for display.
  listCoachingMessagesBySession(sessionId: number): Promise<CoachingMessage[]>;
  // Soft-clear every still-active thread a trainee owns (called when they start a new attempt).
  clearCoachingMessagesForUser(userId: number): Promise<void>;

  // Command Center alert acknowledgement lifecycle. "Active" means the
  // acknowledgement has not been superseded by the consultant completing a
  // newer relevant session.
  createAlertAcknowledgement(acknowledgement: InsertAlertAcknowledgement): Promise<AlertAcknowledgement>;
  listActiveAlertAcknowledgements(officeId: number): Promise<AlertAcknowledgement[]>;

  // --- Real Conversation Scoring (Phase 1): rep-submitted real discovery conversations. ---
  createRealConversation(rc: InsertRealConversation): Promise<RealConversation>;
  getRealConversation(id: number): Promise<RealConversation | undefined>;
  listRealConversationsByUser(userId: number): Promise<RealConversation[]>;
  // Phase 3: keyed on the SUBJECT rep, so a rep sees submissions about them
  // (including manager-submitted ones) and the monthly cap counts per rep seat.
  listRealConversationsBySubjectRep(subjectRepUserId: number): Promise<RealConversation[]>;
  // Phase 3: office-wide, to compute each consultant's monthly usage meter.
  listRealConversationsByOffice(officeId: number): Promise<RealConversation[]>;

  // Deterministic scoring cache (see scoreTranscript in server/llm.ts).
  getScoreCacheEntry(contentHash: string): Promise<ScoreCache | undefined>;
  createScoreCacheEntry(entry: InsertScoreCache): Promise<ScoreCache>;

  // --- Self-serve office setup (welcome-email token + paid signup provisioning) ---
  createOfficeSetupToken(token: InsertOfficeSetupToken): Promise<OfficeSetupToken>;
  getOfficeSetupToken(token: string): Promise<OfficeSetupToken | undefined>;
  updateOfficeSetupToken(id: number, patch: Partial<InsertOfficeSetupToken>): Promise<OfficeSetupToken | undefined>;
  createPaidOfficeSignup(signup: InsertPaidOfficeSignup): Promise<PaidOfficeSignup>;
  listPaidOfficeSignups(): Promise<PaidOfficeSignup[]>;
  getOfficeSignupByEmail(email: string): Promise<OfficeSignup | undefined>;
  getOfficeSignup(id: number): Promise<OfficeSignup | undefined>;
  createOfficeSignup(signup: InsertOfficeSignup): Promise<OfficeSignup>;
  updateOfficeSignup(id: number, patch: Partial<InsertOfficeSignup>): Promise<OfficeSignup | undefined>;
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

  async archiveOffice(id: number): Promise<Office | undefined> {
    const rows = await db
      .update(offices)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(offices.id, id))
      .returning();
    return rows[0];
  }

  async unarchiveOffice(id: number): Promise<Office | undefined> {
    const rows = await db.update(offices).set({ archivedAt: null }).where(eq(offices.id, id)).returning();
    return rows[0];
  }

  async deleteOffice(id: number): Promise<boolean> {
    const office = await this.getOffice(id);
    if (!office) return false;
    const officeUsers = await this.listUsersByOffice(id);
    // Guard: real paying customers (live Stripe subscription or any paid-seat
    // user) are archive-only and must never be hard-deleted.
    if (officeIsPayingCustomer(office, officeUsers)) {
      throw new OfficeDeleteBlockedError(
        "This office has an active subscription or paying users and cannot be deleted. Archive it instead.",
      );
    }
    // Defensive: never delete a user that individually shows as a real paid seat.
    // (Unreachable while the office-level guard holds, but abort clearly if the
    // underlying data is ever inconsistent rather than deleting a paid seat.)
    if (officeUsers.some(userIsPaying)) {
      throw new OfficeDeleteBlockedError(
        "This office has a seat-active paying user and cannot be deleted. Archive it instead.",
      );
    }
    await db.transaction(async (tx) => {
      await runOfficeCascade(id, {
        deleteUsers: async () => {
          for (const u of officeUsers) {
            await runUserCascade(u.id, userCascadeOps(tx, u.id));
          }
        },
        deleteAcademyCredits: async () => {
          await tx.delete(academyCredits).where(eq(academyCredits.officeId, id));
        },
        deleteCoinAwards: async () => {
          await tx.delete(coinAwards).where(eq(coinAwards.officeId, id));
        },
        deleteRealConversations: async () => {
          await tx.delete(realConversations).where(eq(realConversations.officeId, id));
        },
        detachPaidOfficeSignups: async () => {
          await tx.update(paidOfficeSignups).set({ officeId: null }).where(eq(paidOfficeSignups.officeId, id));
        },
        detachBillingEvents: async () => {
          await tx.update(billingEvents).set({ officeId: null }).where(eq(billingEvents.officeId, id));
        },
        deleteOfficeRow: async () => {
          await tx.delete(offices).where(eq(offices.id, id));
        },
      });
    });
    return true;
  }

  async getUser(id: number): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.id, id));
    return rows[0];
  }

  async deleteUser(id: number): Promise<boolean> {
    const user = await this.getUser(id);
    if (!user) return false;
    // Guard: paying users and the last remaining manager of an office are never
    // deletable. otherManagerCount = managers in the same office excluding self.
    const officeUsers = await this.listUsersByOffice(user.officeId);
    const otherManagerCount = officeUsers.filter((u) => u.role === "manager" && u.id !== id).length;
    const check = checkUserDeletable(user, { otherManagerCount });
    if (!check.ok) throw new UserDeleteBlockedError(check.reason);
    await db.transaction(async (tx) => {
      await runUserCascade(id, userCascadeOps(tx, id));
    });
    return true;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.username, username));
    return rows[0];
  }

  async getUsersByEmail(email: string): Promise<User[]> {
    return db.select().from(users).where(eq(users.email, email));
  }

  async getUserByPasswordResetToken(token: string): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.passwordResetToken, token));
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

  async countEvaluationParticipants(evaluationPurchaseId: number): Promise<number> {
    const rows = await db.select({ id: users.id }).from(users)
      .where(eq(users.evaluationPurchaseId, evaluationPurchaseId));
    return rows.length;
  }

  async createEvaluationPurchase(purchase: InsertEvaluationPurchase): Promise<EvaluationPurchase> {
    const rows = await db.insert(evaluationPurchases).values(purchase).onConflictDoNothing().returning();
    if (rows[0]) return rows[0];
    const existing = await this.getEvaluationPurchaseByCheckoutSessionId(purchase.stripeCheckoutSessionId);
    if (existing) return existing;
    throw new Error("Failed to create or retrieve evaluation purchase");
  }

  async getEvaluationPurchase(id: number): Promise<EvaluationPurchase | undefined> {
    const rows = await db.select().from(evaluationPurchases).where(eq(evaluationPurchases.id, id));
    return rows[0];
  }

  async getEvaluationPurchaseByCheckoutSessionId(sessionId: string): Promise<EvaluationPurchase | undefined> {
    const rows = await db.select().from(evaluationPurchases)
      .where(eq(evaluationPurchases.stripeCheckoutSessionId, sessionId));
    return rows[0];
  }

  async getEvaluationPurchaseByConvertedSubscriptionId(subscriptionId: string): Promise<EvaluationPurchase | undefined> {
    const rows = await db.select().from(evaluationPurchases)
      .where(eq(evaluationPurchases.convertedStripeSubscriptionId, subscriptionId));
    return rows[0];
  }

  async listExpiredUnconvertedEvaluations(nowIso: string): Promise<EvaluationPurchase[]> {
    return db.select().from(evaluationPurchases).where(and(
      lte(evaluationPurchases.evaluationEndsAt, nowIso),
      eq(evaluationPurchases.conversionStatus, "not_converted"),
    ));
  }

  async markEvaluationExpired(id: number, nowIso: string): Promise<void> {
    await db.update(evaluationPurchases).set({ conversionStatus: "expired_unconverted", updatedAt: nowIso })
      .where(eq(evaluationPurchases.id, id));
  }

  async attachEvaluationConversionSubscription(id: number, subscriptionId: string, nowIso: string): Promise<void> {
    await db.update(evaluationPurchases).set({ convertedStripeSubscriptionId: subscriptionId, updatedAt: nowIso })
      .where(eq(evaluationPurchases.id, id));
  }

  async markEvaluationConverted(id: number, subscriptionId: string, nowIso: string): Promise<void> {
    await db.update(evaluationPurchases).set({
      conversionStatus: "converted", convertedAt: nowIso,
      convertedStripeSubscriptionId: subscriptionId, updatedAt: nowIso,
    }).where(eq(evaluationPurchases.id, id));
  }

  async createEvaluationCreditLedger(credit: InsertEvaluationCreditLedger): Promise<EvaluationCreditLedger> {
    const rows = await db.insert(evaluationCreditLedger).values(credit).onConflictDoNothing().returning();
    if (rows[0]) return rows[0];
    const existing = await db.select().from(evaluationCreditLedger)
      .where(eq(evaluationCreditLedger.evaluationPurchaseId, credit.evaluationPurchaseId));
    if (existing[0]) return existing[0];
    throw new Error("Failed to create or retrieve evaluation credit");
  }

  async markEvaluationCreditRedeemed(evaluationPurchaseId: number, subscriptionId: string, invoiceId: string, nowIso: string): Promise<void> {
    await db.update(evaluationCreditLedger).set({
      redeemed: true, redeemedAt: nowIso, redeemedStripeSubscriptionId: subscriptionId,
      redeemedStripeInvoiceId: invoiceId, updatedAt: nowIso,
    }).where(and(
      eq(evaluationCreditLedger.evaluationPurchaseId, evaluationPurchaseId),
      eq(evaluationCreditLedger.redeemed, false),
    ));
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

  // Narrow, purpose-built deletes for the demo roster's rolling-window
  // pruning job. Callers must pass exact, already-vetted ids (the scheduler
  // only ever prunes ids it just fetched for the allowlisted Demo Office
  // personas) — this does not accept a userId/date filter of its own, so it
  // cannot accidentally widen scope beyond what the caller already decided.
  async deleteCoachingMessagesBySessionIds(sessionIds: number[]): Promise<void> {
    if (sessionIds.length === 0) return;
    await db.delete(coachingMessages).where(inArray(coachingMessages.sessionId, sessionIds));
  }

  async deleteSessionsByIds(sessionIds: number[]): Promise<void> {
    if (sessionIds.length === 0) return;
    await db.delete(sessions).where(inArray(sessions.id, sessionIds));
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

  async archiveContact(id: number): Promise<Contact | undefined> {
    const rows = await db
      .update(contacts)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(contacts.id, id))
      .returning();
    return rows[0];
  }

  async unarchiveContact(id: number): Promise<Contact | undefined> {
    const rows = await db
      .update(contacts)
      .set({ archivedAt: null })
      .where(eq(contacts.id, id))
      .returning();
    return rows[0];
  }

  async deleteContact(id: number): Promise<boolean> {
    const existing = await this.getContact(id);
    if (!existing) return false;
    await db.transaction(async (tx) => {
      await runContactCascade(id, {
        deleteLeadDripEmails: async () => {
          await tx.delete(leadDripEmails).where(eq(leadDripEmails.contactId, id));
        },
        deleteContactEvents: async () => {
          await tx.delete(contactEvents).where(eq(contactEvents.contactId, id));
        },
        detachOfficeSetupTokens: async () => {
          await tx.update(officeSetupTokens).set({ contactId: null }).where(eq(officeSetupTokens.contactId, id));
        },
        deleteContactRow: async () => {
          await tx.delete(contacts).where(eq(contacts.id, id));
        },
      });
    });
    return true;
  }

  async bulkDeleteContacts(ids: number[]): Promise<{ deleted: number[]; notFound: number[] }> {
    const deleted: number[] = [];
    const notFound: number[] = [];
    // One transaction per contact so a missing/failed id never leaves a
    // half-deleted contact behind and the rest still complete.
    for (const id of ids) {
      if (await this.deleteContact(id)) deleted.push(id);
      else notFound.push(id);
    }
    return { deleted, notFound };
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

  async deleteVisitorPageViews(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await db
      .delete(visitorPageViews)
      .where(inArray(visitorPageViews.id, ids))
      .returning({ id: visitorPageViews.id });
    return rows.length;
  }

  async deleteAllVisitorPageViews(): Promise<number> {
    const rows = await db.delete(visitorPageViews).returning({ id: visitorPageViews.id });
    return rows.length;
  }

  async countVisitorPageViews(): Promise<number> {
    const rows = await db.select({ id: visitorPageViews.id }).from(visitorPageViews);
    return rows.length;
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

  // --- Per-industry certification progress ---
  async getIndustryCertification(userId: number, track: string, vertical: string): Promise<IndustryCertification | undefined> {
    const rows = await db
      .select()
      .from(industryCertifications)
      .where(
        and(
          eq(industryCertifications.userId, userId),
          eq(industryCertifications.track, track),
          eq(industryCertifications.vertical, vertical),
        ),
      );
    return rows[0];
  }

  async listIndustryCertificationsByUser(userId: number): Promise<IndustryCertification[]> {
    return db.select().from(industryCertifications).where(eq(industryCertifications.userId, userId));
  }

  async listIndustryCertificationsByUserIds(userIds: number[]): Promise<IndustryCertification[]> {
    if (userIds.length === 0) return [];
    return db.select().from(industryCertifications).where(inArray(industryCertifications.userId, userIds));
  }

  async createIndustryCertification(cert: InsertIndustryCertification): Promise<IndustryCertification> {
    const rows = await db.insert(industryCertifications).values(cert).returning();
    return rows[0];
  }

  async updateIndustryCertification(id: number, patch: Partial<InsertIndustryCertification>): Promise<IndustryCertification | undefined> {
    const rows = await db.update(industryCertifications).set(patch).where(eq(industryCertifications.id, id)).returning();
    return rows[0];
  }

  // --- SOLVE Success Investment academy credits ---
  async createAcademyCredit(credit: InsertAcademyCredit): Promise<AcademyCredit> {
    const rows = await db.insert(academyCredits).values(credit).returning();
    return rows[0];
  }

  async listAcademyCreditsByUser(userId: number): Promise<AcademyCredit[]> {
    return db.select().from(academyCredits).where(eq(academyCredits.userId, userId)).orderBy(academyCredits.level);
  }

  async listAcademyCreditsByOffice(officeId: number): Promise<AcademyCredit[]> {
    return db.select().from(academyCredits).where(eq(academyCredits.officeId, officeId));
  }

  async listAllAcademyCredits(): Promise<AcademyCredit[]> {
    return db.select().from(academyCredits);
  }

  // --- Performance coin award ledger ---
  async insertCoinAwardIfAbsent(award: InsertCoinAward): Promise<boolean> {
    const rows = await db
      .insert(coinAwards)
      .values(award)
      .onConflictDoNothing({
        target: [coinAwards.userId, coinAwards.track, coinAwards.tier],
      })
      .returning({ id: coinAwards.id });
    return rows.length === 1;
  }

  async listCoinAwardsByUser(userId: number): Promise<CoinAward[]> {
    return db.select().from(coinAwards).where(eq(coinAwards.userId, userId)).orderBy(coinAwards.earnedAt);
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

  async listDemoSessionsByFingerprint(fingerprint: string): Promise<DemoSession[]> {
    return db.select().from(demoSessions).where(eq(demoSessions.deviceFingerprint, fingerprint));
  }

  async listDemoSessionsByIp(ip: string): Promise<DemoSession[]> {
    return db.select().from(demoSessions).where(eq(demoSessions.ipAddress, ip));
  }

  async createDemoPaidSession(data: InsertDemoPaidSession): Promise<DemoPaidSession> {
    const rows = await db.insert(demoPaidSessions).values(data).returning();
    return rows[0];
  }

  async getDemoPaidSessionByStripeCheckoutSessionId(id: string): Promise<DemoPaidSession | undefined> {
    const rows = await db
      .select()
      .from(demoPaidSessions)
      .where(eq(demoPaidSessions.stripeCheckoutSessionId, id));
    return rows[0];
  }

  async updateDemoPaidSession(id: number, patch: Partial<InsertDemoPaidSession>): Promise<DemoPaidSession | undefined> {
    const rows = await db.update(demoPaidSessions).set(patch).where(eq(demoPaidSessions.id, id)).returning();
    return rows[0];
  }

  async listDemoPaidSessionsBySignup(signupId: number): Promise<DemoPaidSession[]> {
    return db
      .select()
      .from(demoPaidSessions)
      .where(eq(demoPaidSessions.signupId, signupId))
      .orderBy(demoPaidSessions.id);
  }

  // The status = 'paid' predicate stays on the UPDATE itself (not just on the
  // subselect that picks the oldest credit), so if two requests race, the loser
  // matches no row and gets undefined rather than re-consuming the same credit.
  async claimOldestPaidDemoSession(signupId: number, demoSessionId: number): Promise<DemoPaidSession | undefined> {
    const oldestPaid = db
      .select({ id: demoPaidSessions.id })
      .from(demoPaidSessions)
      .where(and(eq(demoPaidSessions.signupId, signupId), eq(demoPaidSessions.status, "paid")))
      .orderBy(demoPaidSessions.id)
      .limit(1);
    const rows = await db
      .update(demoPaidSessions)
      .set({
        status: "consumed",
        consumedAt: new Date().toISOString(),
        consumedByDemoSessionId: demoSessionId,
      })
      .where(and(eq(demoPaidSessions.status, "paid"), inArray(demoPaidSessions.id, oldestPaid)))
      .returning();
    return rows[0];
  }

  // --- Message Coach ---
  async getMessageCoachSignupByEmail(email: string): Promise<MessageCoachSignup | undefined> {
    const rows = await db.select().from(messageCoachSignups).where(eq(messageCoachSignups.email, email));
    return rows[0];
  }

  async createMessageCoachSignup(data: InsertMessageCoachSignup): Promise<MessageCoachSignup> {
    const rows = await db.insert(messageCoachSignups).values(data).returning();
    return rows[0];
  }

  async updateMessageCoachSignup(id: number, patch: Partial<InsertMessageCoachSignup>): Promise<MessageCoachSignup | undefined> {
    const rows = await db.update(messageCoachSignups).set(patch).where(eq(messageCoachSignups.id, id)).returning();
    return rows[0];
  }

  // The IS NULL predicate stays on the UPDATE itself, not on a prior read, so a
  // race between two score requests for the same email produces one winner and
  // one undefined rather than two free scores.
  async claimFreeMessageCoachScore(id: number, usedAt: string): Promise<MessageCoachSignup | undefined> {
    const rows = await db
      .update(messageCoachSignups)
      .set({ freeScoreUsedAt: usedAt })
      .where(and(eq(messageCoachSignups.id, id), isNull(messageCoachSignups.freeScoreUsedAt)))
      .returning();
    return rows[0];
  }

  async createMessageCoachScore(data: InsertMessageCoachScore): Promise<MessageCoachScore> {
    const rows = await db.insert(messageCoachScores).values(data).returning();
    return rows[0];
  }

  async createMessageCoachPaidPurchase(data: InsertMessageCoachPaidPurchase): Promise<MessageCoachPaidPurchase> {
    const rows = await db.insert(messageCoachPaidPurchases).values(data).returning();
    return rows[0];
  }

  async getMessageCoachPaidPurchase(id: number): Promise<MessageCoachPaidPurchase | undefined> {
    const rows = await db.select().from(messageCoachPaidPurchases).where(eq(messageCoachPaidPurchases.id, id));
    return rows[0];
  }

  async getMessageCoachPaidPurchaseByStripeCheckoutSessionId(id: string): Promise<MessageCoachPaidPurchase | undefined> {
    const rows = await db
      .select()
      .from(messageCoachPaidPurchases)
      .where(eq(messageCoachPaidPurchases.stripeCheckoutSessionId, id));
    return rows[0];
  }

  async updateMessageCoachPaidPurchase(id: number, patch: Partial<InsertMessageCoachPaidPurchase>): Promise<MessageCoachPaidPurchase | undefined> {
    const rows = await db.update(messageCoachPaidPurchases).set(patch).where(eq(messageCoachPaidPurchases.id, id)).returning();
    return rows[0];
  }

  async listMessageCoachPaidPurchasesBySignup(signupId: number): Promise<MessageCoachPaidPurchase[]> {
    return db
      .select()
      .from(messageCoachPaidPurchases)
      .where(eq(messageCoachPaidPurchases.signupId, signupId))
      .orderBy(messageCoachPaidPurchases.id);
  }

  // The status = 'paid' predicate stays on the UPDATE itself, so if two requests
  // race quoting the same purchase, the loser matches no row and gets undefined
  // rather than spending the credit twice. Same shape as
  // claimOldestPaidDemoSession. consumedByScoreId is stamped afterwards, once the
  // score row it funded exists.
  async claimMessageCoachPaidPurchase(id: number): Promise<MessageCoachPaidPurchase | undefined> {
    const rows = await db
      .update(messageCoachPaidPurchases)
      .set({ status: "consumed", consumedAt: new Date().toISOString() })
      .where(and(eq(messageCoachPaidPurchases.id, id), eq(messageCoachPaidPurchases.status, "paid")))
      .returning();
    return rows[0];
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

  // --- Demo-activation drip ---
  async getDemoSignup(id: number): Promise<DemoSignup | undefined> {
    const rows = await db.select().from(demoSignups).where(eq(demoSignups.id, id));
    return rows[0];
  }

  async listDemoSessionsBySignup(signupId: number): Promise<DemoSession[]> {
    return db.select().from(demoSessions).where(eq(demoSessions.signupId, signupId)).orderBy(demoSessions.id);
  }

  async createDemoDripEmail(email: InsertDemoDripEmail): Promise<DemoDripEmail> {
    const rows = await db.insert(demoDripEmails).values(email).returning();
    return rows[0];
  }

  async listDueDemoDripEmails(nowIso: string): Promise<DemoDripEmail[]> {
    return db
      .select()
      .from(demoDripEmails)
      .where(and(eq(demoDripEmails.status, "scheduled"), lte(demoDripEmails.scheduledAt, nowIso)))
      .orderBy(demoDripEmails.id);
  }

  async listDemoDripEmailsBySignup(signupId: number): Promise<DemoDripEmail[]> {
    return db.select().from(demoDripEmails).where(eq(demoDripEmails.signupId, signupId)).orderBy(demoDripEmails.id);
  }

  async updateDemoDripEmail(id: number, patch: Partial<InsertDemoDripEmail>): Promise<DemoDripEmail | undefined> {
    const rows = await db.update(demoDripEmails).set(patch).where(eq(demoDripEmails.id, id)).returning();
    return rows[0];
  }

  // --- Monthly "Practice makes money!" lifecycle email ---
  async createMonthlyLifecycleEmail(email: InsertMonthlyLifecycleEmail): Promise<MonthlyLifecycleEmail> {
    const rows = await db.insert(monthlyLifecycleEmails).values(email).returning();
    return rows[0];
  }

  async listDueMonthlyLifecycleEmails(nowIso: string): Promise<MonthlyLifecycleEmail[]> {
    return db
      .select()
      .from(monthlyLifecycleEmails)
      .where(and(eq(monthlyLifecycleEmails.status, "scheduled"), lte(monthlyLifecycleEmails.scheduledAt, nowIso)))
      .orderBy(monthlyLifecycleEmails.id);
  }

  async listMonthlyLifecycleEmails(): Promise<MonthlyLifecycleEmail[]> {
    return db.select().from(monthlyLifecycleEmails).orderBy(monthlyLifecycleEmails.id);
  }

  async updateMonthlyLifecycleEmail(id: number, patch: Partial<InsertMonthlyLifecycleEmail>): Promise<MonthlyLifecycleEmail | undefined> {
    const rows = await db.update(monthlyLifecycleEmails).set(patch).where(eq(monthlyLifecycleEmails.id, id)).returning();
    return rows[0];
  }

  // --- One-click unsubscribe suppression ---
  async createEmailSuppression(suppression: InsertEmailSuppression): Promise<EmailSuppression> {
    const rows = await db
      .insert(emailSuppressions)
      .values(suppression)
      .onConflictDoNothing({ target: emailSuppressions.email })
      .returning();
    if (rows[0]) return rows[0];
    // Already suppressed: return the existing row so the caller stays idempotent.
    const existing = await db.select().from(emailSuppressions).where(eq(emailSuppressions.email, suppression.email));
    return existing[0];
  }

  async getEmailSuppression(email: string): Promise<EmailSuppression | undefined> {
    const rows = await db.select().from(emailSuppressions).where(eq(emailSuppressions.email, email));
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

  // --- Command Center alert acknowledgements ---
  async createAlertAcknowledgement(acknowledgement: InsertAlertAcknowledgement): Promise<AlertAcknowledgement> {
    const rows = await db.insert(alertAcknowledgements).values(acknowledgement).returning();
    return rows[0];
  }

  async listActiveAlertAcknowledgements(officeId: number): Promise<AlertAcknowledgement[]> {
    // An inactive alert is renewed by any newer completed session. A low-score
    // alert is renewed only by a newer scored completed session. Timestamps are
    // stored as ISO text across the application, so the comparison is ordered.
    return db
      .select()
      .from(alertAcknowledgements)
      .where(sql`
        ${alertAcknowledgements.officeId} = ${officeId}
        AND NOT EXISTS (
          SELECT 1
          FROM ${sessions}
          WHERE ${sessions.userId} = ${alertAcknowledgements.consultantId}
            AND ${sessions.status} = 'completed'
            AND ${sessions.completedAt} > ${alertAcknowledgements.acknowledgedAt}
            AND (
              ${alertAcknowledgements.reason} = 'inactive'
              OR (${alertAcknowledgements.reason} = 'lowScore' AND ${sessions.score} IS NOT NULL)
            )
        )
      `);
  }

  // --- Real Conversation Scoring (Phase 1) ---
  async createRealConversation(rc: InsertRealConversation): Promise<RealConversation> {
    const rows = await db.insert(realConversations).values(rc).returning();
    return rows[0];
  }

  async getRealConversation(id: number): Promise<RealConversation | undefined> {
    const rows = await db.select().from(realConversations).where(eq(realConversations.id, id));
    return rows[0];
  }

  async listRealConversationsByUser(userId: number): Promise<RealConversation[]> {
    return db
      .select()
      .from(realConversations)
      .where(eq(realConversations.submittedByUserId, userId))
      .orderBy(desc(realConversations.id));
  }

  async listRealConversationsBySubjectRep(subjectRepUserId: number): Promise<RealConversation[]> {
    return db
      .select()
      .from(realConversations)
      .where(eq(realConversations.subjectRepUserId, subjectRepUserId))
      .orderBy(desc(realConversations.id));
  }

  async listRealConversationsByOffice(officeId: number): Promise<RealConversation[]> {
    return db
      .select()
      .from(realConversations)
      .where(eq(realConversations.officeId, officeId))
      .orderBy(desc(realConversations.id));
  }

  // --- Deterministic scoring cache ---
  async getScoreCacheEntry(contentHash: string): Promise<ScoreCache | undefined> {
    const rows = await db.select().from(scoreCache).where(eq(scoreCache.contentHash, contentHash));
    return rows[0];
  }

  async createScoreCacheEntry(entry: InsertScoreCache): Promise<ScoreCache> {
    // onConflictDoNothing guards against a rare race: two identical
    // never-before-seen submissions computing their score concurrently would
    // otherwise throw a unique-constraint error on the second insert. On a
    // conflict, fall through and read back whichever row won the race so the
    // caller still gets a valid ScoreCache row.
    const rows = await db.insert(scoreCache).values(entry).onConflictDoNothing().returning();
    if (rows[0]) return rows[0];
    const existing = await this.getScoreCacheEntry(entry.contentHash);
    if (existing) return existing;
    throw new Error("Failed to create or read back score cache entry");
  }

  // --- Self-serve office setup ---
  async createOfficeSetupToken(token: InsertOfficeSetupToken): Promise<OfficeSetupToken> {
    const rows = await db.insert(officeSetupTokens).values(token).returning();
    return rows[0];
  }

  async getOfficeSetupToken(token: string): Promise<OfficeSetupToken | undefined> {
    const rows = await db.select().from(officeSetupTokens).where(eq(officeSetupTokens.token, token));
    return rows[0];
  }

  async updateOfficeSetupToken(id: number, patch: Partial<InsertOfficeSetupToken>): Promise<OfficeSetupToken | undefined> {
    const rows = await db.update(officeSetupTokens).set(patch).where(eq(officeSetupTokens.id, id)).returning();
    return rows[0];
  }

  async createPaidOfficeSignup(signup: InsertPaidOfficeSignup): Promise<PaidOfficeSignup> {
    const rows = await db.insert(paidOfficeSignups).values(signup).returning();
    return rows[0];
  }

  async listPaidOfficeSignups(): Promise<PaidOfficeSignup[]> {
    return db.select().from(paidOfficeSignups).orderBy(desc(paidOfficeSignups.id));
  }

  async getOfficeSignupByEmail(email: string): Promise<OfficeSignup | undefined> {
    const rows = await db.select().from(officeSignups).where(eq(officeSignups.email, email));
    return rows[0];
  }

  async getOfficeSignup(id: number): Promise<OfficeSignup | undefined> {
    const rows = await db.select().from(officeSignups).where(eq(officeSignups.id, id));
    return rows[0];
  }

  async createOfficeSignup(signup: InsertOfficeSignup): Promise<OfficeSignup> {
    const rows = await db.insert(officeSignups).values(signup).returning();
    return rows[0];
  }

  async updateOfficeSignup(id: number, patch: Partial<InsertOfficeSignup>): Promise<OfficeSignup | undefined> {
    const rows = await db.update(officeSignups).set(patch).where(eq(officeSignups.id, id)).returning();
    return rows[0];
  }
}

export const storage = new DatabaseStorage();
