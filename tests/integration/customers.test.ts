import { beforeEach, describe, expect, it } from "vitest";
import { API, hasDb, makeUser, prisma, resetDb, signedIn, sourceByName, statusByName } from "../helpers.ts";

const b2bLead = (sourceId: string, over: Record<string, unknown> = {}) => ({
  title: "Air freight to Dubai",
  description: "Negotiating a monthly rate",
  address: "MG Road, Kochi",
  district: "Ernakulam",
  contact: { name: "Arshad", phone: "9845616544", email: "Arshad03@Gmail.com" },
  customerType: "b2b",
  company: { name: "CRN Solutions", location: "Karnataka", email: "ops@crn.example" },
  sourceId,
  priority: "high",
  expectedValue: "249000.55",
  shipment: { destinationCountry: "United Arab Emirates", commodity: "Textiles", shipmentType: "air", weightKg: 1.5, volume: "2 CBM", pickupLocation: "Kochi", deliveryLocation: "Dubai" },
  ...over,
});

/** A lead from before customers were created automatically: in the database with no customer. Only these still convert. */
async function olderLead(ownerId: string, data: { title?: string; contactName?: string; contactPhone?: string; contactEmail?: string; companyName?: string } = {}) {
  const status = await statusByName("New");
  return prisma.lead.create({ data: { title: "Older lead", statusId: status.id, ownerId, createdById: ownerId, ...data } });
}
const customerOf = (leadId: string) => prisma.customer.findFirstOrThrow({ where: { leadId } });

describe.skipIf(!hasDb)("lead → customer: created with the lead", () => {
  beforeEach(resetDb);

  it("creating a lead creates exactly one customer with it: details copied once, linked both ways, the lead keeps its stage", async () => {
    const { agent, user } = await signedIn(["leads", "customers"]);
    const meta = await sourceByName("Meta Ads");
    const res = await agent.post(`${API}/leads`).send(b2bLead(meta.id));
    expect(res.status).toBe(201);
    const lead = res.body;
    expect(await prisma.customer.count()).toBe(1);
    const customer = await customerOf(lead.id);
    expect(customer.code).toMatch(/^CU-\d{5}$/);
    expect(lead).toMatchObject({ customer: { id: customer.id, code: customer.code, name: "Arshad", deleted: false }, convertedAt: null, status: { name: "New" }, version: 1 });
    // Mapped field by field; nothing invented, the description is not copied.
    expect(customer).toMatchObject({
      name: "Arshad",
      company: "CRN Solutions",
      phone: "+919845616544",
      email: "arshad03@gmail.com",
      address: "MG Road, Kochi",
      district: "Ernakulam",
      companyLocation: "Karnataka",
      companyEmail: "ops@crn.example",
      type: "b2b",
      sourceId: meta.id,
      assignedUserId: user.id,
      status: "active",
      note: null,
      leadId: lead.id,
    });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ customerId: customer.id, description: "Negotiating a monthly rate", convertedAt: null, version: 1 });
    const activity = (await agent.get(`${API}/leads/${lead.id}/activities`)).body.items.map((a: { type: string; text: string }) => [a.type, a.text]);
    expect(activity).toEqual([
      ["customer_created", `Customer ${customer.code} created`],
      ["created", `Lead created by ${user.name}`],
    ]);

    // Straight into the Customers section, and its details page shows the deal through the link.
    const list = (await agent.get(`${API}/customers`)).body;
    expect(list).toMatchObject({ total: 1, activeCount: 1, items: [{ id: customer.id, name: "Arshad", district: "Ernakulam", companyEmail: "ops@crn.example", leadId: lead.id }] });
    const detail = (await agent.get(`${API}/customers/${customer.id}`)).body;
    expect(detail).toMatchObject({ name: "Arshad", hiddenLeads: 0, leads: [{ id: lead.id, description: "Negotiating a monthly rate", expectedValue: 249000.55, attachments: [] }] });
    expect(detail.leads[0].shipment).toEqual({ destinationCountry: "United Arab Emirates", commodity: "Textiles", shipmentType: "air", weightKg: 1.5, volume: "2 CBM", pickupLocation: "Kochi", deliveryLocation: "Dubai" });

    // The old conversion has nothing left to do: it answers with this customer and changes nothing.
    const convert = await agent.post(`${API}/leads/${lead.id}/convert`).send({ createNew: true });
    expect(convert.status).toBe(200);
    expect(convert.body).toMatchObject({ created: false, alreadyConverted: true, customer: { id: customer.id } });
    expect((await agent.get(`${API}/leads/${lead.id}/conversion`)).body).toMatchObject({ alreadyConverted: true, customer: { id: customer.id } });
    // Nor does editing the lead: no second customer, and this one keeps what was copied.
    expect((await agent.patch(`${API}/leads/${lead.id}`).send({ contact: { name: "Changed on the lead" }, version: 1 })).status).toBe(200);
    expect(await prisma.customer.count()).toBe(1);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).name).toBe("Arshad");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).statusId).toBe((await statusByName("New")).id);
    expect(await prisma.auditLog.count({ where: { action: "lead_converted" } })).toBe(0);
  });

  it("never invents a name: the company's is used without a contact, and a lead with neither is refused (nothing saved)", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const companyOnly = await agent.post(`${API}/leads`).send({ title: "Sea freight", company: { name: "Blue Dart Exports" } });
    expect(companyOnly.status).toBe(201);
    expect(await customerOf(companyOnly.body.id)).toMatchObject({ name: "Blue Dart Exports", company: "Blue Dart Exports", phone: null, email: null, address: null, type: null });

    const bare = await agent.post(`${API}/leads`).send({ title: "Walk-in enquiry", contact: { name: "  ", phone: "9845616544" }, company: { name: "" } });
    expect(bare.status).toBe(422);
    expect(bare.body.error.fields).toEqual({ "contact.name": "Enter the customer's name, or a company name for a B2B lead" });
    expect([await prisma.lead.count(), await prisma.customer.count()]).toEqual([1, 1]);
  });

  it("is created for the lead's owner, also when the creator has no Customers access; seen only within customer scope", async () => {
    const staff = await signedIn(["leads"]);
    const colleague = await signedIn(["leads", "customers"]);
    const boss = await signedIn(["customers", "all_records"]);
    const res = await staff.agent.post(`${API}/leads`).send({ title: "Walk-in", contact: { name: "Kiran" } });
    expect(res.status).toBe(201);
    expect(res.body.customer).toMatchObject({ name: "Kiran", deleted: false });
    const mine = await customerOf(res.body.id);
    expect(mine.assignedUserId).toBe(staff.user.id);
    expect((await staff.agent.get(`${API}/customers`)).status).toBe(403);
    expect((await staff.agent.get(`${API}/customers/${mine.id}`)).status).toBe(403);
    expect((await colleague.agent.get(`${API}/customers`)).body.total).toBe(0);
    expect((await colleague.agent.get(`${API}/customers/${mine.id}`)).status).toBe(404);
    expect((await boss.agent.get(`${API}/customers`)).body.items.map((c: { id: string }) => c.id)).toEqual([mine.id]);

    // Created for someone else: the customer is theirs too, like the lead.
    const handed = await staff.agent.post(`${API}/leads`).send({ title: "Handover", contact: { name: "Latha" }, ownerId: colleague.user.id });
    expect((await customerOf(handed.body.id)).assignedUserId).toBe(colleague.user.id);
    expect((await colleague.agent.get(`${API}/customers`)).body.items.map((c: { name: string }) => c.name)).toEqual(["Latha"]);
  });

  it("lead and customer are saved together: a database failure creating the customer saves neither, and a retry works", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const id = crypto.randomUUID();
    const body = { id, title: "Rollback", contact: { name: "Ravi" } };
    // A real PostgreSQL error on the customer insert, not a mock.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_customer() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_customer BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION test_fail_customer()`);
    try {
      const failed = await agent.post(`${API}/leads`).send(body);
      expect(failed.status).toBe(500);
      expect(failed.body.error.message).not.toMatch(/simulated|trigger|sql|customers/i);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_customer ON customers`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_customer()`);
    }
    expect([await prisma.lead.count(), await prisma.customer.count(), await prisma.leadActivity.count()]).toEqual([0, 0, 0]);
    const retry = await agent.post(`${API}/leads`).send(body);
    expect(retry.status).toBe(201);
    expect(await prisma.customer.count({ where: { leadId: id } })).toBe(1);
  });

  it("the same form sent again, or many times at once, gives one lead and one customer", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const once = { id: crypto.randomUUID(), title: "Once", contact: { name: "Ann" } };
    const first = await agent.post(`${API}/leads`).send(once);
    const again = await agent.post(`${API}/leads`).send(once);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.customer.id).toBe(first.body.customer.id);

    const burstBody = { id: crypto.randomUUID(), title: "Double click", contact: { name: "Bea" } };
    const burst = await Promise.all(Array.from({ length: 6 }, () => agent.post(`${API}/leads`).send(burstBody)));
    expect(burst.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(burst.map((r) => r.body.customer.id)).size).toBe(1);
    expect([await prisma.lead.count(), await prisma.customer.count(), await prisma.leadActivity.count({ where: { type: "customer_created" } })]).toEqual([2, 2, 2]);
  });

  it("gives every customer a unique CU code from a sequence, also under concurrent lead creation", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) => agent.post(`${API}/leads`).send({ title: `L${i}`, contact: { name: `Person ${i}` } })));
    expect(created.every((r) => r.status === 201)).toBe(true);
    const codes = created.map((r) => r.body.customer.code as string);
    expect(new Set(codes).size).toBe(8);
    expect(codes.every((c) => /^CU-\d{5}$/.test(c))).toBe(true);
    const stored = await prisma.customer.findMany({ select: { code: true } });
    expect(new Set(stored.map((c) => c.code)).size).toBe(stored.length);
    // Searchable by code.
    expect((await agent.get(`${API}/customers`).query({ q: codes[3] })).body.items.map((c: { code: string }) => c.code)).toEqual([codes[3]]);
  });

  it("the database itself refuses to relink a lead to another customer, or unlink it", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const lead = (await agent.post(`${API}/leads`).send({ title: "Once", contact: { name: "Ann" } })).body;
    const other = (await agent.post(`${API}/leads`).send({ title: "Other", contact: { name: "Bea" } })).body;
    await expect(prisma.lead.update({ where: { id: lead.id }, data: { customerId: other.customer.id } })).rejects.toThrow();
    await expect(prisma.lead.update({ where: { id: lead.id }, data: { customerId: null } })).rejects.toThrow();
    await expect(prisma.customer.create({ data: { name: "Second", leadId: lead.id } })).rejects.toThrow(); // one customer per source lead
  });
});

describe.skipIf(!hasDb)("older leads without a customer: conversion", () => {
  beforeEach(resetDb);

  it("converts once, copying what the lead holds, moving it to the won stage; a lead with no name is refused", async () => {
    const { agent, user } = await signedIn(["leads", "customers"]);
    const lead = await olderLead(user.id, { contactName: "Arshad", contactPhone: "+919845616544", companyName: "CRN Solutions" });
    expect((await agent.get(`${API}/leads/${lead.id}/conversion`)).body).toMatchObject({ alreadyConverted: false, missing: [], moveTo: { name: "Converted" }, customer: { name: "Arshad" } });
    const res = await agent.post(`${API}/leads/${lead.id}/convert`).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, customer: { name: "Arshad", company: "CRN Solutions", phone: "+919845616544", leadId: lead.id }, lead: { status: { name: "Converted" }, version: 2 } });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).convertedAt).toBeInstanceOf(Date);
    expect(await prisma.auditLog.count({ where: { action: "lead_converted", entityId: lead.id } })).toBe(1);

    const bare = await olderLead(user.id);
    expect((await agent.get(`${API}/leads/${bare.id}/conversion`)).body).toMatchObject({ missing: ["name"], customer: { name: null } });
    const refused = await agent.post(`${API}/leads/${bare.id}/convert`).send({});
    expect([refused.status, refused.body.error.code]).toEqual([422, "CUSTOMER_NAME_MISSING"]);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("repeated and concurrent conversions of one lead give exactly one customer", async () => {
    const { agent, user } = await signedIn(["leads", "customers"]);
    const first = await olderLead(user.id, { contactName: "Arshad" });
    const created = await agent.post(`${API}/leads/${first.id}/convert`).send({});
    const again = await agent.post(`${API}/leads/${first.id}/convert`).send({ createNew: true });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, alreadyConverted: true, customer: { id: created.body.customer.id } });

    const second = await olderLead(user.id, { contactName: "Meera" });
    const burst = await Promise.all(Array.from({ length: 6 }, () => agent.post(`${API}/leads/${second.id}/convert`).send({})));
    expect(burst.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(burst.filter((r) => r.body.created)).toHaveLength(1);
    expect(new Set(burst.map((r) => r.body.customer.id)).size).toBe(1);
    expect(await prisma.customer.count({ where: { leadId: second.id } })).toBe(1);
    expect(await prisma.leadActivity.count({ where: { leadId: second.id, type: "converted" } })).toBe(1);
    expect(await prisma.customer.count()).toBe(2);
  });

  it("possible matches (email, phone, company) need a decision; linking never changes the existing customer", async () => {
    const owner = await signedIn(["leads", "customers"]);
    const meta = await sourceByName("Meta Ads");
    const first = (await owner.agent.post(`${API}/leads`).send(b2bLead(meta.id))).body;
    const arshad = first.customer;

    // Same email, another contact name and phone: offered as a match, not merged.
    const repeat = await olderLead(owner.user.id, { title: "Second shipment", contactName: "A. Mohammed", contactPhone: "+919876543210", contactEmail: "arshad03@gmail.com" });
    const preview = (await owner.agent.get(`${API}/leads/${repeat.id}/conversion`)).body;
    expect(preview).toMatchObject({ matches: [{ id: arshad.id, matchedOn: ["email"] }] });
    const undecided = await owner.agent.post(`${API}/leads/${repeat.id}/convert`).send({});
    expect([undecided.status, undecided.body.error.code]).toEqual([409, "POSSIBLE_DUPLICATE"]);
    expect(await prisma.customer.count()).toBe(1);

    const linked = await owner.agent.post(`${API}/leads/${repeat.id}/convert`).send({ customerId: arshad.id });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ created: false, customer: { id: arshad.id, name: "Arshad", phone: "+919845616544" } });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: arshad.id } })).toMatchObject({ name: "Arshad", phone: "+919845616544", leadId: first.id });
    expect((await owner.agent.get(`${API}/customers/${arshad.id}`)).body.leads.map((l: { id: string }) => l.id).sort()).toEqual([first.id, repeat.id].sort());
    const repeatActivity = (await owner.agent.get(`${API}/leads/${repeat.id}/activities`)).body.items.map((a: { text: string }) => a.text);
    expect(repeatActivity).toContain("Linked to existing customer Arshad");

    // Same company, different person: the user may confirm a separate customer.
    const colleague = await olderLead(owner.user.id, { title: "Third", contactName: "Priya", companyName: "crn solutions" });
    expect((await owner.agent.get(`${API}/leads/${colleague.id}/conversion`)).body.matches).toMatchObject([{ id: arshad.id, matchedOn: ["company"] }]);
    const separate = await owner.agent.post(`${API}/leads/${colleague.id}/convert`).send({ createNew: true });
    expect(separate.status).toBe(201);
    expect(separate.body.customer).toMatchObject({ name: "Priya", company: "crn solutions" });
    expect(await prisma.customer.count()).toBe(2);

    // Phone matches too.
    const byPhone = await olderLead(owner.user.id, { title: "Fourth", contactName: "Someone", contactPhone: "+919845616544" });
    expect((await owner.agent.get(`${API}/leads/${byPhone.id}/conversion`)).body.matches).toMatchObject([{ id: arshad.id, matchedOn: ["phone"] }]);
  });

  it("customers outside the caller's scope are never shown, counted or linked", async () => {
    const owner = await signedIn(["leads", "customers"]);
    const other = await signedIn(["leads", "customers"]);
    const meta = await sourceByName("Meta Ads");
    const arshad = (await owner.agent.post(`${API}/leads`).send(b2bLead(meta.id))).body.customer;

    const theirs = await olderLead(other.user.id, { title: "Same person", contactName: "Arshad", contactEmail: "arshad03@gmail.com" });
    const preview = (await other.agent.get(`${API}/leads/${theirs.id}/conversion`)).body;
    expect(preview.matches).toEqual([]);
    expect(preview).not.toHaveProperty("hiddenMatches"); // not even how many: counts would reveal records out of scope
    expect(JSON.stringify(preview)).not.toContain(arshad.id);
    expect((await other.agent.post(`${API}/leads/${theirs.id}/convert`).send({ customerId: arshad.id })).status).toBe(404);
    expect((await other.agent.post(`${API}/leads/${theirs.id}/convert`).send({})).status).toBe(201);
  });

  it("a database failure mid-conversion rolls everything back", async () => {
    const { agent, user } = await signedIn(["leads", "customers"]);
    const lead = await olderLead(user.id, { title: "Rollback", contactName: "Ravi" });
    // A real PostgreSQL error at the last write of the transaction (the activity row), not a mock.
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION test_fail_conversion() RETURNS trigger AS $$ BEGIN IF NEW.type = 'converted' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_conversion BEFORE INSERT ON lead_activities FOR EACH ROW EXECUTE FUNCTION test_fail_conversion()`);
    try {
      const failed = await agent.post(`${API}/leads/${lead.id}/convert`).send({});
      expect(failed.status).toBe(500);
      expect(failed.body.error.message).not.toMatch(/simulated|trigger|sql/i);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_conversion ON lead_activities`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_conversion()`);
    }
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ customerId: null, convertedAt: null, version: 1, statusId: (await statusByName("New")).id });
    expect(await prisma.auditLog.count({ where: { action: "lead_converted" } })).toBe(0);
    expect((await agent.post(`${API}/leads/${lead.id}/convert`).send({})).status).toBe(201); // and a retry then works
  });

  it("needs Leads and Customers access, within the caller's scope; files follow the lead's access", async () => {
    const leadsOnly = await signedIn(["leads"]);
    const customersOnly = await signedIn(["customers", "all_records"]);
    const bde = await signedIn(["leads", "customers"]);
    const otherBde = await signedIn(["leads", "customers"]);
    const boss = await signedIn(["leads", "customers", "all_records"]);
    const lead = await olderLead(bde.user.id, { title: "BDE's lead", contactName: "Kiran" });
    await prisma.leadAttachment.create({
      data: { leadId: lead.id, publicId: `mcl-crm-test/leads/${lead.id}/x`, resourceType: "image", fileName: "rate-card.jpg", mimeType: "image/jpeg", sizeBytes: 1234, uploadedById: bde.user.id },
    });

    expect((await leadsOnly.agent.post(`${API}/leads/${lead.id}/convert`).send({})).status).toBe(403);
    expect((await customersOnly.agent.post(`${API}/leads/${lead.id}/convert`).send({})).status).toBe(403);
    expect((await otherBde.agent.get(`${API}/leads/${lead.id}/conversion`)).status).toBe(404);
    expect((await otherBde.agent.post(`${API}/leads/${lead.id}/convert`).send({})).status).toBe(404);

    // Converted by a manager: the customer stays with the lead's owner, who sees it without "All records".
    const res = await boss.agent.post(`${API}/leads/${lead.id}/convert`).send({});
    expect(res.status).toBe(201);
    const id = res.body.customer.id;
    expect(res.body.customer.assignee).toEqual({ id: bde.user.id, name: bde.user.name });
    expect((await bde.agent.get(`${API}/customers`)).body.total).toBe(1);
    expect((await bde.agent.get(`${API}/customers/${id}`)).body.leads[0].attachments).toMatchObject([{ fileName: "rate-card.jpg" }]);
    expect((await otherBde.agent.get(`${API}/customers`)).body.total).toBe(0);
    for (const r of [await otherBde.agent.get(`${API}/customers/${id}`), await otherBde.agent.patch(`${API}/customers/${id}`).send({ note: "x" })]) expect(r.status).toBe(404);

    // Customers access without Leads access: the customer, but none of the lead's deal or files.
    const seen = (await customersOnly.agent.get(`${API}/customers/${id}`)).body;
    expect(seen).toMatchObject({ name: "Kiran", leads: [], hiddenLeads: 1 });
    expect(JSON.stringify(seen)).not.toContain("rate-card.jpg");
  });
});

describe.skipIf(!hasDb)("customers", () => {
  beforeEach(resetDb);

  it("edits a customer on its own: validated, audited without contact details, never synced with the lead", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const inactive = await makeUser(["leads"], { status: "inactive" });
    const meta = await sourceByName("Meta Ads");
    const lead = (await agent.post(`${API}/leads`).send(b2bLead(meta.id))).body;
    const id = lead.customer.id;

    const bad = await agent.patch(`${API}/customers/${id}`).send({ name: " ", phone: "12", email: "not-an-email", type: "vip", leadId: lead.id });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields).sort()).toEqual(["body", "email", "name", "phone", "type"]); // "body": leadId can't be set
    expect((await agent.patch(`${API}/customers/${id}`).send({ assignedUserId: inactive.user.id })).status).toBe(403); // can't reassign at all
    const boss = await signedIn(["customers", "all_records"]);
    expect((await boss.agent.patch(`${API}/customers/${id}`).send({ assignedUserId: inactive.user.id })).status).toBe(422); // nor to an inactive user

    const saved = await agent.patch(`${API}/customers/${id}`).send({ name: "Arshad K", phone: "98456 16545", note: "Prefers WhatsApp", type: "direct", company: "", status: "inactive" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: "Arshad K", phone: "+919845616545", note: "Prefers WhatsApp", type: "direct", company: null, status: "inactive", district: "Ernakulam" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "customer_updated", entityId: id } });
    expect(JSON.stringify([audit.before, audit.after])).not.toMatch(/9845616545|Arshad K|WhatsApp/);

    // The lead keeps what was collected, and editing it later doesn't reach the customer.
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ contactName: "Arshad", contactPhone: "+919845616544", companyName: "CRN Solutions" });
    await agent.patch(`${API}/leads/${lead.id}`).send({ contact: { name: "Changed on the lead" } });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id } })).name).toBe("Arshad K");
  });

  it("filters customers by status, type and source, and searches the new fields", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const meta = await sourceByName("Meta Ads");
    const ca = (await agent.post(`${API}/leads`).send(b2bLead(meta.id))).body.customer;
    const cb = (await agent.post(`${API}/leads`).send({ title: "Direct", contact: { name: "Neha" }, customerType: "direct", district: "Thrissur" })).body.customer;
    await agent.patch(`${API}/customers/${cb.id}`).send({ status: "inactive" });
    const ids = async (query: Record<string, string>) => (await agent.get(`${API}/customers`).query(query)).body.items.map((c: { id: string }) => c.id);
    expect(await ids({ status: "inactive" })).toEqual([cb.id]);
    expect(await ids({ type: "b2b" })).toEqual([ca.id]);
    expect(await ids({ sourceId: meta.id })).toEqual([ca.id]);
    expect(await ids({ q: "thrissur" })).toEqual([cb.id]);
    expect(await ids({ q: "ops@crn" })).toEqual([ca.id]);
    expect((await agent.get(`${API}/customers`).query({ type: "vip" })).status).toBe(422);
  });

  it("deactivates instead of deleting; the active count follows, inactive customers stay viewable", async () => {
    const { agent } = await signedIn(["leads", "customers"]);
    const alpha = (await agent.post(`${API}/leads`).send({ title: "A", contact: { name: "Alpha" } })).body.customer;
    await agent.post(`${API}/leads`).send({ title: "B", contact: { name: "Bravo" } });
    expect((await agent.get(`${API}/customers`)).body.activeCount).toBe(2);

    const off = await agent.patch(`${API}/customers/${alpha.id}`).send({ status: "inactive" });
    expect(off.body.status).toBe("inactive");
    expect((await agent.get(`${API}/customers`)).body).toMatchObject({ activeCount: 1, total: 2 });
    expect((await agent.get(`${API}/customers`).query({ status: "inactive" })).body.items.map((c: { id: string }) => c.id)).toEqual([alpha.id]);
    expect((await agent.get(`${API}/customers/${alpha.id}`)).status).toBe(200);
    expect((await agent.delete(`${API}/customers/${alpha.id}`)).status).toBe(405);
    expect(await prisma.customer.count()).toBe(2);
    expect((await agent.patch(`${API}/customers/${alpha.id}`).send({ status: "active" })).body.status).toBe("active");
    expect((await agent.get(`${API}/customers`)).body.activeCount).toBe(2);
  });

  it("only roles that see all records may reassign a customer", async () => {
    const bde = await signedIn(["leads", "customers"]);
    const colleague = await makeUser(["leads", "customers"]);
    const boss = await signedIn(["leads", "customers", "all_records"]);
    const id = (await bde.agent.post(`${API}/leads`).send({ title: "Mine", contact: { name: "Kiran" } })).body.customer.id;

    const refused = await bde.agent.patch(`${API}/customers/${id}`).send({ assignedUserId: colleague.user.id });
    expect(refused.status).toBe(403);
    expect(refused.body.error.fields).toHaveProperty("assignedUserId");
    expect((await bde.agent.patch(`${API}/customers/${id}`).send({ assignedUserId: bde.user.id, note: "unchanged owner is fine" })).status).toBe(200);
    expect((await boss.agent.patch(`${API}/customers/${id}`).send({ assignedUserId: colleague.user.id })).body.assignee.id).toBe(colleague.user.id);
    expect((await bde.agent.get(`${API}/customers/${id}`)).status).toBe(404); // no longer theirs
  });

  it("filters by assignee and creation date, pages accurately, and scoped counts reveal nothing outside the scope", async () => {
    const boss = await signedIn(["leads", "customers", "all_records"]);
    const bde = await signedIn(["leads", "customers"]);
    for (const [who, n] of [[boss, 3], [bde, 2]] as const)
      for (let i = 0; i < n; i++) await who.agent.post(`${API}/leads`).send({ title: `T${i}`, contact: { name: `${who.user.name} ${i}` } });
    const all = (await boss.agent.get(`${API}/customers`)).body;
    expect(all).toMatchObject({ total: 5, activeCount: 5 });
    expect((await boss.agent.get(`${API}/customers`).query({ assignedUserId: bde.user.id })).body.total).toBe(2);
    const page2 = (await boss.agent.get(`${API}/customers`).query({ pageSize: 2, page: 2 })).body;
    expect(page2).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(2);
    expect(new Set([...all.items.slice(2, 4).map((c: { id: string }) => c.id)])).toEqual(new Set(page2.items.map((c: { id: string }) => c.id)));
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await boss.agent.get(`${API}/customers`).query({ createdFrom: tomorrow })).body.total).toBe(0);
    expect((await boss.agent.get(`${API}/customers`).query({ createdFrom: "2020-01-01" })).body.total).toBe(5);
    expect((await boss.agent.get(`${API}/customers`).query({ createdFrom: "15/10/2026" })).status).toBe(422);
    // The BDE: only their two, in the list and in every count — even when asking for the boss's customers.
    expect((await bde.agent.get(`${API}/customers`)).body).toMatchObject({ total: 2, activeCount: 2 });
    expect((await bde.agent.get(`${API}/customers`).query({ assignedUserId: boss.user.id })).body).toMatchObject({ total: 0, activeCount: 2 });
  });

  it("records Initial / Follow Up / Call activities: validated, newest first, once per retry, within scope", async () => {
    const { agent, user } = await signedIn(["leads", "customers"]);
    const stranger = await signedIn(["leads", "customers"]);
    const noCustomers = await signedIn(["leads", "all_records"]);
    const id = (await agent.post(`${API}/leads`).send({ title: "Acts", contact: { name: "Neha" } })).body.customer.id;
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

    const first = await agent.post(`${API}/customers/${id}/activities`).send({ type: "initial", occurredAt: at(48), notes: "Intro meeting" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ type: "initial", notes: "Intro meeting", actor: { id: user.id } });
    const entryId = crypto.randomUUID();
    const call = await agent.post(`${API}/customers/${id}/activities`).send({ id: entryId, type: "call", occurredAt: at(1) });
    expect(call.status).toBe(201);
    const retry = await agent.post(`${API}/customers/${id}/activities`).send({ id: entryId, type: "call", occurredAt: at(1) });
    expect([retry.status, retry.body.id]).toEqual([200, entryId]);
    await agent.post(`${API}/customers/${id}/activities`).send({ type: "follow_up", occurredAt: at(24), notes: "Sent the rate card" });

    const list = (await agent.get(`${API}/customers/${id}/activities`)).body;
    expect(list.total).toBe(3);
    expect(list.items.map((a: { type: string }) => a.type)).toEqual(["call", "follow_up", "initial"]);

    const bad = await agent.post(`${API}/customers/${id}/activities`).send({ type: "visit", occurredAt: "yesterday", notes: "x".repeat(2001) });
    expect(Object.keys(bad.body.error.fields).sort()).toEqual(["notes", "occurredAt", "type"]);
    const future = await agent.post(`${API}/customers/${id}/activities`).send({ type: "call", occurredAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(future.body.error.fields).toEqual({ occurredAt: "Can't be in the future" });

    for (const r of [await stranger.agent.get(`${API}/customers/${id}/activities`), await stranger.agent.post(`${API}/customers/${id}/activities`).send({ type: "call", occurredAt: at(1) })])
      expect(r.status).toBe(404);
    expect((await noCustomers.agent.get(`${API}/customers/${id}/activities`)).status).toBe(403);
    expect(await prisma.customerActivity.count()).toBe(3);
  });
});
