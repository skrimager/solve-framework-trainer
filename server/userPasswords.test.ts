import { describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";

import { seedDemoUsers } from "./seed";
import {
  DEMO_USER_ACCOUNTS,
  isBcryptHash,
  migratePlaintextUserPasswords,
} from "./userPasswords";

type PasswordRow = { id: number; password: string };

function inMemoryPasswordStore(rows: PasswordRow[]) {
  return {
    listUsers: async () => rows as any,
    updateUser: async (id: number, patch: { password?: string }) => {
      const row = rows.find((user) => user.id === id);
      if (!row) return undefined;
      if (patch.password !== undefined) row.password = patch.password;
      return row as any;
    },
  };
}

describe("user password migration", () => {
  test("migrates all four demo credentials with bcrypt and remains idempotent", async () => {
    const rows = DEMO_USER_ACCOUNTS.map((account, index) => ({
      id: index + 1,
      password: account.password,
    }));
    const store = inMemoryPasswordStore(rows);

    const firstRun = await migratePlaintextUserPasswords(store);
    assert.deepEqual(firstRun, { migrated: 4, alreadyHashed: 0 });

    const verification: string[] = [];
    for (const account of DEMO_USER_ACCOUNTS) {
      const row = rows[DEMO_USER_ACCOUNTS.indexOf(account)];
      assert.equal(isBcryptHash(row.password), true);
      assert.match(row.password, /^\$2[aby]\$12\$/);
      const authenticates = await bcrypt.compare(account.password, row.password);
      assert.equal(authenticates, true);
      verification.push(`${account.username}/${account.password}=${authenticates}`);
    }
    console.log(`[demo-credential-verification] ${verification.join("; ")}`);

    const passwordsAfterFirstRun = rows.map((row) => row.password);
    const secondRun = await migratePlaintextUserPasswords(store);
    assert.deepEqual(secondRun, { migrated: 0, alreadyHashed: 4 });
    assert.deepEqual(
      rows.map((row) => row.password),
      passwordsAfterFirstRun,
      "a second migration run must not double-hash existing bcrypt values",
    );
  });

  test("leaves a pre-existing bcrypt hash unchanged", async () => {
    const existingHash = await bcrypt.hash("already-secure", 12);
    const rows = [{ id: 1, password: existingHash }];

    const result = await migratePlaintextUserPasswords(inMemoryPasswordStore(rows));

    assert.deepEqual(result, { migrated: 0, alreadyHashed: 1 });
    assert.equal(rows[0].password, existingHash);
    assert.equal(await bcrypt.compare("already-secure", rows[0].password), true);
  });
});

test("fresh demo seeding stores bcrypt hashes that preserve every saved credential", async () => {
  const seeded: Array<{ username: string; password: string }> = [];
  await seedDemoUsers(99, {
    createUser: async (user) => {
      seeded.push({ username: user.username, password: user.password });
      return undefined;
    },
  });

  assert.equal(seeded.length, 4);
  for (const account of DEMO_USER_ACCOUNTS) {
    const user = seeded.find((candidate) => candidate.username === account.username);
    assert.ok(user);
    assert.match(user.password, /^\$2[aby]\$12\$/);
    assert.equal(await bcrypt.compare(account.password, user.password), true);
  }
});
