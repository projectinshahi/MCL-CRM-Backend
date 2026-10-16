import { beforeEach, describe, expect, it } from "vitest";
import { API, hasDb, makeUser, prisma, resetDb, signedIn, sourceByName, statusByName } from "../helpers.ts";

// The edits written as one SQL statement (src/lib/write.ts, follow-up create/complete): their history rows, their
// all-or-nothing behaviour, and the column types the JSON → row conversion has to get right.
describe.skipIf(!hasDb)("one-statement writes", () => {
  beforeEach(resetDb);

  const newLead = async (agent: Awaited<ReturnType<typeof signedIn>>["agent"]) =>
    (await agent.post(`${API}/leads`).send({ title: "Sea freight", contact: { name: "Test Contact" }, expectedValue: "1000.10" })).body as { id: string; version: number };

  it("a pipeline move: new stage, version + 1, one activity entry; the reply matches the stored lead", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = await newLead(agent);
    const proposal = await statusByName("Proposal");
    const res = await agent.patch(`${API}/leads/${lead.id}`).send({ statusId: proposal.id, version: lead.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: { id: proposal.id, name: "Proposal", isWon: false, isLost: false }, version: lead.version + 1, expectedValue: 1000.1 });
    const stored = await agent.get(`${API}/leads/${lead.id}`);
    const { attachments: _files, ...detail } = stored.body;
    expect(res.body).toEqual(detail); // built without re-reading, and exactly what a read returns
    const log = await prisma.leadActivity.findMany({ where: { leadId: lead.id, type: "status_changed" } });
    expect(log.map((a) => a.message)).toEqual(["Status changed from New to Proposal"]);
  });

  it("a stale move changes nothing and leaves no history", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = await newLead(agent);
    const proposal = await statusByName("Proposal");
    await agent.patch(`${API}/leads/${lead.id}`).send({ description: "first edit", version: lead.version });
    const before = await prisma.leadActivity.count({ where: { leadId: lead.id } });
    const res = await agent.patch(`${API}/leads/${lead.id}`).send({ statusId: proposal.id, version: lead.version }); // old version
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STALE_VERSION");
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id } })).toBe(before);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).statusId).not.toBe(proposal.id);
  });

  it("typed columns survive the write: money, weight, enums, clearing a value", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = await newLead(agent);
    const source = await sourceByName("Meta Ads");
    const res = await agent.patch(`${API}/leads/${lead.id}`).send({
      expectedValue: "249000.55",
      customerType: "b2b",
      priority: "high",
      sourceId: source.id,
      shipment: { shipmentType: "Water", weightKg: "12.345" },
      contact: { phone: "+919845616544" },
      description: "",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ expectedValue: 249000.55, customerType: "b2b", priority: "high", source: { name: "Meta Ads" }, shipment: { shipmentType: "water", weightKg: 12.345 }, contact: { phone: "+919845616544" }, description: null });
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.expectedValue?.toFixed(2)).toBe("249000.55");
    expect(row.updatedAt.getTime()).toBeGreaterThan(row.createdAt.getTime() - 1);
  });

  it("assign and delete write their activity and audit rows; a second delete is a 404 with nothing added", async () => {
    const { agent, user } = await signedIn(["leads", "all_records"]);
    const other = await makeUser(["leads"]);
    const lead = await newLead(agent);
    const assigned = await agent.post(`${API}/leads/${lead.id}/assign`).send({ ownerId: other.user.id });
    expect(assigned.body).toMatchObject({ owner: { id: other.user.id }, version: lead.version + 1 });
    expect(await prisma.auditLog.count({ where: { action: "lead_assigned", entityId: lead.id, actorId: user.id } })).toBe(1);

    expect((await agent.delete(`${API}/leads/${lead.id}`)).status).toBe(204);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).deletedAt).not.toBeNull();
    const history = async () => [await prisma.leadActivity.count({ where: { leadId: lead.id, type: "deleted" } }), await prisma.auditLog.count({ where: { action: "lead_deleted", entityId: lead.id } })];
    expect(await history()).toEqual([1, 1]);
    expect((await agent.delete(`${API}/leads/${lead.id}`)).status).toBe(404);
    expect(await history()).toEqual([1, 1]);
  });

  it("follow-ups: create logs it on the lead; completing twice logs it once", async () => {
    const { agent } = await signedIn(["leads", "follow_ups"]);
    const lead = await newLead(agent);
    const created = await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: "2026-10-20", note: "Call back", type: "call" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ note: "Call back", type: "call", dueDate: "2026-10-20", lead: { id: lead.id, label: "Test Contact" } });
    expect((await agent.get(`${API}/follow-ups`)).body.items[0]).toEqual(created.body); // the built reply = a read
    for (let i = 0; i < 2; i++) expect((await agent.post(`${API}/follow-ups/${created.body.id}/complete`)).body.status).toBe("completed");
    const types = (await prisma.leadActivity.findMany({ where: { leadId: lead.id } })).map((a) => a.type);
    expect(types.filter((t) => t === "follow_up_added")).toHaveLength(1);
    expect(types.filter((t) => t === "follow_up_completed")).toHaveLength(1);
  });

  it("customers: Deactivate's reply matches the stored customer; an edit is read back", async () => {
    const { agent } = await signedIn(["leads", "customers", "all_records"]);
    const lead = await agent.post(`${API}/leads`).send({ title: "Convert me", contact: { name: "Asha" } });
    const conv = await agent.post(`${API}/leads/${lead.body.id}/convert`).send({});
    const id = conv.body.customer.id;
    const off = await agent.patch(`${API}/customers/${id}`).send({ status: "inactive" });
    expect(off.body.status).toBe("inactive");
    const { attachments: _a, leads: _l, hiddenLeads: _h, ...read } = (await agent.get(`${API}/customers/${id}`)).body;
    expect(off.body).toEqual(read);
    const edited = await agent.patch(`${API}/customers/${id}`).send({ name: "Asha K", type: "direct", status: "active" });
    expect(edited.body).toMatchObject({ name: "Asha K", type: "direct", status: "active" });
    expect(await prisma.auditLog.count({ where: { action: "customer_updated", entityId: id } })).toBe(2);
  });
});
