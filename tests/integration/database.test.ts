import { beforeEach, describe, expect, it } from "vitest";
import { hasDb, makeUser, prisma, resetDb, statusByName } from "../helpers.ts";

// The database itself enforces these rules, even if a future code path forgets to.
describe.skipIf(!hasDb)("database constraints", () => {
  beforeEach(resetDb);

  it("rejects negative money and weights", async () => {
    const { user } = await makeUser(["leads"]);
    const status = await statusByName("New");
    await expect(prisma.lead.create({ data: { title: "x", statusId: status.id, createdById: user.id, expectedValue: "-1" } })).rejects.toThrow();
    await expect(prisma.lead.create({ data: { title: "x", statusId: status.id, createdById: user.id, shipmentWeightKg: "-0.5" } })).rejects.toThrow();
  });

  it("keeps follow-up status and completion time consistent", async () => {
    const { user } = await makeUser(["leads"]);
    const status = await statusByName("New");
    const lead = await prisma.lead.create({ data: { title: "x", statusId: status.id, createdById: user.id } });
    const base = { leadId: lead.id, note: "n", type: "call" as const, dueDate: new Date("2026-10-14"), createdById: user.id };
    await expect(prisma.followUp.create({ data: { ...base, status: "completed" } })).rejects.toThrow();
    await expect(prisma.followUp.create({ data: { ...base, completedAt: new Date() } })).rejects.toThrow();
  });

  it("forbids a status that is both won and lost", async () => {
    await expect(prisma.leadStatus.create({ data: { name: "Both", sortOrder: 99, isWon: true, isLost: true } })).rejects.toThrow();
  });

  it("restricts deleting referenced rows and duplicate unique values", async () => {
    const { user, role } = await makeUser(["leads"]);
    const status = await statusByName("New");
    await prisma.lead.create({ data: { title: "x", statusId: status.id, createdById: user.id } });
    await expect(prisma.leadStatus.delete({ where: { id: status.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.role.delete({ where: { id: role.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.user.create({ data: { name: "dup", email: user.email, passwordHash: "x", roleId: role.id } })).rejects.toMatchObject({ code: "P2002" });
  });
});
