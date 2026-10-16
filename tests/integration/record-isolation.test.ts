import { beforeAll, describe, expect, it } from "vitest";
import { ALL, API, hasDb, login, prisma, resetDb, signedIn } from "../helpers.ts";

// Record-level authorisation end to end: page permissions open a module, "all_records" widens what it shows.
// Two users with the same module access each own a lead → customer → follow-up; a third has All Records.
const MODULES = ["dashboard", "leads", "customers", "follow_ups", "modules"] as const;
type Agent = Awaited<ReturnType<typeof signedIn>>["agent"];

async function ownRecords(agent: Agent, name: string) {
  const lead = (await agent.post(`${API}/leads`).send({ title: `${name} lead`, priority: "high", contact: { name: `${name} Contact` } })).body;
  const customer = (await agent.post(`${API}/leads/${lead.id}/convert`).send({ createNew: true })).body.customer;
  const followUp = (await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: "2026-12-01", note: `${name} call`, type: "call" })).body;
  return { lead, customer, followUp };
}
const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((x) => x.id).sort();

describe.skipIf(!hasDb)("record isolation", () => {
  let a: Awaited<ReturnType<typeof signedIn>>, b: typeof a, all: typeof a, admin: typeof a;
  let A: Awaited<ReturnType<typeof ownRecords>>, B: typeof A;

  beforeAll(async () => {
    await resetDb();
    [a, b, all, admin] = [await signedIn([...MODULES]), await signedIn([...MODULES]), await signedIn([...MODULES, "all_records"]), await signedIn(ALL)];
    A = await ownRecords(a.agent, "Alpha");
    B = await ownRecords(b.agent, "Bravo");
  });

  it("without All Records: lists, search, filters, pagination, pipeline, lookups and dashboard hold only your own records", async () => {
    const g = (p: string) => a.agent.get(`${API}${p}`);
    expect(ids(await g("/leads"))).toEqual([A.lead.id]);
    expect((await g("/leads?q=Bravo")).body.total).toBe(0);
    expect(ids(await g("/leads?priority=high"))).toEqual([A.lead.id]);
    expect(await g("/leads?page=2&pageSize=1").then((r) => [r.body.items.length, r.body.total])).toEqual([0, 1]);
    const board = (await g("/leads/pipeline")).body.columns as { count: number; items: { id: string }[] }[];
    expect(board.flatMap((c) => c.items.map((i) => i.id))).toEqual([A.lead.id]);
    expect(board.reduce((n, c) => n + c.count, 0)).toBe(1);
    expect(ids(await g("/customers"))).toEqual([A.customer.id]);
    expect((await g(`/customers?q=${B.customer.code}`)).body.total).toBe(0);
    expect((await g("/customers")).body.activeCount).toBe(1);
    expect(ids(await g("/follow-ups"))).toEqual([A.followUp.id]);
    expect((await g("/follow-ups?q=Bravo")).body.total).toBe(0);
    expect((await g("/lookups/lead-contacts")).body.map((l: { leadId: string }) => l.leadId)).toEqual([A.lead.id]);
    expect((await g("/dashboard/summary")).body.kpis).toMatchObject({ totalLeads: 1, activeCustomers: 1 });
  });

  it("someone else's record by id: every read and write answers 404 (as if it did not exist) and changes nothing", async () => {
    const x = a.agent;
    const L = `${API}/leads/${B.lead.id}`, C = `${API}/customers/${B.customer.id}`;
    // Built lazily: a supertest request starts its own server when created, so each is sent as it is made.
    const tries: [string, () => PromiseLike<{ status: number }>][] = [
      ["GET lead", () => x.get(L)], ["PATCH lead", () => x.patch(L).send({ title: "taken" })], ["DELETE lead", () => x.delete(L)],
      ["assign lead", () => x.post(`${L}/assign`).send({ ownerId: a.user.id })], ["lead activities", () => x.get(`${L}/activities`)],
      ["lead reminder", () => x.post(`${L}/reminders`).send({ title: "x", dueAt: "2030-01-01T10:00:00+05:30" })],
      ["conversion preview", () => x.get(`${L}/conversion`)], ["convert", () => x.post(`${L}/convert`).send({ createNew: true })],
      ["lead file", () => x.get(`${L}/attachments/${B.lead.id}`)],
      ["GET customer", () => x.get(C)], ["PATCH customer", () => x.patch(C).send({ name: "taken" })], ["customer activities", () => x.get(`${C}/activities`)],
      ["add customer activity", () => x.post(`${C}/activities`).send({ type: "call", occurredAt: "2026-10-01T10:00:00+05:30" })],
      ["customer file", () => x.get(`${C}/attachments/${B.customer.id}`)],
      ["complete follow-up", () => x.post(`${API}/follow-ups/${B.followUp.id}/complete`)],
    ];
    for (const [what, send] of tries) expect([what, (await send()).status]).toEqual([what, 404]);
    // Linking someone else's customer, or adding a follow-up to someone else's lead, is refused the same way.
    // An older lead of A's, still without a customer (new leads come with their own, so only these convert).
    const status = await prisma.leadStatus.findFirstOrThrow();
    const fresh = await prisma.lead.create({ data: { title: "Alpha second lead", contactName: "Alpha Two", statusId: status.id, ownerId: a.user.id, createdById: a.user.id } });
    expect((await x.post(`${API}/leads/${fresh.id}/convert`).send({ customerId: B.customer.id })).status).toBe(404);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: fresh.id } })).customerId).toBeNull();
    expect((await x.delete(`${API}/leads/${fresh.id}`)).status).toBe(204); // A's own: the later counts stay 1 + 1
    expect((await x.post(`${API}/follow-ups`).send({ leadId: B.lead.id, followUpDate: "2026-12-01", note: "x", type: "call" })).body.error.fields).toEqual({ leadId: "Unknown lead" });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: B.lead.id } });
    expect([lead.title, lead.deletedAt, lead.ownerId]).toEqual(["Bravo lead", null, b.user.id]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: B.customer.id } })).name).toBe("Bravo Contact");
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: B.followUp.id } })).status).toBe("pending");
  });

  it("with All Records: every user's records, in lists, search and details", async () => {
    const g = (p: string) => all.agent.get(`${API}${p}`);
    expect(ids(await g("/leads"))).toEqual([A.lead.id, B.lead.id].sort());
    expect(ids(await g("/leads?q=Bravo"))).toEqual([B.lead.id]);
    expect(ids(await g("/customers"))).toEqual([A.customer.id, B.customer.id].sort());
    expect(ids(await g("/follow-ups"))).toEqual([A.followUp.id, B.followUp.id].sort());
    expect((await g(`/leads/${B.lead.id}`)).status).toBe(200);
    expect((await g(`/customers/${A.customer.id}`)).status).toBe(200);
    expect((await g("/dashboard/summary")).body.kpis.totalLeads).toBe(2);
  });

  it("a role change applies from the next request, and after signing in again", async () => {
    const count = (agent: Agent) => agent.get(`${API}/leads`).then((r) => r.body.total);
    const role = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id }, select: { roleId: true } });
    const set = (permissions: string[]) => admin.agent.patch(`${API}/roles/${role.roleId}`).send({ permissions });
    expect((await set([...MODULES, "all_records"])).status).toBe(200);
    expect(await count(a.agent)).toBe(2);
    expect(await count(await login(a.email))).toBe(2);
    expect((await set([...MODULES])).status).toBe(200);
    expect(await count(a.agent)).toBe(1);
    expect(await count(await login(a.email))).toBe(1);
  });

  it("without a module's permission its API is refused, whatever else the role holds (All Records included)", async () => {
    const { agent } = await signedIn(["modules", "all_records"]);
    for (const p of ["/leads", "/leads/pipeline", `/leads/${A.lead.id}`, "/customers", `/customers/${A.customer.id}`, "/follow-ups", "/dashboard/summary"])
      expect([p, (await agent.get(`${API}${p}`)).status]).toEqual([p, 403]);
  });

  it("API answers are never stored by the browser (no-store): a shared computer keeps no one's records", async () => {
    expect((await a.agent.get(`${API}/leads`)).headers["cache-control"]).toBe("no-store");
  });
});
