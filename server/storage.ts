import { users, scenarios, sessions, offices } from '@shared/schema';
import type { User, InsertUser, Scenario, InsertScenario, Session, InsertSession, Office, InsertOffice } from '@shared/schema';
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, inArray } from "drizzle-orm";

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

  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, patch: Partial<InsertUser>): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  listUsersByOffice(officeId: number): Promise<User[]>;

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
}

export const storage = new DatabaseStorage();
