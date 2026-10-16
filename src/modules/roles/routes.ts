import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit.ts";
import { AppError, notFound } from "../../lib/errors.ts";
import { initials } from "../../lib/format.ts";
import { assertAdminRemains } from "../../lib/guards.ts";
import { idParam, text } from "../../lib/http.ts";
import { PERMISSION_CODES } from "../../lib/permissions.ts";

/** Position in the catalogue (= sidebar order); lists of permissions follow it. */
const rank = (code: string) => (PERMISSION_CODES as readonly string[]).indexOf(code);
import { prisma } from "../../lib/prisma.ts";
import { me, requirePermission } from "../../middleware/auth.ts";

const MEMBER_PREVIEW = 5;

const roleBody = z
  .object({
    name: text(60),
    permissions: z
      .array(z.enum(PERMISSION_CODES))
      .max(PERMISSION_CODES.length)
      .transform((codes) => [...new Set(codes)]),
  })
  .strict();

const roleInclude = {
  permissions: { select: { permissionCode: true } },
  _count: { select: { users: true } },
  users: { select: { name: true }, orderBy: { createdAt: "asc" as const }, take: MEMBER_PREVIEW },
};

const toRole = (r: {
  id: string;
  name: string;
  permissions: { permissionCode: string }[];
  _count: { users: number };
  users: { name: string }[];
}) => ({
  id: r.id,
  name: r.name,
  permissions: r.permissions.map((p) => p.permissionCode).sort((a, b) => rank(a) - rank(b)), // sidebar order, All Records last
  userCount: r._count.users,
  members: r.users.map((u) => ({ initials: initials(u.name) })),
  extraMembers: Math.max(0, r._count.users - MEMBER_PREVIEW),
});

async function assertNameFree(name: string, exceptId?: string) {
  const taken = await prisma.role.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } });
  if (taken && taken.id !== exceptId) throw new AppError(409, "ROLE_NAME_TAKEN", "A role with this name already exists.", { name: "Already in use" });
}

export const rolesRouter = Router();

// In catalogue order (the sidebar's, All Records last), not alphabetical.
rolesRouter.get("/permissions", requirePermission("users"), async (_req, res) => {
  const rows = await prisma.permission.findMany();
  res.json(rows.sort((a, b) => rank(a.code) - rank(b.code)));
});

rolesRouter.get("/roles", requirePermission("users"), async (_req, res) => {
  const roles = await prisma.role.findMany({ include: roleInclude, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  res.json(roles.map(toRole));
});

rolesRouter.post("/roles", requirePermission("users"), async (req, res) => {
  const body = roleBody.parse(req.body);
  await assertNameFree(body.name);
  // Role, its permissions (one multi-row insert) and the audit row commit atomically in one batch; a new role has
  // no members yet, so the response is built from the input instead of re-reading it.
  const id = randomUUID();
  await prisma.$transaction([
    prisma.role.create({
      data: { id, name: body.name, permissions: { createMany: { data: body.permissions.map((permissionCode) => ({ permissionCode })) } } },
      select: { id: true },
    }),
    audit(prisma, { actorId: me(req).id, action: "role_created", entityType: "role", entityId: id, after: body, ip: req.ip }),
  ]);
  res.status(201).json({ id, name: body.name, permissions: [...body.permissions].sort((a, b) => rank(a) - rank(b)), userCount: 0, members: [], extraMembers: 0 });
});

rolesRouter.patch("/roles/:id", requirePermission("users"), async (req, res) => {
  const id = idParam(req);
  const body = roleBody.partial().parse(req.body);
  const [current] = await Promise.all([
    prisma.role.findUnique({ where: { id }, include: roleInclude }),
    body.name && assertNameFree(body.name, id),
  ]);
  if (!current) throw notFound("Role");

  const before = toRole(current);
  const name = body.name ?? current.name;
  const permissions = body.permissions ? [...body.permissions].sort((a, b) => rank(a) - rank(b)) : before.permissions;
  const permissionsChanged = permissions.join() !== before.permissions.join();

  await prisma.$transaction(
    async (tx) => {
      if (permissionsChanged) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: permissions.map((permissionCode) => ({ roleId: id, permissionCode })) });
        await assertAdminRemains(tx); // e.g. removing "users" from the only admin role — only permissions can break this
      }
      if (name !== current.name) await tx.role.update({ where: { id }, data: { name }, select: { id: true } });
      await audit(tx, {
        actorId: me(req).id,
        action: "role_updated",
        entityType: "role",
        entityId: id,
        before: { name: current.name, permissions: before.permissions },
        after: { name, permissions },
        ip: req.ip,
      });
    },
    { isolationLevel: "Serializable" },
  );
  // Members and user count are unchanged by an edit, so they come from the row read above.
  res.json({ ...before, name, permissions });
});

rolesRouter.delete("/roles/:id", requirePermission("users"), async (req, res) => {
  const id = idParam(req);
  const current = await prisma.role.findUnique({ where: { id }, include: roleInclude });
  if (!current) throw notFound("Role");
  if (current._count.users > 0) throw new AppError(409, "ROLE_IN_USE", "Move this role's users to another role before deleting it.");
  await prisma.$transaction([
    prisma.role.delete({ where: { id } }),
    audit(prisma, { actorId: me(req).id, action: "role_deleted", entityType: "role", entityId: id, before: { name: current.name }, ip: req.ip }),
  ]);
  res.status(204).end();
});
