import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import bcrypt from "bcrypt";

import { registerUserAuthRoutes } from "./routes";
import { storage } from "./storage";

type TestUser = {
  id: number;
  officeId: number;
  username: string;
  password: string;
  role: string;
  displayName: string;
  currentLevel: string;
  leadershipLevel: string;
  seatActive: boolean;
  seatActivatedAt: null;
  isDemoAccount: boolean;
  consultingCertified: boolean;
  consultingCertifiedAt: null;
  leadershipCertified: boolean;
  leadershipCertifiedAt: null;
};

describe("user password HTTP flows", () => {
  let server: Server;
  let baseUrl: string;
  let users: TestUser[];
  let nextUserId: number;
  let nextOfficeId: number;

  before(async () => {
    const app = express();
    app.use(express.json());
    registerUserAuthRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.close();
  });

  beforeEach(() => {
    users = [];
    nextUserId = 1;
    nextOfficeId = 1;

    (storage as any).getUserByUsername = async (username: string) =>
      users.find((user) => user.username === username);
    (storage as any).createOffice = async (input: any) => ({
      id: nextOfficeId++,
      ...input,
      subscriptionStatus: "active",
      status: input.status ?? "active",
      managerItemId: null,
      seatItemId: null,
      activeSeatCount: 0,
    });
    (storage as any).getOfficeByInviteCode = async (inviteCode: string) => {
      if (inviteCode !== "ACTIVE123") return undefined;
      return {
        id: 22,
        name: "Active Office",
        inviteCode,
        createdAt: "2026-01-01",
        status: "active",
        subscriptionStatus: "active",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        managerItemId: null,
        seatItemId: null,
        activeSeatCount: 0,
        archivedAt: null,
      };
    };
    (storage as any).createUser = async (input: any) => {
      const user: TestUser = {
        id: nextUserId++,
        leadershipLevel: "beginner",
        seatActive: false,
        seatActivatedAt: null,
        isDemoAccount: false,
        consultingCertified: false,
        consultingCertifiedAt: null,
        leadershipCertified: false,
        leadershipCertifiedAt: null,
        ...input,
      };
      users.push(user);
      return user;
    };
  });

  test("manager registration stores only a cost-12 bcrypt hash", async () => {
    const response = await fetch(`${baseUrl}/api/register/manager`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        officeName: "Acme",
        username: "manager-new",
        password: "manager-secret",
        displayName: "Manager New",
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(users.length, 1);
    assert.match(users[0].password, /^\$2[aby]\$12\$/);
    assert.equal(await bcrypt.compare("manager-secret", users[0].password), true);
    assert.notEqual(users[0].password, "manager-secret");
  });

  test("consultant registration stores only a cost-12 bcrypt hash", async () => {
    const response = await fetch(`${baseUrl}/api/register/consultant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "ACTIVE123",
        username: "consultant-new",
        password: "consultant-secret",
        displayName: "Consultant New",
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(users.length, 1);
    assert.match(users[0].password, /^\$2[aby]\$12\$/);
    assert.equal(await bcrypt.compare("consultant-secret", users[0].password), true);
    assert.notEqual(users[0].password, "consultant-secret");
  });

  test("login accepts the right password by bcrypt comparison", async () => {
    users.push({
      id: 1,
      officeId: 1,
      username: "login-user",
      password: await bcrypt.hash("right-password", 12),
      role: "consultant",
      displayName: "Login User",
      currentLevel: "beginner",
      leadershipLevel: "beginner",
      seatActive: false,
      seatActivatedAt: null,
      isDemoAccount: false,
      consultingCertified: false,
      consultingCertifiedAt: null,
      leadershipCertified: false,
      leadershipCertifiedAt: null,
    });

    const response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "login-user", password: "right-password" }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).username, "login-user");
  });

  test("login rejects a wrong password", async () => {
    users.push({
      id: 1,
      officeId: 1,
      username: "login-user",
      password: await bcrypt.hash("right-password", 12),
      role: "consultant",
      displayName: "Login User",
      currentLevel: "beginner",
      leadershipLevel: "beginner",
      seatActive: false,
      seatActivatedAt: null,
      isDemoAccount: false,
      consultingCertified: false,
      consultingCertifiedAt: null,
      leadershipCertified: false,
      leadershipCertifiedAt: null,
    });

    const response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "login-user", password: "wrong-password" }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "Invalid username or password" });
  });
});
