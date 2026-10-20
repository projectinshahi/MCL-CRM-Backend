import { hash } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { seed } from "../prisma/seed.ts";
import { createApp } from "../src/app.ts";
import { notificationsSettled } from "../src/lib/notify.ts";
import type { PermissionCode } from "../src/lib/permissions.ts";
import { prisma } from "../src/lib/prisma.ts";

export const hasDb = Boolean(process.env.TEST_DATABASE_URL);
export const ORIGIN = "http://localhost:3001";
export const API = "/api/v1";
export const app = createApp();
export { prisma };

const TABLES = [
  "audit_logs", "notifications", "customer_activities", "customer_attachments", "customers", "reminders", "follow_ups", "lead_activities", "lead_attachments", "leads",
  "lead_statuses", "lead_sources", "password_resets", "sessions", "users", "role_permissions", "roles", "permissions",
];

export async function resetDb() {
  await notificationsSettled(); // the previous test's background saves land before their users are wiped
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await seed(prisma);
}

export const PASSWORD = "Correct-Horse-9";
const passwordHash = hash(PASSWORD); // hashed once, reused by every test user

export async function makeUser(permissions: PermissionCode[], opts: { name?: string; status?: "active" | "inactive" } = {}) {
  const tag = randomUUID().slice(0, 8);
  const role = await prisma.role.create({
    data: { name: `role-${tag}`, permissions: { create: permissions.map((permissionCode) => ({ permissionCode })) } },
  });
  const user = await prisma.user.create({
    data: { name: opts.name ?? `User ${tag}`, email: `user-${tag}@test.local`, passwordHash: await passwordHash, roleId: role.id, status: opts.status ?? "active" },
  });
  return { user, role, email: user.email };
}

/** A supertest agent that keeps the session cookie and sends the frontend Origin on every request. */
export async function login(email: string, password = PASSWORD) {
  const agent = request.agent(app).set("Origin", ORIGIN);
  const res = await agent.post(`${API}/auth/login`).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function signedIn(permissions: PermissionCode[], opts?: { name?: string }) {
  const u = await makeUser(permissions, opts);
  return { ...u, agent: await login(u.email) };
}

export const ALL: PermissionCode[] = ["dashboard", "leads", "customers", "follow_ups", "users", "notifications", "calculator", "modules", "settings", "all_records"];

export async function statusByName(name: string) {
  return prisma.leadStatus.findFirstOrThrow({ where: { name } });
}
export async function sourceByName(name: string) {
  return prisma.leadSource.findFirstOrThrow({ where: { name } });
}
