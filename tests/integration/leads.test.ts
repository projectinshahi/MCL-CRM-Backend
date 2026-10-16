import { beforeEach, describe, expect, it } from "vitest";
import { API, hasDb, makeUser, prisma, resetDb, signedIn, sourceByName, statusByName } from "../helpers.ts";

const fullLead = (sourceId: string) => ({
  title: "Air freight to Dubai",
  description: "Monthly consignments",
  address: "MG Road, Kochi",
  district: "Ernakulam",
  contact: { name: "Arshad", phone: "9845616544", email: "Arshad03@Gmail.com" },
  customerType: "b2b",
  company: { name: "CRN Solutions", location: "Karnataka", email: "ops@crn.example" },
  sourceId,
  priority: "medium",
  expectedValue: "249000.55",
  shipment: {
    destinationCountry: "United Arab Emirates",
    commodity: "Textiles",
    shipmentType: "Air",
    weightKg: 1.5,
    volume: "2 CBM",
    pickupLocation: "Kochi",
    deliveryLocation: "Dubai",
  },
});

describe.skipIf(!hasDb)("leads", () => {
  beforeEach(resetDb);

  it("creates a lead with every form field, server defaults and exact money", async () => {
    const { agent, user } = await signedIn(["leads"]);
    const source = await sourceByName("Meta Ads");
    const res = await agent.post(`${API}/leads`).send(fullLead(source.id));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Air freight to Dubai",
      contact: { name: "Arshad", phone: "+919845616544", email: "arshad03@gmail.com" }, // digits only → read as India (DEFAULT_PHONE_COUNTRY), stored E.164
      company: { name: "CRN Solutions" },
      customerType: "b2b",
      source: { id: source.id, name: "Meta Ads" },
      status: { name: "New" },
      priority: "medium",
      paymentStatus: "pending",
      expectedValue: 249000.55,
      owner: { id: user.id },
      shipment: { weightKg: 1.5, shipmentType: "air", deliveryLocation: "Dubai" }, // "Air" from older callers is stored as air
      version: 1,
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    const activity = await agent.get(`${API}/leads/${res.body.id}/activities`);
    expect(activity.body.items.map((a: { type: string }) => a.type)).toEqual(["customer_created", "created"]); // newest first
    expect(activity.body.items[1]).toMatchObject({ type: "created", actor: { id: user.id } });
  });

  it("rejects unknown fields, bad references and bad values with field errors", async () => {
    const { agent } = await signedIn(["leads"]);
    const meta = await sourceByName("Meta Ads");
    expect((await agent.post(`${API}/leads`).send({ title: "x", contact: { name: "Test Contact" }, paymentStatus: "completed" })).status).toBe(422);
    expect((await agent.post(`${API}/leads`).send({ title: "", contact: { name: "Test Contact" } })).body.error.fields).toHaveProperty("title");
    expect((await agent.post(`${API}/leads`).send({ title: "x", contact: { name: "Test Contact" }, expectedValue: -5 })).body.error.fields).toHaveProperty("expectedValue");
    expect((await agent.post(`${API}/leads`).send({ title: "x", contact: { name: "Test Contact", email: "nope" } })).body.error.fields).toHaveProperty(["contact.email"]);

    await prisma.leadSource.update({ where: { id: meta.id }, data: { active: false } });
    expect((await agent.post(`${API}/leads`).send({ title: "x", contact: { name: "Test Contact" }, sourceId: meta.id })).body.error.fields).toHaveProperty("sourceId");
    const gone = await makeUser(["leads"], { status: "inactive" });
    expect((await agent.post(`${API}/leads`).send({ title: "x", contact: { name: "Test Contact" }, ownerId: gone.user.id })).body.error.fields).toHaveProperty("ownerId");
  });

  it("shipment type is Air or Water: saved, edited, shown, and anything else refused", async () => {
    const { agent } = await signedIn(["leads"]);
    const water = await agent.post(`${API}/leads`).send({ title: "Sea freight", contact: { name: "Test Contact" }, shipment: { shipmentType: "water" } });
    expect(water.body.shipment.shipmentType).toBe("water");
    const air = await agent.post(`${API}/leads`).send({ title: "Air freight", contact: { name: "Test Contact" }, shipment: { shipmentType: " AIR " } });
    expect(air.body.shipment.shipmentType).toBe("air");
    const bad = await agent.post(`${API}/leads`).send({ title: "x", contact: { name: "Test Contact" }, shipment: { shipmentType: "rail" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toEqual({ "shipment.shipmentType": "Choose Air or Water" });
    const edited = await agent.patch(`${API}/leads/${water.body.id}`).send({ shipment: { shipmentType: "air" } });
    expect(edited.body.shipment.shipmentType).toBe("air");
    expect((await agent.get(`${API}/leads/${water.body.id}`)).body.shipment.shipmentType).toBe("air");
    expect((await agent.patch(`${API}/leads/${water.body.id}`).send({ shipment: { shipmentType: "" } })).body.shipment.shipmentType).toBeNull();
    expect((await agent.patch(`${API}/leads/${air.body.id}`).send({ title: "Renamed" })).body.shipment.shipmentType).toBe("air"); // untouched
  });

  it("validates contact phones against the numbering plan, stores E.164 and leaves them alone on other edits", async () => {
    const { agent } = await signedIn(["leads"]);
    const created = await agent.post(`${API}/leads`).send({ title: "UAE lead", contact: { name: "Test Contact", phone: "+971 50 123 4567" } });
    expect(created.status).toBe(201);
    expect(created.body.contact.phone).toBe("+971501234567");
    // Calling the API directly gets the same checks as the form.
    const bad = await agent.post(`${API}/leads`).send({ title: "x", contact: { name: "Test Contact", phone: "+1 123 456 7890" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toEqual({ "contact.phone": "Enter a valid phone number for the selected country." });
    const id = created.body.id;
    expect((await agent.patch(`${API}/leads/${id}`).send({ title: "UAE lead 2" })).body.contact.phone).toBe("+971501234567");
    const incomplete = await agent.patch(`${API}/leads/${id}`).send({ contact: { phone: "+91 81234" } });
    expect(incomplete.body.error.fields).toEqual({ "contact.phone": "This number appears incomplete." });
    expect((await agent.patch(`${API}/leads/${id}`).send({ contact: { phone: "+44 20 7031 3000" } })).body.contact.phone).toBe("+442070313000");
    expect((await agent.patch(`${API}/leads/${id}`).send({ contact: { phone: "" } })).body.contact.phone).toBeNull();
  });

  it("paginates, searches, filters and sorts on the server", async () => {
    const { agent, user } = await signedIn(["leads"]);
    const status = await statusByName("New");
    // Seeded in one statement: this test is about listing, and 25 API round trips to a remote DB only add latency.
    await prisma.lead.createMany({
      data: Array.from({ length: 25 }, (_, n) => ({
        title: `Lead ${n + 1}`,
        expectedValue: (n + 1) * 100,
        priority: (n + 1) % 5 === 0 ? ("high" as const) : ("low" as const),
        contactName: n + 1 === 7 ? "Vimal Kumar" : "Someone",
        statusId: status.id,
        ownerId: user.id,
        createdById: user.id,
      })),
    });

    const page2 = await agent.get(`${API}/leads`).query({ page: 2, pageSize: 10 });
    expect(page2.body).toMatchObject({ page: 2, pageSize: 10, total: 25 });
    expect(page2.body.items).toHaveLength(10);
    expect((await agent.get(`${API}/leads`).query({ q: "vimal" })).body.items.map((l: { title: string }) => l.title)).toEqual(["Lead 7"]);
    expect((await agent.get(`${API}/leads`).query({ priority: "high" })).body.total).toBe(5);
    expect((await agent.get(`${API}/leads`).query({ sort: "value_desc", pageSize: 1 })).body.items[0].expectedValue).toBe(2500);
    expect((await agent.get(`${API}/leads`).query({ pageSize: 500 })).status).toBe(422);
  });

  it("hides other users' leads unless the role has All records", async () => {
    const owner = await signedIn(["leads"]);
    const other = await signedIn(["leads"]);
    const boss = await signedIn(["leads", "all_records"]);
    const lead = (await owner.agent.post(`${API}/leads`).send({ title: "Mine", contact: { name: "Test Contact" } })).body;

    for (const res of [
      await other.agent.get(`${API}/leads/${lead.id}`),
      await other.agent.patch(`${API}/leads/${lead.id}`).send({ title: "Hijack" }),
      await other.agent.delete(`${API}/leads/${lead.id}`),
      await other.agent.post(`${API}/leads/${lead.id}/assign`).send({ ownerId: other.user.id }),
      await other.agent.get(`${API}/leads/${lead.id}/activities`),
    ])
      expect(res.status).toBe(404);
    expect((await other.agent.get(`${API}/leads`)).body.total).toBe(0);
    expect((await boss.agent.get(`${API}/leads/${lead.id}`)).status).toBe(200);
    expect((await boss.agent.get(`${API}/leads`)).body.total).toBe(1);
  });

  it("edits partially, logs status changes and rejects stale versions", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = (await agent.post(`${API}/leads`).send({ title: "Draft", contact: { name: "Test Contact" }, expectedValue: 1000 })).body;
    const contacted = await statusByName("Contacted");

    const edited = await agent.patch(`${API}/leads/${lead.id}`).send({ statusId: contacted.id, description: "Called", version: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: "Draft", expectedValue: 1000, description: "Called", status: { name: "Contacted" }, version: 2 });

    const stale = await agent.patch(`${API}/leads/${lead.id}`).send({ title: "Late", version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE_VERSION");

    const types = (await agent.get(`${API}/leads/${lead.id}/activities`)).body.items.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(["created", "status_changed", "updated"]));
  });

  it("assigns to active users only, with activity and audit", async () => {
    const boss = await signedIn(["leads", "all_records"]);
    const bde = await makeUser(["leads"], { name: "Rajesh" });
    const inactive = await makeUser(["leads"], { status: "inactive" });
    const lead = (await boss.agent.post(`${API}/leads`).send({ title: "To assign", contact: { name: "Test Contact" } })).body;

    expect((await boss.agent.post(`${API}/leads/${lead.id}/assign`).send({ ownerId: inactive.user.id })).status).toBe(422);
    const res = await boss.agent.post(`${API}/leads/${lead.id}/assign`).send({ ownerId: bde.user.id });
    expect(res.body.owner).toEqual({ id: bde.user.id, name: "Rajesh" });
    expect(await prisma.auditLog.count({ where: { action: "lead_assigned", entityId: lead.id } })).toBe(1);
    const activity = (await boss.agent.get(`${API}/leads/${lead.id}/activities`)).body.items[0];
    expect(activity).toMatchObject({ type: "assigned", text: "Assigned to Rajesh" });
  });

  it("soft-deletes: gone from the API, kept in the database", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = (await agent.post(`${API}/leads`).send({ title: "Bye", contact: { name: "Test Contact" } })).body;
    expect((await agent.delete(`${API}/leads/${lead.id}`)).status).toBe(204);
    expect((await agent.get(`${API}/leads/${lead.id}`)).status).toBe(404);
    expect((await agent.get(`${API}/leads`)).body.total).toBe(0);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).deletedAt).not.toBeNull();
  });

  it("groups the pipeline by status with exact counts and value totals", async () => {
    const { agent } = await signedIn(["leads"]);
    const won = await statusByName("Converted");
    await agent.post(`${API}/leads`).send({ title: "A", contact: { name: "Test Contact" }, expectedValue: "100.10" });
    await agent.post(`${API}/leads`).send({ title: "B", contact: { name: "Test Contact" }, expectedValue: "200.20" });
    await agent.post(`${API}/leads`).send({ title: "C", contact: { name: "Test Contact" }, expectedValue: 50, statusId: won.id });

    const { columns } = (await agent.get(`${API}/leads/pipeline`)).body;
    expect(columns.map((c: { status: { name: string } }) => c.status.name)).toEqual(["New", "Contacted", "Interested", "Proposal", "Converted", "Lost"]);
    expect(columns[0]).toMatchObject({ count: 2, totalValue: 300.3 });
    expect(columns[4]).toMatchObject({ count: 1, totalValue: 50 });
    expect(columns[1]).toMatchObject({ count: 0, totalValue: 0, items: [] });
  });

  it("limits each pipeline column to its newest cards, within the caller's scope and filters", async () => {
    const { agent } = await signedIn(["leads"]);
    const other = await signedIn(["leads"]);
    const contacted = await statusByName("Contacted");
    for (const title of ["N1", "N2", "N3"]) await agent.post(`${API}/leads`).send({ title, contact: { name: "Test Contact" }, priority: "high" });
    await agent.post(`${API}/leads`).send({ title: "C1", contact: { name: "Test Contact" }, statusId: contacted.id, priority: "low" });
    await other.agent.post(`${API}/leads`).send({ title: "Someone else's", contact: { name: "Test Contact" } });

    const { columns } = (await agent.get(`${API}/leads/pipeline`).query({ perColumn: 2 })).body;
    expect(columns[0]).toMatchObject({ count: 3 }); // the count is the column's total, not just the cards sent
    expect(columns[0].items.map((l: { title: string }) => l.title)).toEqual(["N3", "N2"]);
    expect(columns[1].items.map((l: { title: string }) => l.title)).toEqual(["C1"]);

    const high = (await agent.get(`${API}/leads/pipeline`).query({ priority: "high" })).body.columns;
    expect(high.map((c: { count: number }) => c.count)).toEqual([3, 0, 0, 0, 0, 0]);
  });

  it("moves a lead between pipeline stages the way the board does: status and version only", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = (await agent.post(`${API}/leads`).send({ title: "Drag me", contact: { name: "Test Contact" }, expectedValue: 500 })).body;
    const proposal = await statusByName("Proposal");
    const lost = await statusByName("Lost");
    const stored = () => prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { statusId: true, version: true } });

    const moved = await agent.patch(`${API}/leads/${lead.id}`).send({ statusId: proposal.id, version: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: lead.id, status: { id: proposal.id, name: "Proposal" }, version: 2 });
    expect(await stored()).toEqual({ statusId: proposal.id, version: 2 }); // saved in PostgreSQL
    const { columns } = (await agent.get(`${API}/leads/pipeline`)).body; // what a page refresh shows
    expect(columns.find((c: { status: { name: string } }) => c.status.name === "Proposal")).toMatchObject({ count: 1, totalValue: 500, items: [{ id: lead.id }] });
    expect(columns[0]).toMatchObject({ count: 0, items: [] });

    // The same drop sent twice (or a move made from an out-of-date board) is refused, never applied twice.
    const repeat = await agent.patch(`${API}/leads/${lead.id}`).send({ statusId: lost.id, version: 1 });
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe("STALE_VERSION");

    // Stages that don't exist are refused by the server, whatever the board sent.
    for (const statusId of [crypto.randomUUID(), "not-a-stage"]) {
      const bad = await agent.patch(`${API}/leads/${lead.id}`).send({ statusId, version: 2 });
      expect(bad.status).toBe(422);
      expect(bad.body.error.fields).toHaveProperty("statusId");
    }

    // Someone who can't see the lead, or has no Leads access, cannot move it through the API either.
    const stranger = await signedIn(["leads"]);
    expect((await stranger.agent.patch(`${API}/leads/${lead.id}`).send({ statusId: lost.id, version: 2 })).status).toBe(404);
    const noLeads = await signedIn(["dashboard", "all_records"]);
    expect((await noLeads.agent.patch(`${API}/leads/${lead.id}`).send({ statusId: lost.id, version: 2 })).status).toBe(403);
    expect(await stored()).toEqual({ statusId: proposal.id, version: 2 }); // nothing above changed it

    const activity = (await agent.get(`${API}/leads/${lead.id}/activities`)).body.items.map((a: { type: string; text: string }) => [a.type, a.text]);
    expect(activity).toEqual([
      ["status_changed", "Status changed from New to Proposal"],
      ["customer_created", expect.any(String)],
      ["created", expect.any(String)],
    ]);
  });

  it("schedules reminders only in the future", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = (await agent.post(`${API}/leads`).send({ title: "R", contact: { name: "Test Contact" } })).body;
    const past = await agent.post(`${API}/leads/${lead.id}/reminders`).send({ title: "Call", dueAt: "2020-01-01T10:00:00Z" });
    expect(past.body.error.fields).toHaveProperty("dueAt");
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const ok = await agent.post(`${API}/leads/${lead.id}/reminders`).send({ title: "Call", dueAt, notes: "" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: "Call", notes: null });
  });
});
