import { beforeEach, describe, expect, it } from "vitest";
import { todayIST } from "../../src/lib/format.ts";
import { API, hasDb, makeUser, prisma, resetDb, signedIn } from "../helpers.ts";

const dayOffset = (days: number) => todayIST(new Date(Date.now() + days * 86_400_000));

describe.skipIf(!hasDb)("follow-ups", () => {
  beforeEach(resetDb);

  async function setup() {
    const me = await signedIn(["leads", "follow_ups"]);
    const lead = (await me.agent.post(`${API}/leads`).send({ title: "Proposal", company: { name: "MediShip" }, contact: { name: "Ribeesh" } })).body;
    return { ...me, lead };
  }

  it("creates a follow-up assigned to the creator by default", async () => {
    const { agent, user, lead } = await setup();
    const res = await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(2), note: "Follow up on proposal", type: "whatsapp" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      note: "Follow up on proposal",
      lead: { id: lead.id, label: "MediShip - Ribeesh" },
      type: "whatsapp",
      assignee: { id: user.id },
      status: "pending",
      dueDate: dayOffset(2),
      completedAt: null,
    });
    const activity = (await agent.get(`${API}/leads/${lead.id}/activities`)).body.items[0];
    expect(activity.type).toBe("follow_up_added");
  });

  it("validates note, date, type, lead scope and assignee", async () => {
    const { agent, lead } = await setup();
    const stranger = await signedIn(["leads", "follow_ups"]);
    const strangersLead = (await stranger.agent.post(`${API}/leads`).send({ title: "Not yours", contact: { name: "Test Contact" } })).body;
    const inactive = await makeUser(["follow_ups"], { status: "inactive" });
    const base = { leadId: lead.id, followUpDate: dayOffset(1), note: "x", type: "call" };

    expect((await agent.post(`${API}/follow-ups`).send({ ...base, note: "" })).body.error.fields).toHaveProperty("note");
    expect((await agent.post(`${API}/follow-ups`).send({ ...base, followUpDate: "13/10/2026" })).body.error.fields).toHaveProperty("followUpDate");
    expect((await agent.post(`${API}/follow-ups`).send({ ...base, type: "sms" })).body.error.fields).toHaveProperty("type");
    expect((await agent.post(`${API}/follow-ups`).send({ ...base, leadId: strangersLead.id })).body.error.fields).toHaveProperty("leadId");
    expect((await agent.post(`${API}/follow-ups`).send({ ...base, assignedUserId: inactive.user.id })).body.error.fields).toHaveProperty("assignedUserId");
  });

  it("derives overdue from the India date and filters/counts by it", async () => {
    const { agent, lead } = await setup();
    for (const [d, note] of [[-3, "late"], [0, "today"], [5, "later"]] as const)
      await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(d), note, type: "call" });

    const all = (await agent.get(`${API}/follow-ups`)).body;
    expect(all).toMatchObject({ total: 3, pendingCount: 2, overdueCount: 1 });
    expect(all.items.map((f: { note: string; status: string }) => [f.note, f.status])).toEqual([["late", "overdue"], ["today", "pending"], ["later", "pending"]]);
    expect((await agent.get(`${API}/follow-ups`).query({ status: "overdue" })).body.items.map((f: { note: string }) => f.note)).toEqual(["late"]);
    expect((await agent.get(`${API}/follow-ups`).query({ q: "medi" })).body.total).toBe(3);
  });

  it("completes once, idempotently, and logs it on the lead", async () => {
    const { agent, lead } = await setup();
    const f = (await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(-1), note: "Call back", type: "call" })).body;
    const done = await agent.post(`${API}/follow-ups/${f.id}/complete`);
    expect(done.body).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    const again = await agent.post(`${API}/follow-ups/${f.id}/complete`);
    expect(again.body.completedAt).toBe(done.body.completedAt);
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, type: "follow_up_completed" } })).toBe(1);
  });

  it("keeps follow-ups private to their assignee unless the role has All records", async () => {
    const { agent, lead } = await setup();
    const f = (await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(1), note: "Mine", type: "email" })).body;
    const other = await signedIn(["follow_ups"]);
    const boss = await signedIn(["follow_ups", "all_records"]);
    expect((await other.agent.get(`${API}/follow-ups`)).body.total).toBe(0);
    expect((await other.agent.post(`${API}/follow-ups/${f.id}/complete`)).status).toBe(404);
    expect((await boss.agent.get(`${API}/follow-ups`)).body.total).toBe(1);
  });

  it("lists open follow-ups by due date (overdue first), then completed ones, most recently completed first", async () => {
    const { agent, lead } = await setup();
    const add = async (days: number, note: string) => (await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(days), note, type: "call" })).body;
    const old = await add(-30, "done first");
    const recent = await add(-40, "done just now");
    await add(3, "later");
    await add(-2, "overdue");
    await add(0, "today");
    await agent.post(`${API}/follow-ups/${old.id}/complete`);
    await agent.post(`${API}/follow-ups/${recent.id}/complete`);
    const notes = (await agent.get(`${API}/follow-ups`)).body.items.map((f: { note: string }) => f.note);
    expect(notes).toEqual(["overdue", "today", "later", "done just now", "done first"]);
  });

  it("edits only what changed, logs it on the lead, and validates like create", async () => {
    const { agent, lead } = await setup();
    const colleague = await makeUser(["follow_ups"]);
    const inactive = await makeUser(["follow_ups"], { status: "inactive" });
    const f = (await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(1), note: "Call back", type: "call" })).body;
    const edit = (body: object) => agent.patch(`${API}/follow-ups/${f.id}`).send(body);

    const res = await edit({ note: "Send the revised quote", type: "email", followUpDate: dayOffset(-1), nextFollowUpDate: dayOffset(3), assignedUserId: colleague.user.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ note: "Send the revised quote", type: "email", status: "overdue", dueDate: dayOffset(-1), nextFollowUpDate: dayOffset(3), assignee: { id: colleague.user.id }, lead: { id: lead.id } });
    expect(await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ note: "Send the revised quote", type: "email", assignedUserId: colleague.user.id });
    const logged = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, type: "follow_up_updated" } });
    expect(logged.data).toEqual({ fields: ["note", "type", "dueDate", "nextFollowUpDate", "assignedUserId"] });

    // Unchanged values write nothing; "" clears the next date.
    const boss = await signedIn(["follow_ups", "all_records"]); // reassigned away from me: only All Records still sees it
    const again = (body: object) => boss.agent.patch(`${API}/follow-ups/${f.id}`).send(body);
    expect((await again({ note: "Send the revised quote", type: "email" })).status).toBe(200);
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, type: "follow_up_updated" } })).toBe(1);
    expect((await again({ nextFollowUpDate: "" })).body.nextFollowUpDate).toBeNull();

    expect((await again({ note: " " })).body.error.fields).toHaveProperty("note");
    expect((await again({ type: "sms" })).body.error.fields).toHaveProperty("type");
    expect((await again({ nextFollowUpDate: dayOffset(-5) })).body.error.fields).toHaveProperty("nextFollowUpDate");
    expect((await again({ assignedUserId: inactive.user.id })).body.error.fields).toHaveProperty("assignedUserId");
    expect((await again({ leadId: lead.id })).status).toBe(422); // a follow-up stays on its lead
  });

  it("deletes a follow-up: gone from lists, logged on the lead with an audit copy; only within your scope", async () => {
    const { agent, user, lead } = await setup();
    const f = (await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(1), note: "Wrong entry", type: "call" })).body;
    const other = await signedIn(["follow_ups"]);
    expect((await other.agent.delete(`${API}/follow-ups/${f.id}`)).status).toBe(404);
    expect((await other.agent.patch(`${API}/follow-ups/${f.id}`).send({ note: "taken" })).status).toBe(404);

    expect((await agent.delete(`${API}/follow-ups/${f.id}`)).status).toBe(204);
    expect((await agent.get(`${API}/follow-ups`)).body.total).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, type: "follow_up_deleted" } })).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { action: "follow_up_deleted", entityId: f.id } })).toMatchObject({ actorId: user.id, before: { note: "Wrong entry", type: "call" } });
    expect((await agent.delete(`${API}/follow-ups/${f.id}`)).status).toBe(404);
    expect((await (await signedIn(["leads"])).agent.delete(`${API}/follow-ups/${f.id}`)).status).toBe(403);
  });

  it("groups completed history by lead", async () => {
    const { agent, lead } = await setup();
    for (const note of ["one", "two"]) {
      const f = (await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(0), note, type: "meeting" })).body;
      await agent.post(`${API}/follow-ups/${f.id}/complete`);
    }
    await agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: dayOffset(0), note: "open", type: "meeting" });
    const history = (await agent.get(`${API}/follow-ups/history`)).body;
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({ lead: { id: lead.id, label: "MediShip - Ribeesh" }, completedCount: 2 });
    expect(history.items[0].entries).toHaveLength(2);
  });

  it("offers only visible leads in the Lead / Contact select", async () => {
    const { agent, lead } = await setup();
    const other = await signedIn(["leads"]);
    await other.agent.post(`${API}/leads`).send({ title: "Hidden", contact: { name: "Test Contact" } });
    expect((await agent.get(`${API}/lookups/lead-contacts`)).body).toEqual([{ leadId: lead.id, label: "MediShip - Ribeesh" }]);
  });
});
