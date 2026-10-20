import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, indiaDate, parseDateOnly, todayIST } from "../../src/lib/format.ts";
import { notificationsSettled } from "../../src/lib/notify.ts";
import type { PermissionCode } from "../../src/lib/permissions.ts";
import { LOOKBACK_DAYS, sendDueReminders } from "../../src/modules/notifications/reminders.ts";
import { ALL, API, hasDb, login, makeUser, prisma, resetDb, signedIn, statusByName } from "../helpers.ts";

// Staff: their own leads and follow-ups, no Customers, no All records, no Users (so not an administrator).
const STAFF: PermissionCode[] = ["leads", "follow_ups", "notifications"];

type Reader = { email: string; agent?: Awaited<ReturnType<typeof login>> };
type Item = { title: string; detail: string | null; link: string | null };

/**
 * What `who` reads on their Notifications page, through the API as them (background saves finished first): stored,
 * returned and decided by their access, in a stable order.
 */
async function inbox(who: Reader) {
  await notificationsSettled();
  who.agent ??= await login(who.email);
  const res = await who.agent.get(`${API}/notifications`).query({ pageSize: 100 });
  expect(res.status).toBe(200);
  return (res.body.items as Item[])
    .map(({ title, detail, link }) => ({ title, detail, link }))
    .sort((a, b) => a.title.localeCompare(b.title) || (a.detail ?? "").localeCompare(b.detail ?? ""));
}
const titles = async (who: Reader) => (await inbox(who)).map((n) => n.title);
const stored = async (userId: string) => {
  await notificationsSettled();
  return prisma.notification.count({ where: { userId, deletedAt: null } });
};
const grant = (roleId: string, ...codes: PermissionCode[]) => prisma.rolePermission.createMany({ data: codes.map((permissionCode) => ({ roleId, permissionCode })), skipDuplicates: true });

describe.skipIf(!hasDb)("notifications: who is told what", () => {
  beforeEach(resetDb);

  it("administrators hear of a staff member's new lead; the staff member, who made it, does not", async () => {
    const admin = await makeUser(ALL);
    const staff = await signedIn(STAFF, { name: "Sam Staff" });
    const res = await staff.agent.post(`${API}/leads`).send({ title: "Air freight to Dubai", contact: { name: "Ravi" } });
    expect(res.status).toBe(201);
    expect(await inbox(admin)).toEqual([{ title: "New lead: Air freight to Dubai", detail: "Created by Sam Staff, together with its customer", link: `/leads/${res.body.id}` }]);
    expect(await inbox(staff)).toEqual([]);
  });

  it("every administrator is told; one who can't open the lead reads the event without its name or a link", async () => {
    const full = await makeUser(ALL);
    const usersOnly = await makeUser(["users", "notifications"]); // an admin without Leads
    const noFeed = await makeUser(["users", "leads"]); // an admin without the Notifications page
    const staff = await signedIn(STAFF, { name: "Sam" });
    await staff.agent.post(`${API}/leads`).send({ title: "Secret deal", contact: { name: "Ravi" } });
    expect(await titles(full)).toEqual(["New lead: Secret deal"]);
    expect(await inbox(usersOnly)).toEqual([{ title: "New lead", detail: "Created by Sam, together with its customer", link: null }]);
    // Stored for the admin without the page, who can't read it until their role gets it (and still can't open
    // another user's lead without All records).
    const noFeedReader: Reader = { email: noFeed.email, agent: await login(noFeed.email) };
    expect((await noFeedReader.agent!.get(`${API}/notifications`)).status).toBe(403);
    expect(await stored(noFeed.user.id)).toBe(1);
    await grant(noFeed.role.id, "notifications");
    expect(await inbox(noFeedReader)).toEqual([{ title: "New lead", detail: "Created by Sam, together with its customer", link: null }]);
  });

  it("the reported case: an assignee whose role lacked Notifications and Leads when it happened sees it, in full, once given them", async () => {
    // As in the database: a role with only Modules; the admin creates a lead for one of its users, reassigns it to
    // another, and only then gives the role Leads, Follow-ups and Notifications.
    const admin = await signedIn(ALL, { name: "Admin" });
    const gm1 = await makeUser(["modules"], { name: "GM One" });
    const gm2 = await makeUser(["modules"], { name: "GM Two" });
    await prisma.user.update({ where: { id: gm2.user.id }, data: { roleId: gm1.role.id } }); // one shared role
    const lead = (await admin.agent.post(`${API}/leads`).send({ title: "Kochi to Dubai", contact: { name: "Ravi" }, ownerId: gm1.user.id })).body;
    expect((await admin.agent.patch(`${API}/leads/${lead.id}`).send({ ownerId: gm2.user.id, version: lead.version })).status).toBe(200);
    expect([await stored(gm1.user.id), await stored(gm2.user.id)]).toEqual([1, 1]);

    await grant(gm1.role.id, "leads", "follow_ups", "notifications");
    // The current owner reads it with the lead's name and can open it; the first owner, who no longer holds the lead,
    // reads only that it happened.
    expect(await inbox(gm2)).toEqual([{ title: "Lead assigned to you: Kochi to Dubai", detail: "Assigned by Admin", link: `/leads/${lead.id}` }]);
    expect(await inbox(gm1)).toEqual([{ title: "Lead assigned to you", detail: "Created by Admin", link: null }]);
  });

  it("a retried create and a refused one notify nobody (again)", async () => {
    const admin = await makeUser(ALL);
    const staff = await signedIn(STAFF);
    const body = { id: randomUUID(), title: "Only once", contact: { name: "Ravi" } };
    expect((await staff.agent.post(`${API}/leads`).send(body)).status).toBe(201);
    expect((await staff.agent.post(`${API}/leads`).send(body)).status).toBe(200); // the replay
    expect((await staff.agent.post(`${API}/leads`).send({ title: "No name" })).status).toBe(422);
    expect(await titles(admin)).toEqual(["New lead: Only once"]);
  });

  it("a save that fails once (a dropped connection) is retried, and nothing is told twice", async () => {
    const admin = await makeUser(ALL);
    const staff = await signedIn(STAFF);
    const spy = vi.spyOn(prisma.notification, "createMany").mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    try {
      expect((await staff.agent.post(`${API}/leads`).send({ title: "Flaky network", contact: { name: "Ravi" } })).status).toBe(201);
      expect(await titles(admin)).toEqual(["New lead: Flaky network"]);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("owners hear what others do to their lead; admins hear of stage moves; names follow who may open the lead now", async () => {
    const admin = await signedIn(ALL, { name: "Asha" });
    const watcher = await makeUser(ALL); // a second administrator, who does nothing
    const ann = await signedIn(STAFF, { name: "Ann" });
    const ben = await signedIn(STAFF, { name: "Ben" });
    const [contacted, interested] = await Promise.all([statusByName("Contacted"), statusByName("Interested")]);
    const lead = (await admin.agent.post(`${API}/leads`).send({ title: "Sea cargo", contact: { name: "Ravi" }, ownerId: ann.user.id })).body;
    const version = async () => (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).version;

    expect((await admin.agent.patch(`${API}/leads/${lead.id}`).send({ statusId: contacted.id, version: lead.version })).status).toBe(200);
    expect((await admin.agent.post(`${API}/leads/${lead.id}/assign`).send({ ownerId: ben.user.id })).status).toBe(200);
    let v = await version();
    expect((await admin.agent.patch(`${API}/leads/${lead.id}`).send({ description: "Bigger order", version: v })).status).toBe(200);
    v = await version();
    expect((await ben.agent.patch(`${API}/leads/${lead.id}`).send({ statusId: interested.id, version: v })).status).toBe(200);
    // A stale move changes nothing, so it tells no one anything.
    expect((await ben.agent.patch(`${API}/leads/${lead.id}`).send({ statusId: contacted.id, version: 1 })).status).toBe(409);

    // Ann no longer owns it (no All records), so her notifications no longer name it or link to it.
    expect(await inbox(ann)).toEqual([
      { title: "Lead assigned to you", detail: "Created by Asha", link: null },
      { title: "Lead moved to Contacted", detail: "Asha moved it from New to Contacted", link: null },
    ]);
    expect(await titles(ben)).toEqual(["Lead assigned to you: Sea cargo", "Lead updated: Sea cargo"]);
    expect(await inbox(admin)).toEqual([{ title: "Lead moved to Interested: Sea cargo", detail: "Ben moved it from Contacted to Interested", link: `/leads/${lead.id}` }]);
    expect(await titles(watcher)).toEqual(["Lead moved to Contacted: Sea cargo", "Lead moved to Interested: Sea cargo", "Lead reassigned: Sea cargo", "New lead: Sea cargo"]);
  });

  it("saving the edit form without changing anything tells the owner nothing; a deleted lead keeps its name", async () => {
    const admin = await signedIn(ALL, { name: "Asha" });
    const watcher = await makeUser(ALL);
    const ann = await signedIn(STAFF, { name: "Ann" });
    const lead = (
      await admin.agent.post(`${API}/leads`).send({ title: "Same again", contact: { name: "Ravi" }, ownerId: ann.user.id, expectedValue: "249000.50", shipment: { weightKg: "1.500" } })
    ).body;
    // The form sends every field back, in its own spelling ("249000.50" for 249000.5, "1.500" kg).
    const form = { title: "Same again", description: "", contact: { name: "Ravi", phone: "", email: "" }, expectedValue: "249000.50", shipment: { weightKg: "1.500", commodity: "" } };
    expect((await admin.agent.patch(`${API}/leads/${lead.id}`).send({ ...form, version: lead.version })).status).toBe(200);
    expect(await titles(ann)).toEqual(["Lead assigned to you: Same again"]);

    expect((await admin.agent.delete(`${API}/leads/${lead.id}`)).status).toBe(204);
    // The deletion is named for those who could open the lead; earlier notifications about it, which nobody can open
    // now, read as the event alone.
    expect(await inbox(ann)).toEqual([
      { title: "Lead assigned to you", detail: "Created by Asha", link: null },
      { title: "Lead deleted: Same again", detail: "Deleted by Asha", link: null },
    ]);
    expect(await inbox(watcher)).toEqual([
      { title: "Lead deleted: Same again", detail: "Deleted by Asha", link: null },
      { title: "New lead", detail: "Created by Asha, together with its customer", link: null },
    ]);
  });

  it("customer changes reach administrators; an assignee without Customers access is told without the customer's details", async () => {
    const admin = await signedIn(ALL, { name: "Asha" });
    const watcher = await makeUser(ALL);
    const staff = await signedIn(["leads", "notifications"], { name: "Sam" }); // no Customers
    const lead = (await staff.agent.post(`${API}/leads`).send({ title: "Courier", contact: { name: "Ravi Kumar" } })).body;
    const customer = await prisma.customer.findFirstOrThrow({ where: { leadId: lead.id } });
    expect((await admin.agent.patch(`${API}/customers/${customer.id}`).send({ status: "inactive" })).status).toBe(200);
    expect(await inbox(staff)).toEqual([{ title: "Customer deactivated", detail: "By Asha", link: null }]);

    const next = await makeUser(["customers", "notifications"]);
    expect((await admin.agent.patch(`${API}/customers/${customer.id}`).send({ assignedUserId: next.user.id })).status).toBe(200);
    expect(await inbox(next)).toEqual([{ title: "Customer assigned to you: Ravi Kumar", detail: "Assigned by Asha", link: `/customers/${customer.id}` }]);
    expect(await titles(watcher)).toEqual(["Customer deactivated: Ravi Kumar", "Customer reassigned: Ravi Kumar", "New lead: Courier"]);
  });

  it("follow-ups: the assignee hears of one made or handed to them; administrators of it being made, completed and deleted", async () => {
    const admin = await makeUser(ALL);
    const boss = await signedIn(ALL, { name: "Bea" });
    const staff = await signedIn(STAFF, { name: "Sam" });
    const other = await signedIn(STAFF, { name: "Oli" });
    const lead = (await boss.agent.post(`${API}/leads`).send({ title: "Proposal", company: { name: "MediShip" }, contact: { name: "Ravi" } })).body;
    const due = addDays(todayIST(), 2);
    const fu = (await boss.agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: due, note: "Send the quote", type: "call", assignedUserId: staff.user.id })).body;
    expect(await inbox(staff)).toEqual([{ title: "Follow-up assigned to you: MediShip - Ravi", detail: `Bea scheduled a Call on ${indiaDate(due)}`, link: "/follow-ups" }]);

    expect((await staff.agent.post(`${API}/follow-ups/${fu.id}/complete`)).status).toBe(200);
    expect((await staff.agent.post(`${API}/follow-ups/${fu.id}/complete`)).status).toBe(200); // already done: nothing new
    expect(await titles(boss)).toEqual(["Follow-up completed: MediShip - Ravi"]);

    const second = (await boss.agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: due, note: "Chase", type: "email", assignedUserId: staff.user.id })).body;
    expect((await boss.agent.patch(`${API}/follow-ups/${second.id}`).send({ assignedUserId: other.user.id })).status).toBe(200);
    expect(await inbox(other)).toEqual([{ title: "Follow-up assigned to you: MediShip - Ravi", detail: `Assigned by Bea, due on ${indiaDate(due)}`, link: "/follow-ups" }]);
    expect((await boss.agent.delete(`${API}/follow-ups/${second.id}`)).status).toBe(204);
    // Deleted for good: the deletion is named in full when it happens, for those who could open it then; the
    // earlier notifications about it, whose record no longer exists, now read as the event alone.
    expect(await inbox(admin)).toContainEqual({ title: "Follow-up deleted: MediShip - Ravi", detail: "Deleted by Bea", link: null });
    expect(await titles(admin)).toEqual([
      "Follow-up completed: MediShip - Ravi",
      "Follow-up deleted: MediShip - Ravi",
      "Follow-up reassigned",
      "New follow-up",
      "New follow-up: MediShip - Ravi",
      "New lead: Proposal",
    ]);
  });

  it("staff never read each other's notifications; one stored while their role lacked Notifications shows once it has it", async () => {
    const admin = await signedIn(ALL);
    const ann = await signedIn(STAFF);
    const ben = await signedIn(STAFF);
    await admin.agent.post(`${API}/leads`).send({ title: "For Ben", contact: { name: "Ravi" }, ownerId: ben.user.id });
    expect(await titles(ben)).toEqual(["Lead assigned to you: For Ben"]);
    expect((await ann.agent.get(`${API}/notifications`)).body).toMatchObject({ total: 0, unreadCount: 0 });

    await prisma.rolePermission.delete({ where: { roleId_permissionCode: { roleId: ben.role.id, permissionCode: "notifications" } } });
    await admin.agent.post(`${API}/leads`).send({ title: "Also for Ben", contact: { name: "Ravi" }, ownerId: ben.user.id });
    expect((await ben.agent.get(`${API}/notifications`)).status).toBe(403);
    expect((await ben.agent.get(`${API}/notifications/unread`)).status).toBe(403);
    await grant(ben.role.id, "notifications");
    expect(await titles(ben)).toEqual(["Lead assigned to you: Also for Ben", "Lead assigned to you: For Ben"]);
  });

  it("a new user is announced to every other active user; account and role changes go to administrators", async () => {
    const admin = await signedIn(["users", "notifications"], { name: "Asha" });
    const other = await makeUser(["users", "notifications"]);
    const staff = await makeUser(STAFF);
    const quiet = await makeUser(["modules"]); // no Notifications page: stored, readable once given it
    const gone = await makeUser(["notifications"], { status: "inactive" });
    const role = (await admin.agent.post(`${API}/roles`).send({ name: "BDE", permissions: ["leads"] })).body;
    expect((await admin.agent.patch(`${API}/roles/${role.id}`).send({ permissions: ["leads", "follow_ups"] })).status).toBe(200);
    const neha = (await admin.agent.post(`${API}/users`).send({ name: "Neha", email: "neha@test.local", roleId: role.id, password: "Long-enough-1" })).body;
    expect(await inbox(staff)).toEqual([{ title: "New team member", detail: "Neha, added by Asha", link: null }]);
    expect(await stored(quiet.user.id)).toBe(1);
    expect(await stored(gone.user.id)).toBe(0); // inactive accounts are not told
    expect(await stored(neha.id)).toBe(0); // nor is the new user about themselves

    // A save that changes nothing tells nobody; a real change does.
    const same = { name: "Neha", email: "neha@test.local", phone: "", roleId: role.id, status: "active", password: "" };
    expect((await admin.agent.patch(`${API}/users/${neha.id}`).send(same)).status).toBe(200);
    expect((await admin.agent.patch(`${API}/users/${neha.id}`).send({ status: "inactive" })).status).toBe(200);
    expect(await inbox(other)).toEqual([
      { title: "Role created: BDE", detail: "Asha created it with 1 permission", link: "/users/roles" },
      { title: "Role permissions changed: BDE", detail: "Asha changed what this role can open", link: "/users/roles" },
      { title: "User added: Neha", detail: "Asha added them as BDE", link: "/users" },
      { title: "User deactivated: Neha", detail: "By Asha", link: "/users" },
    ]);
    expect(await inbox(admin)).toEqual([]);

    // Removed (nothing refers to the account): named in full now, because it can't be looked up later.
    expect((await admin.agent.delete(`${API}/users/${neha.id}`)).status).toBe(204);
    expect(await prisma.user.count({ where: { id: neha.id } })).toBe(0);
    expect(await inbox(other)).toContainEqual({ title: "User removed: Neha", detail: "By Asha", link: null });
    expect((await admin.agent.delete(`${API}/roles/${role.id}`)).status).toBe(204);
    expect(await inbox(other)).toContainEqual({ title: "Role deleted: BDE", detail: "Deleted by Asha", link: null });
  });
});

describe.skipIf(!hasDb)("notifications: due-date reminders", () => {
  beforeEach(resetDb);
  const at = (indiaTime: string) => new Date(`${indiaTime}+05:30`);

  async function setup() {
    const admin = await makeUser(ALL);
    const staff = await signedIn(STAFF, { name: "Sam" });
    const status = await statusByName("New");
    const lead = await prisma.lead.create({ data: { title: "Acme deal", contactName: "Ravi", companyName: "Acme", statusId: status.id, createdById: admin.user.id, ownerId: staff.user.id } });
    const followUp = (due: string, data: object = {}) =>
      prisma.followUp.create({ data: { leadId: lead.id, note: "Call back", type: "call", assignedUserId: staff.user.id, dueDate: parseDateOnly(due), createdById: admin.user.id, ...data } });
    return { admin, staff, lead, followUp };
  }

  it("the day before, on the day and the day after (if still open), each exactly once however often it runs", async () => {
    const { admin, staff, followUp } = await setup();
    await followUp("2026-10-20");
    await sendDueReminders(at("2026-10-19T09:00:00"));
    await sendDueReminders(at("2026-10-19T23:59:00")); // a refresh / restart / second instance: nothing new
    expect(await inbox(staff)).toEqual([{ title: "Follow-up due tomorrow: Acme - Ravi", detail: "Call on 20/10/2026", link: "/follow-ups" }]);
    await sendDueReminders(at("2026-10-20T00:00:00"));
    await sendDueReminders(at("2026-10-20T17:00:00"));
    await sendDueReminders(at("2026-10-21T08:00:00"));
    await sendDueReminders(at("2026-10-22T08:00:00"));
    expect(await titles(staff)).toEqual(["Follow-up due today: Acme - Ravi", "Follow-up due tomorrow: Acme - Ravi", "Follow-up overdue: Acme - Ravi"]);
    expect(await inbox(admin)).toEqual([{ title: "Follow-up overdue: Acme - Ravi", detail: "Call was due on 20/10/2026, assigned to Sam", link: "/follow-ups" }]);
  });

  it("India's midnight, not UTC's, starts the day", async () => {
    const { staff, followUp } = await setup();
    await followUp("2026-10-18");
    await sendDueReminders(new Date("2026-10-17T18:29:59Z")); // 23:59:59 on the 17th in India
    expect(await titles(staff)).toEqual(["Follow-up due tomorrow: Acme - Ravi"]);
    await sendDueReminders(new Date("2026-10-17T18:30:00Z")); // 00:00 on the 18th in India
    expect(await titles(staff)).toEqual(["Follow-up due today: Acme - Ravi", "Follow-up due tomorrow: Acme - Ravi"]);
  });

  it("a moved date is reminded about anew, completed or deleted ones not at all, and a missed day is skipped, not sent late", async () => {
    const { staff, lead, followUp } = await setup();
    const moved = await followUp("2026-10-20");
    await followUp("2026-10-20", { status: "completed", completedAt: new Date() });
    await sendDueReminders(at("2026-10-19T09:00:00"));
    await prisma.followUp.update({ where: { id: moved.id }, data: { dueDate: parseDateOnly("2026-10-25") } });
    await sendDueReminders(at("2026-10-20T09:00:00")); // no "due today" for the old date
    await sendDueReminders(at("2026-10-24T09:00:00"));
    expect((await inbox(staff)).map((n) => n.detail)).toEqual(["Call on 20/10/2026", "Call on 25/10/2026"]);

    await prisma.notification.deleteMany();
    await prisma.followUp.update({ where: { id: moved.id }, data: { status: "completed", completedAt: new Date() } }); // done: never overdue
    await followUp("2026-10-27"); // the server was down all of the 26th
    await sendDueReminders(at("2026-10-27T10:00:00"));
    expect(await titles(staff)).toEqual(["Follow-up due today: Acme - Ravi"]);

    await prisma.notification.deleteMany();
    await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });
    await sendDueReminders(at("2026-10-27T11:00:00"));
    expect(await titles(staff)).toEqual([]);
  });

  it("a reminder its reader cleared doesn't come back on the next run", async () => {
    const { staff, followUp } = await setup();
    await followUp("2026-10-20");
    await sendDueReminders(at("2026-10-19T09:00:00"));
    const [n] = (await staff.agent.get(`${API}/notifications`)).body.items;
    expect((await staff.agent.delete(`${API}/notifications/${n.id}`)).status).toBe(204);
    await sendDueReminders(at("2026-10-19T10:00:00"));
    expect(await titles(staff)).toEqual([]);
  });

  it("the first run doesn't flood anyone: overdue looks back LOOKBACK_DAYS only", async () => {
    const { staff, followUp } = await setup();
    const today = "2026-10-20";
    await followUp(addDays(today, -30));
    await followUp(addDays(today, -LOOKBACK_DAYS));
    await sendDueReminders(at(`${today}T09:00:00`));
    expect((await inbox(staff)).map((n) => n.detail)).toEqual([`Call was due on ${indiaDate(addDays(today, -LOOKBACK_DAYS))}`]);
  });

  it("lead reminders arrive at their time, once, to whoever scheduled them and the lead's owner", async () => {
    const { admin, staff, lead } = await setup();
    const dueAt = at("2026-10-20T15:30:00");
    const r = await prisma.reminder.create({ data: { leadId: lead.id, title: "Ring about the quote", dueAt, createdById: admin.user.id } });
    expect(await sendDueReminders(at("2026-10-20T15:29:00"))).toEqual(dueAt); // not yet; the timer wakes for it
    expect(await titles(staff)).toEqual([]);
    expect(await sendDueReminders(at("2026-10-20T15:30:00"))).toBeNull();
    await sendDueReminders(at("2026-10-20T15:45:00"));
    for (const who of [admin, staff]) {
      const got = await inbox(who);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ title: "Reminder: Acme deal", link: `/leads/${lead.id}` });
      expect(got[0]!.detail).toMatch(/^Ring about the quote, 20\/10\/2026, 3:30\spm$/i);
    }
    expect((await prisma.reminder.findUniqueOrThrow({ where: { id: r.id } })).notifiedAt).toEqual(at("2026-10-20T15:30:00"));
  });
});

describe.skipIf(!hasDb)("notifications: read, remove, clear", () => {
  beforeEach(resetDb);

  it("reads, removes and clears only the caller's own; another user's ids answer 404", async () => {
    const me = await signedIn(["notifications"]);
    const other = await signedIn(["notifications"]);
    const t = (s: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, s));
    const [a, b, c, theirs] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await prisma.notification.createMany({
      data: [
        { id: a, userId: me.user.id, title: "A", createdAt: t(1) },
        { id: b, userId: me.user.id, title: "B", createdAt: t(2) },
        { id: c, userId: me.user.id, title: "C", readAt: t(4), createdAt: t(3) },
        { id: theirs, userId: other.user.id, title: "Theirs", createdAt: t(5) },
      ],
    });
    const list = async () => (await me.agent.get(`${API}/notifications`)).body;
    expect((await me.agent.get(`${API}/notifications/unread`)).body).toEqual({ unreadCount: 2, latestAt: t(2).toISOString(), total: 3 });

    expect((await me.agent.post(`${API}/notifications/${a}/read`)).status).toBe(204);
    expect(await list()).toMatchObject({ total: 3, unreadCount: 1 }); // read, not removed
    expect((await me.agent.get(`${API}/notifications/unread`)).body).toEqual({ unreadCount: 1, latestAt: t(2).toISOString(), total: 3 });

    expect((await me.agent.delete(`${API}/notifications/${b}`)).status).toBe(204);
    expect(await list()).toMatchObject({ total: 2, unreadCount: 0 });
    expect((await me.agent.get(`${API}/notifications/unread`)).body).toEqual({ unreadCount: 0, latestAt: null, total: 2 }); // a removal changes the total too
    expect((await me.agent.delete(`${API}/notifications/${b}`)).status).toBe(404); // already gone

    // Changing the id in the URL reaches nobody else's notifications.
    expect((await other.agent.post(`${API}/notifications/${c}/read`)).status).toBe(404);
    expect((await other.agent.delete(`${API}/notifications/${a}`)).status).toBe(404);
    expect((await me.agent.delete(`${API}/notifications/${theirs}`)).status).toBe(404);
    expect((await me.agent.post(`${API}/notifications/not-a-uuid/read`)).status).toBe(404);
    expect((await me.agent.get(`${API}/notifications`)).body.items.map((n: { title: string }) => n.title)).toEqual(["C", "A"]);

    expect((await me.agent.delete(`${API}/notifications`)).body).toEqual({ cleared: 2 });
    expect(await list()).toMatchObject({ items: [], total: 0, unreadCount: 0 });
    expect((await other.agent.get(`${API}/notifications`)).body).toMatchObject({ total: 1, unreadCount: 1 });
    // Cleared, not destroyed: kept (for 30 days) so a cleared reminder can't be made again.
    expect(await prisma.notification.count({ where: { userId: me.user.id } })).toBe(3);
  });

  it("Clear all removes only up to the newest one the list showed, and lists newest first in pages", async () => {
    const me = await signedIn(["notifications"]);
    const t = (s: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, s));
    await prisma.notification.createMany({ data: [1, 2, 3, 4, 5].map((s) => ({ userId: me.user.id, title: `N${s}`, createdAt: t(s) })) });
    const page = async (n: number) => (await me.agent.get(`${API}/notifications`).query({ page: n, pageSize: 2 })).body;
    expect((await page(1)).items.map((i: Item) => i.title)).toEqual(["N5", "N4"]);
    expect((await page(3)).items.map((i: Item) => i.title)).toEqual(["N1"]);
    // The list showed up to N4; N5 arrived after.
    expect((await me.agent.delete(`${API}/notifications`).query({ before: t(4).toISOString() })).body).toEqual({ cleared: 4 });
    expect((await page(1)).items.map((i: Item) => i.title)).toEqual(["N5"]);
    expect((await me.agent.delete(`${API}/notifications`).query({ before: "yesterday" })).status).toBe(422);
  });

  it("each signed-in user has their own request budget: one user hitting the limit doesn't stop another's checks", async () => {
    const busy = await signedIn(["notifications"]);
    const calm = await signedIn(["notifications"]);
    const codes: number[] = [];
    for (let batch = 0; batch < 301; batch += 10)
      codes.push(...(await Promise.all(Array.from({ length: Math.min(10, 301 - batch) }, () => busy.agent.get(`${API}/notifications/unread`).then((r) => r.status)))));
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
    expect((await calm.agent.get(`${API}/notifications/unread`)).status).toBe(200);
  });
});
