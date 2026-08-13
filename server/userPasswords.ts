import bcrypt from "bcrypt";
import type { InsertUser, User } from "@shared/schema";

// bcrypt's work factor deliberately makes each credential guess expensive.
// Keep this at 12 or higher for all user-account password writes.
export const BCRYPT_SALT_ROUNDS = 12;

// Supports bcrypt variants accepted by bcrypt itself. The migration uses this
// to avoid re-hashing credentials that were already migrated on an earlier run.
const BCRYPT_HASH_PREFIX = /^\$2[aby]\$/;

export const DEMO_USER_ACCOUNTS = [
  {
    username: "manager",
    password: "manager123",
    role: "manager",
    displayName: "Manager Demo",
  },
  {
    username: "consultant",
    password: "consultant123",
    role: "consultant",
    displayName: "Consultant Demo",
  },
  {
    username: "qa_taylor",
    password: "qatest123",
    role: "qa",
    displayName: "Taylor (QA)",
  },
  {
    username: "qa_morgan",
    password: "qatest123",
    role: "qa",
    displayName: "Morgan (QA)",
  },
] as const;

export function isBcryptHash(value: string): boolean {
  return BCRYPT_HASH_PREFIX.test(value);
}

export async function hashUserPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export async function compareUserPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

type UserPasswordRow = Pick<User, "id" | "password">;

export type UserPasswordMigrationStore = {
  listUsers(): Promise<UserPasswordRow[]>;
  updateUser(id: number, patch: Partial<InsertUser>): Promise<User | undefined>;
};

export type UserPasswordMigrationResult = {
  migrated: number;
  alreadyHashed: number;
};

// Re-hash every legacy plaintext credential in the users table. This intentionally
// takes an injected store so the exact database operation can be tested without a
// database, and so repeated startup runs are safe.
export async function migratePlaintextUserPasswords(
  store: UserPasswordMigrationStore,
): Promise<UserPasswordMigrationResult> {
  let migrated = 0;
  let alreadyHashed = 0;

  for (const user of await store.listUsers()) {
    if (isBcryptHash(user.password)) {
      alreadyHashed++;
      continue;
    }

    await store.updateUser(user.id, { password: await hashUserPassword(user.password) });
    migrated++;
  }

  return { migrated, alreadyHashed };
}
