import { Router } from "express";
import { listOf, pageQuery, paged } from "../../lib/http.ts";
import { prisma } from "../../lib/prisma.ts";
import { me, requirePermission } from "../../middleware/auth.ts";

// Read-only feed of the caller's own notifications. Nothing creates notifications yet and there is no
// mark-as-read endpoint: which events notify whom, and read behaviour, await report Q19.
export const notificationsRouter = Router();

notificationsRouter.get("/notifications", requirePermission("notifications"), async (req, res) => {
  const q = pageQuery.parse(req.query);
  const where = { userId: me(req).id };
  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...paged(q) }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  const items = rows.map((n) => ({ id: n.id, title: n.title, detail: n.detail, link: n.link, read: n.readAt !== null, createdAt: n.createdAt }));
  res.json({ ...listOf(items, q, total), unreadCount });
});
