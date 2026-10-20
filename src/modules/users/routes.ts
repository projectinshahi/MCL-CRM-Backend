import { hash } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { audit } from "../../lib/audit.ts";
import { AppError, invalid, isUniqueViolation, notFound } from "../../lib/errors.ts";
import { assertAdminRemains } from "../../lib/guards.ts";
import { email, idParam, listOf, pageQuery, paged, password, phone, blankToNull, searchQ, text } from "../../lib/http.ts";
import { notify, type Say } from "../../lib/notify.ts";
import { prisma } from "../../lib/prisma.ts";
import { me, requirePermission } from "../../middleware/auth.ts";

const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

const createBody = z
  .object({ name: text(120), email, phone: blankToNull(phone), roleId: z.uuid("Select a role"), password })
  .strict();
// password on edit: optional. Left out, null or "" all mean "keep the current one" (a form's blank field must never
// reset it); anything else must meet the same rule as on create.
const updateBody = z
  .object({
    name: text(120),
    email,
    phone: blankToNull(phone),
    roleId: z.uuid("Select a role"),
    status: z.enum(["active", "inactive"]),
    password: z.preprocess((v) => (v === "" || v === null ? undefined : v), password.optional()),
  })
  .partial()
  .strict();

const snapshot = (u: { name: string; email: string; phone: string | null; status: string; role: { id: string } }) => ({
  name: u.name,
  email: u.email,
  phone: u.phone,
  status: u.status,
  roleId: u.role.id,
});

/** Account changes go to administrators (lib/notify.ts); the key is unique per change. gone: the account was deleted. */
const userNotice = (actor: { id: string }, user: { id: string; name: string }, say: Say, key = `user_updated:${user.id}:${randomUUID()}`, gone = false) =>
  notify({ key, actorId: actor.id, subject: { kind: "user", id: user.id, label: user.name, holderId: null, gone }, admins: say });

const emailTaken = () => new AppError(409, "EMAIL_TAKEN", "A user with this email already exists.", { email: "Already in use" });

async function assertEmailFree(address: string, exceptId?: string) {
  const taken = await prisma.user.findUnique({ where: { email: address }, select: { id: true } });
  if (taken && taken.id !== exceptId) throw emailTaken();
}

async function findRole(roleId: string) {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
  if (!role) throw invalid({ roleId: "Unknown role" });
  return role;
}


export const usersRouter = Router();

usersRouter.get("/users", requirePermission("users"), async (req, res) => {
  const q = pageQuery
    .extend({ q: searchQ, roleId: z.uuid().optional(), status: z.enum(["active", "inactive"]).optional() })
    .parse(req.query);
  const contains = { contains: q.q, mode: "insensitive" } as const;
  const where: Prisma.UserWhereInput = {
    roleId: q.roleId,
    status: q.status,
    ...(q.q && { OR: [{ name: contains }, { email: contains }, { role: { name: contains } }] }),
  };
  // All three in parallel: converted counts are grouped per owner for everyone (one small row per owner),
  // so they no longer wait for the page of users first.
  const [rows, total, converted] = await Promise.all([
    prisma.user.findMany({
      where,
      select: { ...userSelect, _count: { select: { ownedLeads: { where: { deletedAt: null } } } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...paged(q),
    }),
    prisma.user.count({ where }),
    prisma.lead.groupBy({ by: ["ownerId"], where: { deletedAt: null, status: { isWon: true } }, _count: { _all: true } }),
  ]);
  const items = rows.map(({ _count, ...u }) => ({
    ...u,
    assignedLeads: _count.ownedLeads,
    convertedLeads: converted.find((c) => c.ownerId === u.id)?._count._all ?? 0,
  }));
  res.json(listOf(items, q, total));
});

usersRouter.post("/users", requirePermission("users"), async (req, res) => {
  const body = createBody.parse(req.body);
  const { password: plain, ...data } = body;
  // The checks run in one round trip, and the password is hashed while they are in flight.
  const [, role, passwordHash] = await Promise.all([assertEmailFree(body.email), findRole(body.roleId), hash(plain)]);
  // User + audit row commit atomically. The id is generated here so both inserts go in one batch, with no re-read.
  const id = randomUUID();
  const after = { name: data.name, email: data.email, phone: data.phone ?? null, status: "active", roleId: role.id };
  const [user] = await prisma
    .$transaction([
      prisma.user.create({ data: { id, ...data, passwordHash }, select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true } }),
      audit(prisma, { actorId: me(req).id, action: "user_created", entityType: "user", entityId: id, after, ip: req.ip }),
    ])
    .catch((e) => {
      throw isUniqueViolation(e) ? emailTaken() : e; // lost a race with another create using the same email
    });
  // Every other active user hears of a new colleague (their name only: no email, phone or role); administrators get
  // the account itself ("User added: <name>", with the role and a link to Users). The new user is not told.
  void notify({
    key: `user_created:${id}`,
    actorId: me(req).id,
    subject: { kind: "user", id, label: user.name, holderId: null },
    admins: { what: "User added", detail: `${me(req).name} added them as ${role.name}` },
    everyone: { what: "New team member", detail: `${user.name}, added by ${me(req).name}` },
    skip: id,
  });
  res.status(201).json({ ...user, role, assignedLeads: 0, convertedLeads: 0 });
});

usersRouter.patch("/users/:id", requirePermission("users"), async (req, res) => {
  const id = idParam(req);
  const { password: plain, ...body } = updateBody.parse(req.body);
  if (id === me(req).id && body.status === "inactive")
    throw new AppError(409, "CANNOT_DEACTIVATE_SELF", "You cannot deactivate your own account.");
  // A new password is hashed (same argon2 as create and reset) while the checks are in flight; nothing is written
  // until every check has passed, so an invalid edit changes nothing at all.
  const [current, , , passwordHash] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: userSelect }),
    body.email && assertEmailFree(body.email, id),
    body.roleId && findRole(body.roleId),
    plain ? hash(plain) : undefined,
  ]);
  if (!current) throw notFound("User");

  // Serializable so two admins cannot demote each other at the same moment and leave none.
  const user = await prisma.$transaction(
    async (tx) => {
      const u = await tx.user.update({ where: { id }, data: { ...body, ...(passwordHash && { passwordHash }) }, select: userSelect });
      if (body.status === "inactive") await tx.session.deleteMany({ where: { userId: id } });
      else if (passwordHash) {
        // Like a completed password reset: the user signs in again everywhere with the new password, except the
        // session making this change when admins change their own.
        const self = id === me(req).id;
        await tx.session.deleteMany({ where: { userId: id, ...(self && { id: { not: req.auth!.sessionId } }) } });
      }
      if (passwordHash) await audit(tx, { actorId: me(req).id, action: "user_password_changed", entityType: "user", entityId: id, ip: req.ip });
      await assertAdminRemains(tx);
      await audit(tx, { actorId: me(req).id, action: "user_updated", entityType: "user", entityId: id, before: snapshot(current), after: snapshot(u), ip: req.ip });
      return u;
    },
    { isolationLevel: "Serializable" },
  );
  // A save that changed nothing (the form sends every field) tells nobody.
  const by = me(req).name;
  const changed = !!passwordHash || JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(user));
  const say =
    !changed
      ? null
      : user.status !== current.status
      ? { what: user.status === "inactive" ? "User deactivated" : "User reactivated", detail: `By ${by}` }
      : user.role.id !== current.role.id
        ? { what: "User role changed", detail: `${by} changed their role from ${current.role.name} to ${user.role.name}` }
        : { what: "User updated", detail: `${by} updated their account` };
  if (say) void userNotice(me(req), user, say);
  res.json(user);
});

// Report: "204; deactivates if they own records". The account is deactivated first (sessions revoked);
// it is then hard-deleted only if nothing references it (leads, follow-ups, audit trail…).
usersRouter.delete("/users/:id", requirePermission("users"), async (req, res) => {
  const id = idParam(req);
  if (id === me(req).id) throw new AppError(409, "CANNOT_DELETE_SELF", "You cannot delete your own account.");
  const current = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!current) throw notFound("User");

  await prisma.$transaction(
    async (tx) => {
      await tx.user.update({ where: { id }, data: { status: "inactive" } });
      await tx.session.deleteMany({ where: { userId: id } });
      await assertAdminRemains(tx);
      await audit(tx, { actorId: me(req).id, action: "user_deactivated", entityType: "user", entityId: id, before: snapshot(current), ip: req.ip });
    },
    { isolationLevel: "Serializable" },
  );
  let deleted = false;
  try {
    // Together, so a deleted account always has its audit row and is reported as removed.
    await prisma.$transaction([
      prisma.user.delete({ where: { id } }),
      audit(prisma, { actorId: me(req).id, action: "user_deleted", entityType: "user", entityId: id, ip: req.ip }),
    ]);
    deleted = true;
  } catch {
    // Referenced by business or audit records: it stays as an inactive user.
  }
  // An account that was already inactive and is kept changed nothing; a deleted one is named in full now (it can't be
  // looked up later).
  if (deleted) void userNotice(me(req), current, { what: "User removed", detail: `By ${me(req).name}` }, `user_removed:${id}`, true);
  else if (current.status === "active") void userNotice(me(req), current, { what: "User deactivated", detail: `By ${me(req).name}` });
  res.status(204).end();
});

// Assignee pickers (lead owner, BDE, follow-up Assigned To, customer Assigned User).
usersRouter.get("/users/options", requirePermission("leads", "follow_ups", "customers"), async (req, res) => {
  const q = z.object({ roleId: z.uuid().optional() }).parse(req.query);
  const users = await prisma.user.findMany({
    where: { status: "active", roleId: q.roleId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  res.json(users);
});
