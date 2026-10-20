import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { AppError, invalid, notFound } from "../../lib/errors.ts";
import { dateOnly, followUpStatus, indiaDate, leadLabel, parseDateOnly, todayIST } from "../../lib/format.ts";
import { blankToNull, dateOnlyStr, idParam, listOf, pageQuery, paged, searchQ, text } from "../../lib/http.ts";
import { notify, type Say } from "../../lib/notify.ts";
import { prisma } from "../../lib/prisma.ts";
import { updateWithHistory } from "../../lib/write.ts";
import { me, requirePermission, seesAll } from "../../middleware/auth.ts";
import { leadScope } from "../leads/routes.ts";

const TYPES = ["whatsapp", "call", "email", "meeting"] as const;
const TYPE_LABEL = { whatsapp: "WhatsApp", call: "Call", email: "Email", meeting: "Meeting" } as const;

/** A follow-up event (lib/notify.ts): administrators hear of it, and its assignee unless they did it themselves. */
const followUpNotice = (req: Request, key: string, f: Pick<Row, "id" | "assignedUserId" | "lead">, admins: Say, assignee: Say | null, gone = false) => ({
  key,
  actorId: me(req).id,
  subject: { kind: "follow_up" as const, id: f.id, label: leadLabel(f.lead), holderId: f.assignedUserId, gone },
  admins,
  people: assignee ? [{ id: f.assignedUserId, say: assignee }] : [],
});

/** Follow-ups the caller may see: on a live lead, and assigned to them unless their role has "all_records". */
export const followUpScope = (req: Request): Prisma.FollowUpWhereInput => ({
  lead: { deletedAt: null },
  ...(seesAll(req) ? {} : { assignedUserId: me(req).id }),
});

const include = {
  lead: { select: { id: true, title: true, contactName: true, companyName: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.FollowUpInclude;
type Row = Prisma.FollowUpGetPayload<{ include: typeof include }>;

const toFollowUp = (f: Row, today: string) => ({
  id: f.id,
  note: f.note,
  lead: { id: f.lead.id, label: leadLabel(f.lead) },
  type: f.type,
  assignee: f.assignee,
  status: followUpStatus(f.status, f.dueDate, today),
  dueDate: dateOnly(f.dueDate),
  nextFollowUpDate: f.nextFollowUpDate && dateOnly(f.nextFollowUpDate), // stored only; meaning awaits Q17
  completedAt: f.completedAt,
  createdAt: f.createdAt,
});

// "pending" and "overdue" are both stored as pending; the due date splits them.
function statusWhere(status: "pending" | "overdue" | "completed" | undefined, today: string): Prisma.FollowUpWhereInput {
  const t = parseDateOnly(today);
  if (status === "completed") return { status: "completed" };
  if (status === "overdue") return { status: "pending", dueDate: { lt: t } };
  if (status === "pending") return { status: "pending", dueDate: { gte: t } };
  return {};
}

const createBody = z
  .object({
    id: z.uuid().optional(), // chosen by the form, so a retried save is not recorded twice
    leadId: z.uuid("Select a lead"),
    followUpDate: z.iso.date("Pick a follow-up date"),
    nextFollowUpDate: blankToNull(dateOnlyStr),
    note: text(1000),
    type: z.enum(TYPES),
    assignedUserId: z.uuid().optional(),
  })
  .strict();
const updateBody = createBody.omit({ id: true, leadId: true }).partial().strict();

export const followUpsRouter = Router();

followUpsRouter.get("/follow-ups", requirePermission("follow_ups"), async (req, res) => {
  const q = pageQuery.extend({ q: searchQ, status: z.enum(["pending", "overdue", "completed"]).optional() }).parse(req.query);
  const today = todayIST();
  const scope = followUpScope(req);
  const contains = { contains: q.q, mode: "insensitive" } as const;
  const where: Prisma.FollowUpWhereInput = {
    AND: [
      scope,
      statusWhere(q.status, today),
      q.q
        ? {
            OR: [
              { note: contains },
              { lead: { title: contains } },
              { lead: { contactName: contains } },
              { lead: { companyName: contains } },
              { assignee: { name: contains } },
            ],
          }
        : {},
    ],
  };
  const [rows, total, pendingCount, overdueCount] = await Promise.all([
    // Open ones first, by due date (overdue are the earliest); then completed, most recently completed first. By due
    // date alone, months of completed follow-ups filled the first pages and today's pending ones fell off them.
    prisma.followUp.findMany({
      where,
      include,
      orderBy: [{ status: "asc" }, { completedAt: { sort: "desc", nulls: "first" } }, { dueDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      ...paged(q),
    }),
    prisma.followUp.count({ where }),
    prisma.followUp.count({ where: { AND: [scope, statusWhere("pending", today)] } }),
    prisma.followUp.count({ where: { AND: [scope, statusWhere("overdue", today)] } }),
  ]);
  res.json({ ...listOf(rows.map((r) => toFollowUp(r, today)), q, total), pendingCount, overdueCount });
});

followUpsRouter.post("/follow-ups", requirePermission("follow_ups"), async (req, res) => {
  const body = createBody.parse(req.body);
  const assignedUserId = body.assignedUserId ?? me(req).id; // defaults to the creator so it stays in their queue
  const [lead, assignee] = await Promise.all([
    prisma.lead.findFirst({ where: { id: body.leadId, ...leadScope(req) }, select: include.lead.select }),
    prisma.user.findUnique({ where: { id: assignedUserId }, select: { id: true, name: true, status: true } }),
  ]);
  const problems: Record<string, string> = {};
  if (!lead) problems.leadId = "Unknown lead";
  if (assignee?.status !== "active") problems.assignedUserId = "Assignee must be an active user";
  if (Object.keys(problems).length) throw invalid(problems);

  // The follow-up and its line in the lead's activity are ONE statement: a single round trip, all or nothing (a
  // Prisma transaction made five sequential round trips). The reply is built from what was just checked and saved.
  const id = body.id ?? randomUUID();
  const now = new Date();
  const actor = me(req).id;
  const inserted = await prisma.$executeRaw`
    WITH f AS (
      INSERT INTO follow_ups (id, lead_id, note, type, assigned_user_id, due_date, next_follow_up_date, created_by, created_at, updated_at)
      VALUES (${id}::uuid, ${body.leadId}::uuid, ${body.note}, ${body.type}::"FollowUpType", ${assignedUserId}::uuid, ${body.followUpDate}::date, ${body.nextFollowUpDate ?? null}::date, ${actor}::uuid, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
      RETURNING lead_id
    )
    INSERT INTO lead_activities (id, lead_id, actor_id, type, message, created_at)
    SELECT ${randomUUID()}::uuid, lead_id, ${actor}::uuid, 'follow_up_added', ${`Follow-up added: ${body.note}`}, ${now} FROM f`;
  if (!inserted) {
    // The same form sent again (a retry after a lost reply, say): the first save stands, and is not announced twice.
    const first = await prisma.followUp.findFirst({ where: { id, createdById: actor, lead: { deletedAt: null } }, include });
    if (!first) throw new AppError(409, "FOLLOW_UP_ID_TAKEN", "This follow-up could not be added. Close the form and try again.");
    return void res.status(200).json(toFollowUp(first, todayIST()));
  }
  const followUp: Row = {
    id,
    leadId: body.leadId,
    note: body.note,
    type: body.type,
    assignedUserId,
    dueDate: parseDateOnly(body.followUpDate),
    nextFollowUpDate: body.nextFollowUpDate ? parseDateOnly(body.nextFollowUpDate) : null,
    status: "pending",
    completedAt: null,
    createdById: actor,
    createdAt: now,
    updatedAt: now,
    lead: lead!,
    assignee: { id: assignee!.id, name: assignee!.name },
  };
  const what = `${TYPE_LABEL[body.type]} on ${indiaDate(body.followUpDate)}`;
  void notify(
    followUpNotice(
      req,
      `fu_created:${id}`,
      followUp,
      { what: "New follow-up", detail: `${me(req).name} scheduled a ${what}, assigned to ${assignee!.name}` },
      { what: "Follow-up assigned to you", detail: `${me(req).name} scheduled a ${what}` },
    ),
  );
  res.status(201).json(toFollowUp(followUp, todayIST()));
});

followUpsRouter.post("/follow-ups/:id/complete", requirePermission("follow_ups"), async (req, res) => {
  const id = idParam(req);
  const current = await prisma.followUp.findFirst({ where: { id, ...followUpScope(req) }, include });
  if (!current) throw notFound("Follow-up");
  if (current.status === "completed") return void res.json(toFollowUp(current, todayIST())); // idempotent

  // ONE statement (a single round trip, all or nothing): complete it if it is still pending, and only then log it
  // on its lead. Completed by someone else meanwhile: theirs stands, read back.
  const now = new Date();
  const completed = await prisma.$executeRaw`
    WITH upd AS (
      UPDATE follow_ups SET status = 'completed', completed_at = ${now}, updated_at = ${now}
      WHERE id = ${id}::uuid AND status = 'pending'
      RETURNING lead_id
    )
    INSERT INTO lead_activities (id, lead_id, actor_id, type, message, created_at)
    SELECT ${randomUUID()}::uuid, lead_id, ${me(req).id}::uuid, 'follow_up_completed', ${`Follow-up completed: ${current.note}`}, ${now} FROM upd`;
  if (completed) {
    const say = { what: "Follow-up completed", detail: `Completed by ${me(req).name}` };
    void notify(followUpNotice(req, `fu_completed:${id}`, current, say, say));
  }
  const done = completed ? { ...current, status: "completed" as const, completedAt: now, updatedAt: now } : await prisma.followUp.findUniqueOrThrow({ where: { id }, include });
  res.json(toFollowUp(done, todayIST()));
});

// Edit: note, type, dates and assignee (it stays on its lead). Only what differs is written, and logged on the lead.
followUpsRouter.patch("/follow-ups/:id", requirePermission("follow_ups"), async (req, res) => {
  const id = idParam(req);
  const body = updateBody.parse(req.body);
  const [current, assignee] = await Promise.all([
    prisma.followUp.findFirst({ where: { id, ...followUpScope(req) }, include }),
    body.assignedUserId ? prisma.user.findUnique({ where: { id: body.assignedUserId }, select: { id: true, name: true, status: true } }) : null,
  ]);
  if (!current) throw notFound("Follow-up");
  const was = { note: current.note, type: current.type, dueDate: dateOnly(current.dueDate), nextFollowUpDate: current.nextFollowUpDate && dateOnly(current.nextFollowUpDate), assignedUserId: current.assignedUserId };
  const wanted = { note: body.note, type: body.type, dueDate: body.followUpDate, nextFollowUpDate: body.nextFollowUpDate, assignedUserId: body.assignedUserId };
  const set: Partial<typeof was> = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => v !== undefined && v !== was[k as keyof typeof was]));
  if (!Object.keys(set).length) return void res.json(toFollowUp(current, todayIST()));

  const due = set.dueDate ?? was.dueDate;
  const next = set.nextFollowUpDate === undefined ? was.nextFollowUpDate : set.nextFollowUpDate;
  const problems: Record<string, string> = {};
  if (set.assignedUserId && assignee?.status !== "active") problems.assignedUserId = "Assignee must be an active user";
  if (next && next < due && (set.dueDate || set.nextFollowUpDate)) problems.nextFollowUpDate = "Must be on or after the follow-up date";
  if (Object.keys(problems).length) throw invalid(problems);

  const saved = await updateWithHistory("follow_ups", id, {
    set,
    history: [{ table: "lead_activities", rows: [{ leadId: current.leadId, actorId: me(req).id, type: "follow_up_updated", message: `Follow-up updated: ${set.note ?? current.note}`, data: { fields: Object.keys(set) } }] }],
  });
  if (!saved) throw notFound("Follow-up"); // deleted meanwhile
  // A new assignee hears it is theirs now; otherwise the assignee hears of the change. Administrators either way.
  const by = me(req).name;
  void notify(
    followUpNotice(
      req,
      `fu_updated:${id}:${saved.updatedAt.getTime()}`,
      { ...current, assignedUserId: set.assignedUserId ?? current.assignedUserId },
      { what: set.assignedUserId ? "Follow-up reassigned" : "Follow-up updated", detail: set.assignedUserId ? `${by} assigned it to ${assignee!.name}` : `Updated by ${by}, due on ${indiaDate(due)}` },
      set.assignedUserId ? { what: "Follow-up assigned to you", detail: `Assigned by ${by}, due on ${indiaDate(due)}` } : { what: "Follow-up updated", detail: `Updated by ${by}, due on ${indiaDate(due)}` },
    ),
  );
  res.json(
    toFollowUp(
      {
        ...current,
        ...set,
        dueDate: parseDateOnly(due),
        nextFollowUpDate: next ? parseDateOnly(next) : null,
        updatedAt: saved.updatedAt,
        assignee: set.assignedUserId ? { id: assignee!.id, name: assignee!.name } : current.assignee,
      },
      todayIST(),
    ),
  );
});

// Removed for good (follow-ups have no soft delete); the lead's activity and the audit log keep what it was.
followUpsRouter.delete("/follow-ups/:id", requirePermission("follow_ups"), async (req, res) => {
  const id = idParam(req);
  const current = await prisma.followUp.findFirst({ where: { id, ...followUpScope(req) }, include });
  if (!current) throw notFound("Follow-up");
  const actor = me(req).id;
  const now = new Date();
  // ONE statement: deleted, audited and logged on its lead, or none of it (deleted by someone else meanwhile).
  const deleted = await prisma.$executeRaw`
    WITH d AS (DELETE FROM follow_ups WHERE id = ${id}::uuid RETURNING lead_id),
    a AS (
      INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, ip, created_at)
      SELECT ${actor}::uuid, 'follow_up_deleted', 'follow_up', ${id}, ${JSON.stringify(toFollowUp(current, todayIST()))}::jsonb, ${req.ip ?? null}, ${now} FROM d
    )
    INSERT INTO lead_activities (id, lead_id, actor_id, type, message, created_at)
    SELECT ${randomUUID()}::uuid, lead_id, ${actor}::uuid, 'follow_up_deleted', ${`Follow-up deleted: ${current.note}`}, ${now} FROM d`;
  if (!deleted) throw notFound("Follow-up");
  const say = { what: "Follow-up deleted", detail: `Deleted by ${me(req).name}` };
  void notify(followUpNotice(req, `fu_deleted:${id}`, current, say, say, true));
  res.status(204).end();
});

// "Previous Follow Up History": completed follow-ups grouped by lead, most recently completed first.
followUpsRouter.get("/follow-ups/history", requirePermission("follow_ups"), async (req, res) => {
  const q = pageQuery.parse(req.query);
  const where: Prisma.FollowUpWhereInput = { ...followUpScope(req), status: "completed" };
  const [groups, allGroups] = await Promise.all([
    prisma.followUp.groupBy({
      by: ["leadId"],
      where,
      _count: { _all: true },
      _max: { completedAt: true },
      orderBy: [{ _max: { completedAt: "desc" } }, { leadId: "asc" }],
      ...paged(q),
    }),
    // ponytail: counts groups in memory; fine for thousands of leads, use COUNT(DISTINCT) via $queryRaw beyond that
    prisma.followUp.groupBy({ by: ["leadId"], where }),
  ]);
  const entries = await prisma.followUp.findMany({
    where: { ...where, leadId: { in: groups.map((g) => g.leadId) } },
    include,
    orderBy: { completedAt: "desc" },
  });
  const today = todayIST();
  const items = groups.map((g) => {
    const own = entries.filter((e) => e.leadId === g.leadId);
    return { lead: { id: g.leadId, label: own[0] ? leadLabel(own[0].lead) : "" }, completedCount: g._count._all, entries: own.map((e) => toFollowUp(e, today)) };
  });
  res.json(listOf(items, q, allGroups.length));
});

// Options for the New Follow Up "Lead / Contact" select: leads the caller can see.
followUpsRouter.get("/lookups/lead-contacts", requirePermission("follow_ups"), async (req, res) => {
  const q = z.object({ q: searchQ }).parse(req.query);
  const contains = { contains: q.q, mode: "insensitive" } as const;
  const leads = await prisma.lead.findMany({
    where: { ...leadScope(req), ...(q.q && { OR: [{ title: contains }, { contactName: contains }, { companyName: contains }] }) },
    select: { id: true, title: true, contactName: true, companyName: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  res.json(leads.map((l) => ({ leadId: l.id, label: leadLabel(l) })));
});
