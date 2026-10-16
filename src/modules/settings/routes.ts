import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit.ts";
import { AppError, notFound } from "../../lib/errors.ts";
import { idParam, text } from "../../lib/http.ts";
import { prisma } from "../../lib/prisma.ts";
import { me, requireAuth, requirePermission } from "../../middleware/auth.ts";

const nameBody = z.object({ name: text(60) }).strict();
const duplicate = () => new AppError(409, "DUPLICATE_NAME", "This name already exists.", { name: "Already exists" });

export const settingsRouter = Router();

// ---------- Lead sources (/settings) ----------

// Any signed-in user: lead forms and filters need the list.
settingsRouter.get("/settings/lead-sources", requireAuth, async (_req, res) => {
  res.json(
    await prisma.leadSource.findMany({
      select: { id: true, name: true, active: true },
      orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    }),
  );
});

settingsRouter.post("/settings/lead-sources", requirePermission("settings"), async (req, res) => {
  const { name } = nameBody.parse(req.body);
  const existing = await prisma.leadSource.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (existing?.active) throw duplicate();
  // Re-adding a source that was deactivated (because leads used it) brings it back rather than failing.
  const source = existing
    ? await prisma.leadSource.update({ where: { id: existing.id }, data: { active: true } })
    : await prisma.leadSource.create({ data: { name } });
  await audit(prisma, { actorId: me(req).id, action: "lead_source_added", entityType: "lead_source", entityId: source.id, after: { name: source.name }, ip: req.ip });
  res.status(201).json({ id: source.id, name: source.name, active: source.active });
});

// Rename: leads keep the source (they hold its id), now shown with the new name.
settingsRouter.patch("/settings/lead-sources/:id", requirePermission("settings"), async (req, res) => {
  const id = idParam(req);
  const { name } = nameBody.parse(req.body);
  const [source, clash] = await Promise.all([
    prisma.leadSource.findUnique({ where: { id } }),
    prisma.leadSource.findFirst({ where: { id: { not: id }, name: { equals: name, mode: "insensitive" } }, select: { id: true } }),
  ]);
  if (!source?.active) throw notFound("Lead source");
  if (clash) throw duplicate();
  if (source.name === name) return void res.json({ id, name, active: true });
  await prisma.$transaction([
    prisma.leadSource.update({ where: { id }, data: { name } }),
    audit(prisma, { actorId: me(req).id, action: "lead_source_renamed", entityType: "lead_source", entityId: id, before: { name: source.name }, after: { name }, ip: req.ip }),
  ]);
  res.json({ id, name, active: true });
});

// In use → deactivated (hidden from new leads, kept on old ones); unused → deleted.
settingsRouter.delete("/settings/lead-sources/:id", requirePermission("settings"), async (req, res) => {
  const id = idParam(req);
  const source = await prisma.leadSource.findUnique({ where: { id } });
  if (!source) throw notFound("Lead source");
  const [leads, customers] = await Promise.all([
    prisma.lead.count({ where: { sourceId: id } }),
    prisma.customer.count({ where: { sourceId: id } }),
  ]);
  const inUse = leads + customers > 0;
  await prisma.$transaction([
    inUse ? prisma.leadSource.update({ where: { id }, data: { active: false } }) : prisma.leadSource.delete({ where: { id } }),
    audit(prisma, { actorId: me(req).id, action: inUse ? "lead_source_deactivated" : "lead_source_deleted", entityType: "lead_source", entityId: id, before: { name: source.name }, ip: req.ip }),
  ]);
  res.status(204).end();
});

// ---------- Lead statuses (/settings/lead-status) = pipeline columns ----------

settingsRouter.get("/settings/lead-statuses", requireAuth, async (_req, res) => {
  res.json(
    await prisma.leadStatus.findMany({
      select: { id: true, name: true, sortOrder: true, isWon: true, isLost: true },
      orderBy: { sortOrder: "asc" },
    }),
  );
});

settingsRouter.post("/settings/lead-statuses", requirePermission("settings"), async (req, res) => {
  const { name } = nameBody.parse(req.body);
  if (await prisma.leadStatus.findFirst({ where: { name: { equals: name, mode: "insensitive" } } })) throw duplicate();
  const last = await prisma.leadStatus.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const status = await prisma.leadStatus.create({ data: { name, sortOrder: (last?.sortOrder ?? 0) + 1 } });
  await audit(prisma, { actorId: me(req).id, action: "lead_status_added", entityType: "lead_status", entityId: status.id, after: { name }, ip: req.ip });
  res.status(201).json({ id: status.id, name: status.name, sortOrder: status.sortOrder, isWon: status.isWon, isLost: status.isLost });
});

// Rename: the pipeline column and every lead in it show the new name (leads hold the status id).
settingsRouter.patch("/settings/lead-statuses/:id", requirePermission("settings"), async (req, res) => {
  const id = idParam(req);
  const { name } = nameBody.parse(req.body);
  const [status, clash] = await Promise.all([
    prisma.leadStatus.findUnique({ where: { id } }),
    prisma.leadStatus.findFirst({ where: { id: { not: id }, name: { equals: name, mode: "insensitive" } }, select: { id: true } }),
  ]);
  if (!status) throw notFound("Lead status");
  if (clash) throw duplicate();
  const reply = { id, name, sortOrder: status.sortOrder, isWon: status.isWon, isLost: status.isLost };
  if (status.name === name) return void res.json(reply);
  await prisma.$transaction([
    prisma.leadStatus.update({ where: { id }, data: { name } }),
    audit(prisma, { actorId: me(req).id, action: "lead_status_renamed", entityType: "lead_status", entityId: id, before: { name: status.name }, after: { name }, ip: req.ip }),
  ]);
  res.json(reply);
});

settingsRouter.delete("/settings/lead-statuses/:id", requirePermission("settings"), async (req, res) => {
  const id = idParam(req);
  const status = await prisma.leadStatus.findUnique({ where: { id } });
  if (!status) throw notFound("Lead status");
  if (await prisma.lead.count({ where: { statusId: id } }))
    throw new AppError(409, "STATUS_IN_USE", "Leads still use this status. Move them to another status first.");
  if ((await prisma.leadStatus.count()) <= 1) throw new AppError(409, "LAST_STATUS", "At least one lead status must remain.");
  await prisma.$transaction([
    prisma.leadStatus.delete({ where: { id } }),
    audit(prisma, { actorId: me(req).id, action: "lead_status_deleted", entityType: "lead_status", entityId: id, before: { name: status.name }, ip: req.ip }),
  ]);
  res.status(204).end();
});
