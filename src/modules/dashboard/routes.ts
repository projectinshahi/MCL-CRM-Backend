import { Router } from "express";
import { Prisma } from "../../generated/prisma/client.ts";
import { parseDateOnly, todayIST, toMoney } from "../../lib/format.ts";
import { prisma } from "../../lib/prisma.ts";
import { requirePermission } from "../../middleware/auth.ts";
import { customerScope } from "../customers/routes.ts";
import { followUpScope } from "../follow-ups/routes.ts";
import { leadScope } from "../leads/routes.ts";

// KPI definitions are the report's proposals (section 5, F23) and still need business sign-off:
//   new = leads in the first status (lowest sort order) · active = neither won nor lost
//   openLeadValue = Σ expected value of active leads · convertedValue = Σ expected value of won leads
//   conversionRate = won ÷ all leads × 100 (one decimal) · due today / overdue use the Asia/Kolkata date
// Every figure obeys the same record scope as the lists ("all_records" or own records).
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export const dashboardRouter = Router();

dashboardRouter.get("/dashboard/summary", requirePermission("dashboard"), async (req, res) => {
  const leads = leadScope(req);
  const followUps = followUpScope(req);
  const today = parseDateOnly(todayIST());

  const [statuses, sources, byStatus, bySource, activeCustomers, followUpsDueToday, followUpsOverdue] = await Promise.all([
    prisma.leadStatus.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true, isWon: true, isLost: true } }),
    prisma.leadSource.findMany({ select: { id: true, name: true } }),
    prisma.lead.groupBy({ by: ["statusId"], where: leads, _count: { _all: true }, _sum: { expectedValue: true } }),
    prisma.lead.groupBy({ by: ["sourceId"], where: leads, _count: { _all: true } }),
    prisma.customer.count({ where: { ...customerScope(req), status: "active" } }),
    prisma.followUp.count({ where: { ...followUps, status: "pending", dueDate: today } }),
    prisma.followUp.count({ where: { ...followUps, status: "pending", dueDate: { lt: today } } }),
  ]);

  let totalLeads = 0, convertedLeads = 0, lostLeads = 0;
  let openLeadValue = new Prisma.Decimal(0), convertedValue = new Prisma.Decimal(0); // decimal maths, no float drift
  for (const g of byStatus) {
    const status = statuses.find((s) => s.id === g.statusId);
    const value = g._sum.expectedValue ?? new Prisma.Decimal(0);
    totalLeads += g._count._all;
    if (status?.isWon) (convertedLeads += g._count._all), (convertedValue = convertedValue.plus(value));
    else if (status?.isLost) lostLeads += g._count._all;
    else openLeadValue = openLeadValue.plus(value);
  }
  const countFor = (statusId?: string) => byStatus.find((g) => g.statusId === statusId)?._count._all ?? 0;

  res.json({
    kpis: {
      totalLeads,
      newLeads: countFor(statuses[0]?.id),
      activeLeads: totalLeads - convertedLeads - lostLeads,
      convertedLeads,
      lostLeads,
      activeCustomers,
      followUpsDueToday,
      followUpsOverdue,
      openLeadValue: toMoney(openLeadValue),
      convertedValue: toMoney(convertedValue),
      conversionRate: pct(convertedLeads, totalLeads),
    },
    byStatus: statuses.map((s) => ({ status: s, count: countFor(s.id) })),
    bySource: bySource
      .map((g) => ({
        source: sources.find((s) => s.id === g.sourceId) ?? null, // null = leads with no source
        count: g._count._all,
        share: pct(g._count._all, totalLeads),
      }))
      .sort((a, b) => b.count - a.count),
  });
});
