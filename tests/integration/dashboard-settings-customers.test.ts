import { beforeEach, describe, expect, it } from "vitest";
import { todayIST } from "../../src/lib/format.ts";
import { API, hasDb, prisma, resetDb, signedIn, sourceByName, statusByName } from "../helpers.ts";

const dayOffset = (days: number) => todayIST(new Date(Date.now() + days * 86_400_000));

describe.skipIf(!hasDb)("dashboard", () => {
  beforeEach(resetDb);

  it("returns zeros, not NaN, with no data", async () => {
    const { agent } = await signedIn(["dashboard"]);
    const res = await agent.get(`${API}/dashboard/summary`);
    expect(res.body.kpis).toEqual({
      totalLeads: 0, newLeads: 0, activeLeads: 0, convertedLeads: 0, lostLeads: 0, activeCustomers: 0,
      followUpsDueToday: 0, followUpsOverdue: 0, openLeadValue: 0, convertedValue: 0, conversionRate: 0,
    });
    expect(res.body.byStatus).toHaveLength(6);
  });

  it("aggregates real records exactly and within the caller's scope", async () => {
    const me = await signedIn(["dashboard", "leads", "follow_ups", "customers"]);
    const meta = await sourceByName("Meta Ads");
    const won = await statusByName("Converted");
    const lost = await statusByName("Lost");
    const a = (await me.agent.post(`${API}/leads`).send({ title: "A", contact: { name: "Test Contact" }, expectedValue: "100.10", sourceId: meta.id })).body;
    await me.agent.post(`${API}/leads`).send({ title: "B", contact: { name: "Test Contact" }, expectedValue: "200.20", statusId: won.id, sourceId: meta.id });
    await me.agent.post(`${API}/leads`).send({ title: "C", contact: { name: "Test Contact" }, expectedValue: 50, statusId: lost.id });
    await me.agent.post(`${API}/follow-ups`).send({ leadId: a.id, followUpDate: dayOffset(0), note: "today", type: "call" });
    await me.agent.post(`${API}/follow-ups`).send({ leadId: a.id, followUpDate: dayOffset(-2), note: "late", type: "call" });
    await prisma.customer.create({ data: { name: "Aravind", assignedUserId: me.user.id } });

    const other = await signedIn(["dashboard", "leads"]); // someone else's lead must not count
    await other.agent.post(`${API}/leads`).send({ title: "Other", contact: { name: "Test Contact" }, expectedValue: 999 });

    const { kpis, byStatus, bySource } = (await me.agent.get(`${API}/dashboard/summary`)).body;
    expect(kpis).toEqual({
      totalLeads: 3, newLeads: 1, activeLeads: 1, convertedLeads: 1, lostLeads: 1, activeCustomers: 4, // each lead's own customer + Aravind
      followUpsDueToday: 1, followUpsOverdue: 1, openLeadValue: 100.1, convertedValue: 200.2, conversionRate: 33.3,
    });
    expect(byStatus.find((s: { status: { name: string } }) => s.status.name === "New").count).toBe(1);
    expect(bySource[0]).toMatchObject({ source: { name: "Meta Ads" }, count: 2, share: 66.7 });
    expect(bySource[1]).toMatchObject({ source: null, count: 1 });

    const boss = await signedIn(["dashboard", "all_records"]);
    expect((await boss.agent.get(`${API}/dashboard/summary`)).body.kpis.totalLeads).toBe(4);
  });
});

describe.skipIf(!hasDb)("settings", () => {
  beforeEach(resetDb);

  it("lists sources for any signed-in user and blocks case-insensitive duplicates", async () => {
    const { agent } = await signedIn(["settings"]);
    const names = (await agent.get(`${API}/settings/lead-sources`)).body.map((s: { name: string }) => s.name);
    expect(names).toEqual(["Direct Office", "Meta Ads", "B2B", "CO - Courier Team", "Other"]);
    expect((await agent.post(`${API}/settings/lead-sources`).send({ name: "meta ads" })).body.error.code).toBe("DUPLICATE_NAME");
    expect((await agent.post(`${API}/settings/lead-sources`).send({ name: "  " })).status).toBe(422);
    expect((await agent.post(`${API}/settings/lead-sources`).send({ name: "Referral" })).status).toBe(201);
  });

  it("deletes an unused source but only deactivates one in use, and re-adding revives it", async () => {
    const { agent, user } = await signedIn(["settings"]);
    const other = await sourceByName("Other");
    const meta = await sourceByName("Meta Ads");
    const status = await statusByName("New");
    await prisma.lead.create({ data: { title: "L", sourceId: meta.id, statusId: status.id, createdById: user.id } });

    expect((await agent.delete(`${API}/settings/lead-sources/${other.id}`)).status).toBe(204);
    expect(await prisma.leadSource.findUnique({ where: { id: other.id } })).toBeNull();
    expect((await agent.delete(`${API}/settings/lead-sources/${meta.id}`)).status).toBe(204);
    expect((await prisma.leadSource.findUniqueOrThrow({ where: { id: meta.id } })).active).toBe(false);

    const revived = await agent.post(`${API}/settings/lead-sources`).send({ name: "Meta Ads" });
    expect(revived.body).toMatchObject({ id: meta.id, active: true });
  });

  it("appends statuses, refuses to delete one in use, and keeps at least one", async () => {
    const { agent, user } = await signedIn(["settings"]);
    const added = await agent.post(`${API}/settings/lead-statuses`).send({ name: "Negotiation" });
    expect(added.body).toMatchObject({ name: "Negotiation", sortOrder: 7, isWon: false, isLost: false });

    const used = await statusByName("New");
    await prisma.lead.create({ data: { title: "L", statusId: used.id, createdById: user.id } });
    expect((await agent.delete(`${API}/settings/lead-statuses/${used.id}`)).body.error.code).toBe("STATUS_IN_USE");

    for (const s of await prisma.leadStatus.findMany({ where: { id: { not: used.id } } }))
      expect((await agent.delete(`${API}/settings/lead-statuses/${s.id}`)).status).toBe(204);
    await prisma.lead.deleteMany();
    expect((await agent.delete(`${API}/settings/lead-statuses/${used.id}`)).body.error.code).toBe("LAST_STATUS");
  });

  it("renames a status (its leads and pipeline column follow) and a source; names stay unique; audited; settings only", async () => {
    const admin = await signedIn(["settings", "leads"]);
    const status = await statusByName("Proposal");
    const lead = (await admin.agent.post(`${API}/leads`).send({ title: "Renamed stage", contact: { name: "Test Contact" }, statusId: status.id })).body;

    const res = await admin.agent.patch(`${API}/settings/lead-statuses/${status.id}`).send({ name: " Quotation Sent " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: status.id, name: "Quotation Sent", sortOrder: status.sortOrder });
    expect((await admin.agent.get(`${API}/leads/${lead.id}`)).body.status).toMatchObject({ id: status.id, name: "Quotation Sent" });
    expect((await admin.agent.get(`${API}/leads/pipeline`)).body.columns.map((c: { status: { name: string } }) => c.status.name)).toContain("Quotation Sent");
    expect(await prisma.auditLog.findFirst({ where: { action: "lead_status_renamed", entityId: status.id } })).toMatchObject({ before: { name: "Proposal" }, after: { name: "Quotation Sent" } });

    expect((await admin.agent.patch(`${API}/settings/lead-statuses/${status.id}`).send({ name: "new" })).body.error.code).toBe("DUPLICATE_NAME");
    expect((await admin.agent.patch(`${API}/settings/lead-statuses/${status.id}`).send({ name: "QUOTATION SENT" })).body.name).toBe("QUOTATION SENT"); // its own name, other case
    expect((await admin.agent.patch(`${API}/settings/lead-statuses/${status.id}`).send({ name: "" })).status).toBe(422);
    expect((await admin.agent.patch(`${API}/settings/lead-statuses/00000000-0000-4000-8000-000000000000`).send({ name: "X" })).status).toBe(404);

    const meta = await sourceByName("Meta Ads");
    expect((await admin.agent.patch(`${API}/settings/lead-sources/${meta.id}`).send({ name: "Facebook Ads" })).body).toEqual({ id: meta.id, name: "Facebook Ads", active: true });
    expect((await admin.agent.patch(`${API}/settings/lead-sources/${meta.id}`).send({ name: "b2b" })).body.error.code).toBe("DUPLICATE_NAME");

    const staff = await signedIn(["leads"]);
    expect((await staff.agent.patch(`${API}/settings/lead-statuses/${status.id}`).send({ name: "Hijacked" })).status).toBe(403);
    expect((await staff.agent.patch(`${API}/settings/lead-sources/${meta.id}`).send({ name: "Hijacked" })).status).toBe(403);
    expect((await prisma.leadStatus.findUniqueOrThrow({ where: { id: status.id } })).name).toBe("QUOTATION SENT");
  });
});

describe.skipIf(!hasDb)("customers", () => {
  beforeEach(resetDb);

  it("lists only assigned customers with search and active count; customers are never deleted", async () => {
    const me = await signedIn(["customers"]);
    const other = await signedIn(["customers"]);
    const meta = await sourceByName("Meta Ads");
    const mine = await prisma.customer.create({ data: { name: "Aravind Nair", company: "CRN Solutions", sourceId: meta.id, assignedUserId: me.user.id } });
    await prisma.customer.create({ data: { name: "Inactive Co", status: "inactive", assignedUserId: me.user.id } });
    await prisma.customer.create({ data: { name: "Not mine", assignedUserId: other.user.id } });

    const list = (await me.agent.get(`${API}/customers`)).body;
    expect(list).toMatchObject({ total: 2, activeCount: 1 });
    expect((await me.agent.get(`${API}/customers`).query({ q: "crn" })).body.items[0]).toMatchObject({ name: "Aravind Nair", source: { name: "Meta Ads" } });

    // Deactivate instead (Sprint 3): DELETE is refused and the record stays as it was.
    const del = await me.agent.delete(`${API}/customers/${mine.id}`);
    expect(del.status).toBe(405);
    expect(del.body.error.code).toBe("CUSTOMER_DELETE_DISABLED");
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ deletedAt: null, status: "active" });
    expect((await me.agent.get(`${API}/customers`)).body.total).toBe(2);
  });
});

describe.skipIf(!hasDb)("notifications", () => {
  beforeEach(resetDb);

  it("shows only the caller's notifications with an unread count", async () => {
    const me = await signedIn(["notifications"]);
    const other = await signedIn(["notifications"]);
    await prisma.notification.createMany({
      data: [
        { userId: me.user.id, title: "Unread" },
        { userId: me.user.id, title: "Read", readAt: new Date() },
        { userId: other.user.id, title: "Theirs" },
      ],
    });
    const res = (await me.agent.get(`${API}/notifications`)).body;
    expect(res).toMatchObject({ total: 2, unreadCount: 1 });
    expect(res.items.map((n: { title: string }) => n.title).sort()).toEqual(["Read", "Unread"]);
  });
});
