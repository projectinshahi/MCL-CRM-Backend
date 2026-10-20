import type { Prisma } from "../generated/prisma/client.ts";
import { logger } from "./logger.ts";
import { prisma } from "./prisma.ts";

// In-app notifications (the header bell and the Notifications page): one row per recipient, so reading or clearing
// one is that person's alone. Made only after the change they report has been saved, never for a failed one.
//
// Who is told (any active user, never whoever acted):
//  - administrators: users whose role has "users", the same definition the last-admin guard uses (lib/guards.ts), for
//    events that pass `admins`, whoever's record it is;
//  - the people an event names: a lead's owner, a customer's or follow-up's assignee;
//  - everyone, for events that pass `everyone` (a new team member).
// A row is stored whether or not the recipient's role has the Notifications page today. The page permission only
// decides who may read them (every /notifications route requires it), so an assignment made before a role is given
// the page still shows once it is.
//
// What they read depends on what they may open at the time they read it: GET /notifications adds the record's name
// and a link only for a reader who can see that record now (its page, plus "All records" or being its owner or
// assignee); anyone else reads the event alone ("New lead"). So a notification never reveals a record its reader
// can't open, a later grant shows the full one, and a lost record loses its name. Rows store the event (`what`), the
// record (source_type, source_id) and its link. A deleted record can't be looked up later, so a notification about a
// deletion is written in full at once, for what its recipient could open then, with no source_id.
//
// `key` names the event occurrence ("lead_created:<id>"): (user, key) is unique, so the same event can never notify
// the same person twice — a retried request or save, a repeated reminder run, two API instances.

type Kind = "lead" | "customer" | "follow_up" | "user" | "role";
/** holderId: who sees the record without "All records" (lead owner, customer/follow-up assignee). gone: deleted. */
export type Subject = { kind: Kind; id: string; label: string; holderId: string | null; gone?: boolean };
/** what: the event, alone or before ": <record>". detail: never names a record its readers may not open. */
export type Say = { what: string; detail: string };
export type Notice = {
  key: string;
  actorId: string | null;
  subject: Subject;
  admins?: Say;
  people?: { id: string | null | undefined; say: Say }[];
  everyone?: Say;
  /** Never told, e.g. the new user about their own arrival. */
  skip?: string;
};

const PAGE = { lead: "leads", customer: "customers", follow_up: "follow_ups", user: "users", role: "users" } as const;
const link = (s: Subject) => ({ lead: `/leads/${s.id}`, customer: `/customers/${s.id}`, follow_up: "/follow-ups", user: "/users", role: "/users/roles" })[s.kind];

/** Whether someone with `permissions` may open the record: its page, plus "All records" or being its holder. */
export function canOpen(permissions: Set<string>, userId: string, s: Pick<Subject, "kind" | "holderId">) {
  if (!permissions.has(PAGE[s.kind])) return false;
  return s.kind === "user" || s.kind === "role" || permissions.has("all_records") || s.holderId === userId;
}

/** Saves the notices' notifications now (two round trips); throws on failure. Routes use notify() instead. */
export async function deliver(notices: Notice[]) {
  if (!notices.length) return;
  const named = [...new Set(notices.flatMap((n) => n.people?.map((p) => p.id) ?? []))].filter((id): id is string => !!id);
  const holds = (code: string) => ({ role: { permissions: { some: { permissionCode: code } } } });
  const everyone = notices.some((n) => n.everyone);
  const users = await prisma.user.findMany({
    where: { status: "active", ...(!everyone && { OR: [...(notices.some((n) => n.admins) ? [holds("users")] : []), { id: { in: named } }] }) },
    select: { id: true, role: { select: { permissions: { select: { permissionCode: true } } } } },
    relationLoadStrategy: "join",
  });
  const rows: Prisma.NotificationCreateManyInput[] = [];
  for (const u of users) {
    const permissions = new Set(u.role.permissions.map((p) => p.permissionCode));
    for (const n of notices) {
      if (u.id === n.actorId || u.id === n.skip) continue;
      // Someone the event names gets their own message ("Lead assigned to you"), even when they are an admin too.
      const say = n.people?.find((p) => p.id === u.id)?.say ?? (permissions.has("users") ? n.admins : undefined) ?? n.everyone;
      if (!say) continue;
      const { subject } = n;
      rows.push(
        subject.gone
          ? { userId: u.id, title: canOpen(permissions, u.id, subject) ? `${say.what}: ${subject.label}` : say.what, detail: say.detail, sourceType: subject.kind, dedupeKey: n.key }
          : { userId: u.id, title: say.what, detail: say.detail, link: link(subject), sourceType: subject.kind, sourceId: subject.id, dedupeKey: n.key },
      );
    }
  }
  const { count } = rows.length ? await prisma.notification.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  // Event keys and counts only. Logged when something new was saved or nobody qualified (not for repeats of a
  // reminder that was already saved), so "why did nobody get it?" can be answered from the logs.
  if (count || !rows.length) logger.info({ events: notices.map((n) => n.key), recipients: rows.length, saved: count }, "notifications");
}

const pending = new Set<Promise<void>>();
const RETRY_MS = [1_000, 4_000]; // three attempts in all: a dropped connection or a waking database gets over it

/** Why it failed, without the query's contents: a validation error would print the notification texts. */
const reason = (err: unknown) => {
  const e = err as { code?: string; name?: string; message?: string };
  return e?.code ?? (e?.name?.startsWith("PrismaClient") ? e.name : String(e?.message ?? err).slice(0, 200));
};

/**
 * Saves the notices in the background: the request that made the change doesn't wait for them (each round trip to
 * Neon is ~0.3 s). A failed attempt is retried (the keys make that safe); a final failure is logged by event key and
 * reason only, and never undoes the change.
 */
export function notify(...notices: Notice[]) {
  const saving: Promise<void> = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await deliver(notices);
      } catch (err) {
        const entry = { events: notices.map((n) => n.key), attempt: attempt + 1, reason: reason(err) };
        if (attempt >= RETRY_MS.length) return void logger.error(entry, "notifications not saved");
        logger.warn(entry, "saving notifications failed; retrying");
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS[attempt]));
      }
    }
  })().finally(() => pending.delete(saving));
  pending.add(saving);
  return saving;
}

/** Resolves once every notification being saved in the background is written (tests, a clean shutdown). */
export const notificationsSettled = () => Promise.allSettled([...pending]).then(() => undefined);
