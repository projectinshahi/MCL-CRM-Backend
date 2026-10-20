import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { PermissionCode } from "../../src/lib/permissions.ts";
import { ALL, API, app, hasDb, ORIGIN, resetDb, signedIn } from "../helpers.ts";

const ID = "00000000-0000-4000-8000-000000000000";

// Every protected endpoint and the page permission(s) it declares. null = any signed-in user.
const ENDPOINTS: [method: "get" | "post" | "patch" | "delete", path: string, permissions: PermissionCode[] | null][] = [
  ["get", "/users", ["users"]],
  ["post", "/users", ["users"]],
  ["patch", `/users/${ID}`, ["users"]],
  ["delete", `/users/${ID}`, ["users"]],
  ["get", "/users/options", ["leads", "follow_ups", "customers"]],
  ["get", "/roles", ["users"]],
  ["post", "/roles", ["users"]],
  ["patch", `/roles/${ID}`, ["users"]],
  ["delete", `/roles/${ID}`, ["users"]],
  ["get", "/permissions", ["users"]],
  ["get", "/leads", ["leads"]],
  ["post", "/leads", ["leads"]],
  ["get", "/leads/pipeline", ["leads"]],
  ["get", `/leads/${ID}`, ["leads"]],
  ["patch", `/leads/${ID}`, ["leads"]],
  ["delete", `/leads/${ID}`, ["leads"]],
  ["post", `/leads/${ID}/assign`, ["leads"]],
  ["get", `/leads/${ID}/activities`, ["leads"]],
  ["post", `/leads/${ID}/reminders`, ["leads"]],
  ["get", "/follow-ups", ["follow_ups"]],
  ["post", "/follow-ups", ["follow_ups"]],
  ["post", `/follow-ups/${ID}/complete`, ["follow_ups"]],
  ["get", "/follow-ups/history", ["follow_ups"]],
  ["get", "/lookups/lead-contacts", ["follow_ups"]],
  ["get", "/customers", ["customers"]],
  ["delete", `/customers/${ID}`, ["customers"]],
  ["get", `/customers/${ID}`, ["customers"]],
  ["patch", `/customers/${ID}`, ["customers"]],
  ["get", `/customers/${ID}/activities`, ["customers"]],
  ["post", `/customers/${ID}/activities`, ["customers"]],
  ["post", `/customers/${ID}/attachments`, ["customers"]],
  ["get", `/customers/${ID}/attachments/${ID}`, ["customers"]],
  ["delete", `/customers/${ID}/attachments/${ID}`, ["customers"]],
  ["get", "/dashboard/summary", ["dashboard"]],
  ["get", "/notifications", ["notifications"]],
  ["get", "/notifications/unread", ["notifications"]],
  ["post", `/notifications/${ID}/read`, ["notifications"]],
  ["delete", `/notifications/${ID}`, ["notifications"]],
  ["delete", "/notifications", ["notifications"]],
  ["post", "/settings/lead-sources", ["settings"]],
  ["delete", `/settings/lead-sources/${ID}`, ["settings"]],
  ["post", "/settings/lead-statuses", ["settings"]],
  ["delete", `/settings/lead-statuses/${ID}`, ["settings"]],
  ["get", "/settings/lead-sources", null],
  ["get", "/settings/lead-statuses", null],
  ["get", "/auth/me", null],
];

describe.skipIf(!hasDb)("server-side permission enforcement", () => {
  beforeAll(resetDb);

  it.each(ENDPOINTS)("%s %s rejects anonymous callers with 401", async (method, path) => {
    const res = await request(app)[method](`${API}${path}`).set("Origin", ORIGIN).send({});
    expect(res.status).toBe(401);
  });

  it.each(ENDPOINTS.filter(([, , p]) => p !== null))("%s %s returns 403 without %j and passes with it", async (method, path, perms) => {
    const without = await signedIn(ALL.filter((p) => !perms!.includes(p)));
    const denied = await without.agent[method](`${API}${path}`).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");

    const withIt = await signedIn([perms![0]!]);
    const allowed = await withIt.agent[method](`${API}${path}`).send({});
    expect([401, 403]).not.toContain(allowed.status); // 200 / 404 / 422 … the permission gate let it through
  });
});
