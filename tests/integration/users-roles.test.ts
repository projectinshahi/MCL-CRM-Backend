import { beforeEach, describe, expect, it } from "vitest";
import { API, hasDb, login, makeUser, PASSWORD, prisma, resetDb, signedIn } from "../helpers.ts";

const adminRole = () => prisma.role.findUniqueOrThrow({ where: { name: "Admin" } });

describe.skipIf(!hasDb)("users", () => {
  beforeEach(resetDb);

  it("creates a user with an admin-set password who can then sign in", async () => {
    const { agent } = await signedIn(["users"]);
    const role = await adminRole();
    const res = await agent.post(`${API}/users`).send({ name: "Praveen", email: "Praveen@Example.com", phone: "9876543210", roleId: role.id, password: "Initial-Pass-1" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Praveen", email: "praveen@example.com", status: "active", role: { id: role.id }, assignedLeads: 0 });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    await login("praveen@example.com", "Initial-Pass-1");
  });

  it("validates email uniqueness, role references and unknown fields", async () => {
    const { agent, email } = await signedIn(["users"]);
    const role = await adminRole();
    const base = { name: "X", phone: null, roleId: role.id, password: "Initial-Pass-1" };
    expect((await agent.post(`${API}/users`).send({ ...base, email: email.toUpperCase() })).body.error.code).toBe("EMAIL_TAKEN");
    expect((await agent.post(`${API}/users`).send({ ...base, email: "n@test.local", roleId: "00000000-0000-4000-8000-000000000000" })).body.error.fields).toHaveProperty("roleId");
    const extra = await agent.post(`${API}/users`).send({ ...base, email: "m@test.local", status: "inactive" });
    expect(extra.status).toBe(422);
    expect((await agent.post(`${API}/users`).send({ ...base, email: "short@test.local", password: "short" })).body.error.fields).toHaveProperty("password");
  });

  it("stores phones as E.164, refuses invalid ones and keeps an untouched legacy value", async () => {
    const { agent } = await signedIn(["users"]);
    const base = { roleId: (await adminRole()).id, password: "Initial-Pass-1" };
    const uk = await agent.post(`${API}/users`).send({ ...base, name: "UK", email: "uk@test.local", phone: "+44 20 7031 3000" });
    expect(uk.status).toBe(201);
    expect(uk.body.phone).toBe("+442070313000");
    const india = await agent.post(`${API}/users`).send({ ...base, name: "IN", email: "in@test.local", phone: "81234-56789" });
    expect(india.body.phone).toBe("+918123456789"); // no "+": read as DEFAULT_PHONE_COUNTRY (IN)
    // Calling the API directly gets the same checks as the form, on create and on update.
    const bad = await agent.post(`${API}/users`).send({ ...base, name: "Bad", email: "bad@test.local", phone: "+91 81234" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toEqual({ phone: "This number appears incomplete." });
    const badUpdate = await agent.patch(`${API}/users/${uk.body.id}`).send({ phone: "+999 1234567" });
    expect(badUpdate.body.error.fields).toEqual({ phone: "Please check the country code and number." });
    // A value saved before this validation existed survives edits to other fields, and can be corrected or cleared.
    await prisma.user.update({ where: { id: uk.body.id }, data: { phone: "12345" } });
    expect((await agent.patch(`${API}/users/${uk.body.id}`).send({ name: "UK renamed" })).body).toMatchObject({ name: "UK renamed", phone: "12345" });
    expect((await agent.patch(`${API}/users/${uk.body.id}`).send({ phone: "020 7031 3000" })).body.phone).toBe("+912070313000"); // no "+": read as India
    expect((await agent.patch(`${API}/users/${uk.body.id}`).send({ phone: "+44 20 7031 3000" })).body.phone).toBe("+442070313000");
    expect((await agent.patch(`${API}/users/${uk.body.id}`).send({ phone: "" })).body.phone).toBeNull();
  });

  it("edit: the password is optional; blank keeps it, a valid one replaces it, an invalid one changes nothing", async () => {
    const { agent } = await signedIn(["users"]);
    const target = await makeUser(["leads"]);
    const targetSession = await login(target.email); // the edited user is signed in somewhere
    const hashOf = async () => (await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).passwordHash;
    const original = await hashOf();
    const url = `${API}/users/${target.user.id}`;

    // Profile edits without a password (left out, "" or null) touch neither the password nor the user's sessions.
    for (const extra of [{}, { password: "" }, { password: null }]) expect((await agent.patch(url).send({ name: "Renamed", ...extra })).status).toBe(200);
    expect(await hashOf()).toBe(original);
    expect((await targetSession.get(`${API}/auth/me`)).status).toBe(200);

    // Invalid: refused, and nothing else in the same request is applied either.
    const bad = await agent.patch(url).send({ name: "Should not stick", password: "short" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toEqual({ password: "Use at least 8 characters" });
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
    expect([unchanged.name, unchanged.passwordHash]).toEqual(["Renamed", original]);

    // Valid: a new argon2 hash, never echoed back; old password fails, new one signs in, old sessions end.
    const ok = await agent.patch(url).send({ password: "Brand-New-Pass-1" });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/password|Brand-New-Pass-1|argon2/i);
    const changed = await hashOf();
    expect(changed).not.toBe(original);
    expect(changed).toMatch(/^\$argon2/);
    expect((await targetSession.get(`${API}/auth/me`)).status).toBe(401);
    await expect(login(target.email, PASSWORD)).rejects.toThrow(/401/);
    await login(target.email, "Brand-New-Pass-1");
    const audits = await prisma.auditLog.findMany({ where: { entityId: target.user.id } });
    expect(audits.map((a) => a.action)).toContain("user_password_changed");
    expect(JSON.stringify(audits.map((a) => [a.before, a.after]))).not.toMatch(/Brand-New-Pass-1|argon2/);
  });

  it("admins changing their own password stay signed in on this device; their other sessions end", async () => {
    const self = await signedIn(["users"]);
    const otherDevice = await login(self.email);
    expect((await self.agent.patch(`${API}/users/${self.user.id}`).send({ password: "My-New-Pass-123" })).status).toBe(200);
    expect((await self.agent.get(`${API}/auth/me`)).status).toBe(200);
    expect((await otherDevice.get(`${API}/auth/me`)).status).toBe(401);
  });

  it("only users with the Users permission can set someone's password", async () => {
    const { agent } = await signedIn(["leads", "dashboard"]);
    const target = await makeUser(["leads"]);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).passwordHash;
    expect((await agent.patch(`${API}/users/${target.user.id}`).send({ password: "Takeover-Pass-1" })).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).passwordHash).toBe(before);
  });

  it("lists with search, filters and per-user lead counts", async () => {
    const { agent } = await signedIn(["users"], { name: "Admin Person" });
    const sales = await makeUser(["leads"], { name: "Sales Person" });
    const won = await prisma.leadStatus.findFirstOrThrow({ where: { isWon: true } });
    const fresh = await prisma.leadStatus.findFirstOrThrow({ where: { name: "New" } });
    for (const statusId of [won.id, fresh.id])
      await prisma.lead.create({ data: { title: "L", statusId, ownerId: sales.user.id, createdById: sales.user.id } });

    const res = await agent.get(`${API}/users`).query({ q: "sales" });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ name: "Sales Person", assignedLeads: 2, convertedLeads: 1 });
    expect((await agent.get(`${API}/users`).query({ status: "inactive" })).body.total).toBe(0);
  });

  it("deactivating a user revokes their sessions and blocks sign-in", async () => {
    const { agent } = await signedIn(["users"]);
    const target = await signedIn(["leads"]);
    expect((await agent.patch(`${API}/users/${target.user.id}`).send({ status: "inactive" })).status).toBe(200);
    expect((await target.agent.get(`${API}/leads`)).status).toBe(401);
    await expect(login(target.email)).rejects.toThrow(/403/);
  });

  it("protects the caller's own account and the last administrator", async () => {
    const admin = await signedIn(["users"]);
    expect((await admin.agent.patch(`${API}/users/${admin.user.id}`).send({ status: "inactive" })).body.error.code).toBe("CANNOT_DEACTIVATE_SELF");
    expect((await admin.agent.delete(`${API}/users/${admin.user.id}`)).body.error.code).toBe("CANNOT_DELETE_SELF");

    const plain = await makeUser(["leads"]);
    const demote = await admin.agent.patch(`${API}/users/${admin.user.id}`).send({ roleId: plain.role.id });
    expect(demote.body.error.code).toBe("LAST_ADMIN");
    const strip = await admin.agent.patch(`${API}/roles/${admin.role.id}`).send({ permissions: ["leads"] });
    expect(strip.body.error.code).toBe("LAST_ADMIN");
    // rolled back: still an admin
    expect((await admin.agent.get(`${API}/users`)).status).toBe(200);
  });

  it("hard-deletes an unused account but only deactivates one with history", async () => {
    const { agent } = await signedIn(["users"]);
    const unused = await makeUser(["leads"]);
    const used = await makeUser(["leads"]);
    await login(used.email); // leaves an audit trail that references the user

    expect((await agent.delete(`${API}/users/${unused.user.id}`)).status).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: unused.user.id } })).toBeNull();

    expect((await agent.delete(`${API}/users/${used.user.id}`)).status).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: used.user.id } })).status).toBe("inactive");
  });

  it("offers only active users as assignees", async () => {
    const { agent } = await signedIn(["leads"], { name: "Me" });
    await makeUser(["leads"], { name: "Gone", status: "inactive" });
    const names = (await agent.get(`${API}/users/options`)).body.map((u: { name: string }) => u.name);
    expect(names).toContain("Me");
    expect(names).not.toContain("Gone");
  });
});

describe.skipIf(!hasDb)("roles and permissions", () => {
  beforeEach(resetDb);

  it("lists the 10-code permission catalogue in sidebar order, All Records last", async () => {
    const { agent } = await signedIn(["users"]);
    const list = (await agent.get(`${API}/permissions`)).body as { code: string; label: string }[];
    expect(list.map((p) => p.code)).toEqual(["dashboard", "leads", "customers", "follow_ups", "users", "notifications", "calculator", "modules", "settings", "all_records"]);
    expect(list.find((p) => p.code === "modules")?.label).toBe("Modules");
    // A role can be given Modules like any other page.
    const role = await agent.post(`${API}/roles`).send({ name: "Modules only", permissions: ["modules"] });
    expect(role.status).toBe(201);
    expect(role.body.permissions).toEqual(["modules"]);
  });

  it("creates, renames and deletes roles with validation", async () => {
    const { agent } = await signedIn(["users"]);
    const created = await agent.post(`${API}/roles`).send({ name: "BDE", permissions: ["leads", "follow_ups", "leads"] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "BDE", permissions: ["leads", "follow_ups"], userCount: 0, members: [] });

    expect((await agent.post(`${API}/roles`).send({ name: "bde", permissions: [] })).body.error.code).toBe("ROLE_NAME_TAKEN");
    expect((await agent.post(`${API}/roles`).send({ name: "X", permissions: ["root"] })).status).toBe(422);

    const renamed = await agent.patch(`${API}/roles/${created.body.id}`).send({ name: "Sales" });
    expect(renamed.body.name).toBe("Sales");
    expect((await agent.delete(`${API}/roles/${created.body.id}`)).status).toBe(204);
  });

  it("refuses to delete a role that still has users, and shows member previews", async () => {
    const { agent } = await signedIn(["users"]);
    const member = await makeUser(["leads"], { name: "Aravind Nair" });
    const roles = (await agent.get(`${API}/roles`)).body as { id: string; userCount: number; members: { initials: string }[] }[];
    expect(roles.find((r) => r.id === member.role.id)).toMatchObject({ userCount: 1, members: [{ initials: "AN" }] });
    expect((await agent.delete(`${API}/roles/${member.role.id}`)).body.error.code).toBe("ROLE_IN_USE");
  });

  it("applies a permission change on the user's very next request", async () => {
    const { agent } = await signedIn(["users"]);
    const target = await signedIn(["leads"]);
    expect((await target.agent.get(`${API}/leads`)).status).toBe(200);
    await agent.patch(`${API}/roles/${target.role.id}`).send({ permissions: ["dashboard"] });
    expect((await target.agent.get(`${API}/leads`)).status).toBe(403);
  });

  it("still lets the admin-set password survive a role change", async () => {
    const { agent } = await signedIn(["users"]);
    const target = await makeUser(["leads"]);
    const other = await makeUser(["dashboard"]);
    await agent.patch(`${API}/users/${target.user.id}`).send({ roleId: other.role.id });
    await login(target.email, PASSWORD);
  });
});
