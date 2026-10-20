import { Router, type Request } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import { notFound } from "../../lib/errors.ts";
import { leadLabel } from "../../lib/format.ts";
import { idParam, listOf, pageQuery, paged } from "../../lib/http.ts";
import { canOpen } from "../../lib/notify.ts";
import { prisma } from "../../lib/prisma.ts";
import { me, requirePermission } from "../../middleware/auth.ts";

// The caller's own notifications, and only theirs: every query is limited to user_id = the session's user, so another
// user's notification id answers 404 like one that doesn't exist. What creates them: src/lib/notify.ts and
// ./reminders.ts. Clearing marks rows deleted_at (purged after 30 days, server.ts) so a cleared reminder isn't remade.
export const notificationsRouter = Router();
const mine = (req: Request) => ({ userId: me(req).id, deletedAt: null });

type Row = {
  id: string;
  title: string;
  detail: string | null;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
  source_type: string | null;
  source_id: string | null;
  lead_title: string | null;
  lead_owner: string | null;
  lead_deleted: boolean | null;
  customer_name: string | null;
  customer_assignee: string | null;
  customer_deleted: boolean | null;
  fu_found: boolean;
  fu_assignee: string | null;
  fu_lead_title: string | null;
  fu_company: string | null;
  fu_contact: string | null;
  fu_lead_deleted: boolean | null;
  user_name: string | null;
  role_name: string | null;
};

/** The record a notification is about, as it is now; null when it no longer exists (or the row names none). */
function recordNow(n: Row) {
  switch (n.source_type) {
    case "lead":
      return n.lead_title === null ? null : { kind: "lead" as const, label: n.lead_title, holderId: n.lead_owner, gone: !!n.lead_deleted };
    case "customer":
      return n.customer_name === null ? null : { kind: "customer" as const, label: n.customer_name, holderId: n.customer_assignee, gone: !!n.customer_deleted };
    case "follow_up":
      return !n.fu_found
        ? null
        : { kind: "follow_up" as const, label: leadLabel({ title: n.fu_lead_title ?? "", companyName: n.fu_company, contactName: n.fu_contact }), holderId: n.fu_assignee, gone: !!n.fu_lead_deleted };
    case "user":
      return n.user_name === null ? null : { kind: "user" as const, label: n.user_name, holderId: null, gone: false };
    case "role":
      return n.role_name === null ? null : { kind: "role" as const, label: n.role_name, holderId: null, gone: false };
    default:
      return null;
  }
}

// Newest first. Each notification's record is read in the same statement (one round trip, alongside the counts), so
// its name and link reflect what this reader may open now: their current permissions and the record's current owner
// or assignee (lib/notify.ts). A record they can't open, or one that no longer exists, shows the event alone.
notificationsRouter.get("/notifications", requirePermission("notifications"), async (req, res) => {
  const q = pageQuery.parse(req.query);
  const where = mine(req);
  const { skip, take } = paged(q);
  // source_id is text (any record type); it is cast to a uuid only for its own type, so the primary keys are used.
  const id = (type: Row["source_type"]) => Prisma.raw(`CASE WHEN p.source_type = '${type}' THEN p.source_id::uuid END`);
  const [rows, total, unreadCount] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      WITH p AS (
         SELECT id, title, detail, link, read_at, created_at, source_type, source_id FROM notifications
         WHERE user_id = ${me(req).id}::uuid AND deleted_at IS NULL
         ORDER BY created_at DESC, id ASC LIMIT ${take}::int OFFSET ${skip}::int
       )
       SELECT p.*,
         l.title AS lead_title, l.owner_id::text AS lead_owner, l.deleted_at IS NOT NULL AS lead_deleted,
         c.name AS customer_name, c.assigned_user_id::text AS customer_assignee, c.deleted_at IS NOT NULL AS customer_deleted,
         f.id IS NOT NULL AS fu_found, f.assigned_user_id::text AS fu_assignee,
         fl.title AS fu_lead_title, fl.company_name AS fu_company, fl.contact_name AS fu_contact, fl.deleted_at IS NOT NULL AS fu_lead_deleted,
         u.name AS user_name, r.name AS role_name
       FROM p
       LEFT JOIN leads l ON l.id = ${id("lead")}
       LEFT JOIN customers c ON c.id = ${id("customer")}
       LEFT JOIN follow_ups f ON f.id = ${id("follow_up")}
       LEFT JOIN leads fl ON fl.id = f.lead_id
       LEFT JOIN users u ON u.id = ${id("user")}
       LEFT JOIN roles r ON r.id = ${id("role")}
       ORDER BY p.created_at DESC, p.id ASC`,
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  const permissions = req.auth!.permissions;
  const items = rows.map((n) => {
    const record = n.source_id ? recordNow(n) : null;
    // A deleted record (soft-deleted leads and customers, follow-ups on a deleted lead) can't be opened by anyone, so
    // it isn't named; the notification about its deletion was written with its name for those who could open it.
    const open = !!record && !record.gone && canOpen(permissions, me(req).id, record);
    return {
      id: n.id,
      title: open ? `${n.title}: ${record.label}` : n.title,
      detail: n.detail,
      link: open ? n.link : null,
      read: n.read_at !== null,
      createdAt: n.created_at,
    };
  });
  res.json({ ...listOf(items, q, total), unreadCount });
});

// Polled by the header bell (two indexed counts in one round trip): the unread count, when the newest unread one
// arrived (a later time than the last answer means a new notification, which is what plays the sound), and how many
// there are in all (so a removal in another tab refreshes an open list too).
notificationsRouter.get("/notifications/unread", requirePermission("notifications"), async (req, res) => {
  const [{ _count, _max }, total] = await Promise.all([
    prisma.notification.aggregate({ where: { ...mine(req), readAt: null }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.notification.count({ where: mine(req) }),
  ]);
  res.json({ unreadCount: _count._all, latestAt: _max.createdAt, total });
});

// Read stays read (it is not deleted); marking it again is harmless.
notificationsRouter.post("/notifications/:id/read", requirePermission("notifications"), async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { id: idParam(req), ...mine(req) }, data: { readAt: new Date() } });
  if (!count) throw notFound("Notification");
  res.status(204).end();
});

notificationsRouter.delete("/notifications/:id", requirePermission("notifications"), async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { id: idParam(req), ...mine(req) }, data: { deletedAt: new Date() } });
  if (!count) throw notFound("Notification");
  res.status(204).end();
});

// Clear all: the caller's notifications, nobody else's. `before` (the time of the newest one their list showed) keeps
// one that arrived after they looked from being removed unseen.
notificationsRouter.delete("/notifications", requirePermission("notifications"), async (req, res) => {
  const { before } = z.object({ before: z.iso.datetime({ offset: true }).optional() }).parse(req.query);
  const { count } = await prisma.notification.updateMany({
    where: { ...mine(req), ...(before && { createdAt: { lte: new Date(before) } }) },
    data: { deletedAt: new Date() },
  });
  res.json({ cleared: count });
});
