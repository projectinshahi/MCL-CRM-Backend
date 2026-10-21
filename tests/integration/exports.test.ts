import { beforeEach, describe, expect, it } from "vitest";
import { API, hasDb, makeUser, prisma, resetDb, signedIn, statusByName } from "../helpers.ts";

// Parsed back the way a spreadsheet reads it (enough for these files: quoted fields may hold commas and quotes).
function parse(text: string) {
  expect(text.startsWith("﻿")).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\r") continue;
    else if (c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else cell += c;
  }
  return rows;
}
const csv = (res: { text: string }) => parse(res.text);

describe.skipIf(!hasDb)("report downloads", () => {
  beforeEach(resetDb);

  async function leadsFor(ownerId: string, n: number, over: Record<string, unknown> = {}) {
    const status = await statusByName("New");
    await prisma.lead.createMany({ data: Array.from({ length: n }, (_, i) => ({ title: `Lead ${i}`, statusId: status.id, ownerId, createdById: ownerId, priority: "low" as const, ...over })) });
  }

  it("leads: every matching lead (not one page), with the list's filters, as a named UTF-8 CSV; audited", async () => {
    const boss = await signedIn(["leads", "all_records"]);
    await leadsFor(boss.user.id, 25);
    await leadsFor(boss.user.id, 2, { priority: "high", expectedValue: "1500000.5", title: "=HYPERLINK(\"http://x\")", companyName: "Malabar, Spices \"Intl\"" });
    const res = await boss.agent.get(`${API}/leads/export`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const rows = csv(res);
    expect(rows[0]!.slice(0, 4)).toEqual(["Title", "Stage", "Priority", "Expected value (INR)"]);
    expect(rows).toHaveLength(1 + 27); // the list pages by 20: the export doesn't

    const high = csv(await boss.agent.get(`${API}/leads/export`).query({ priority: "high" }));
    expect(high).toHaveLength(3);
    expect(high[1]!.slice(0, 4)).toEqual(["'=HYPERLINK(\"http://x\")", "New", "high", "1500000.50"]); // shown as text, never run
    expect(high[1]![10]).toBe('Malabar, Spices "Intl"');

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "leads_exported", actorId: boss.user.id } });
    expect(log.after).toEqual({ rows: 27, filters: [] });
  });

  it("leads: only the caller's own without All records; needs the Leads permission", async () => {
    const rep = await signedIn(["leads"]);
    const other = await makeUser(["leads"]);
    await leadsFor(rep.user.id, 3);
    await leadsFor(other.user.id, 4);
    const rows = csv(await rep.agent.get(`${API}/leads/export`));
    expect(rows).toHaveLength(1 + 3);
    expect((await (await signedIn(["customers"])).agent.get(`${API}/leads/export`)).status).toBe(403);
  });

  it("customers: the list's search and filters within the caller's scope", async () => {
    const rep = await signedIn(["leads", "customers"]);
    for (const name of ["Asha", "Bina", "Chitra"]) await rep.agent.post(`${API}/leads`).send({ title: `Deal ${name}`, contact: { name } });
    const other = await signedIn(["leads", "customers"]);
    await other.agent.post(`${API}/leads`).send({ title: "Not yours", contact: { name: "Deepa" } });
    const bina = await prisma.customer.findFirstOrThrow({ where: { name: "Bina" } });
    await rep.agent.patch(`${API}/customers/${bina.id}`).send({ status: "inactive" });

    const all = csv(await rep.agent.get(`${API}/customers/export`));
    expect(all.slice(1).map((r) => r[1]).sort()).toEqual(["Asha", "Bina", "Chitra"]);
    expect(all[1]![0]).toMatch(/^CU-\d{5}$/);
    const inactive = csv(await rep.agent.get(`${API}/customers/export`).query({ status: "inactive" }));
    expect(inactive.slice(1).map((r) => [r[1], r[12]])).toEqual([["Bina", "inactive"]]);
    expect(csv(await rep.agent.get(`${API}/customers/export`).query({ q: "chit" })).slice(1).map((r) => r[1])).toEqual(["Chitra"]);
  });

  it("follow-ups: status worked out like the list (overdue), filtered and scoped", async () => {
    const rep = await signedIn(["leads", "follow_ups"]);
    const lead = (await rep.agent.post(`${API}/leads`).send({ title: "Proposal", company: { name: "MediShip" }, contact: { name: "Ribeesh" } })).body;
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await rep.agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: day(3), note: "Later", type: "call" });
    const past = await rep.agent.post(`${API}/follow-ups`).send({ leadId: lead.id, followUpDate: day(1), note: "Was due", type: "email" });
    await prisma.followUp.update({ where: { id: past.body.id }, data: { dueDate: new Date(`${day(-2)}T00:00:00Z`) } });
    const rows = csv(await rep.agent.get(`${API}/follow-ups/export`));
    expect(rows[0]).toEqual(["Due date", "Status", "Type", "Note", "Lead", "Assigned to", "Next follow-up", "Completed", "Created"]);
    expect(rows.slice(1).map((r) => [r[1], r[3], r[4]])).toEqual([["overdue", "Was due", "MediShip - Ribeesh"], ["pending", "Later", "MediShip - Ribeesh"]]);
    expect(csv(await rep.agent.get(`${API}/follow-ups/export`).query({ status: "overdue" })).slice(1).map((r) => r[3])).toEqual(["Was due"]);
    const stranger = await signedIn(["follow_ups"]);
    expect(csv(await stranger.agent.get(`${API}/follow-ups/export`))).toHaveLength(1); // header only
  });
});
