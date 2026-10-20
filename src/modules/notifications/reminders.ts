import { addDays, dateOnly, indiaDate, leadLabel, parseDateOnly, todayIST } from "../../lib/format.ts";
import { logger } from "../../lib/logger.ts";
import { deliver, type Notice } from "../../lib/notify.ts";
import { prisma } from "../../lib/prisma.ts";

// Due-date reminders, made by the API itself (at startup, then on a timer), so they arrive whether or not anyone has
// the app open, and are kept in the notification feed for later. Each run works from the records as they are now: a
// follow-up whose date moved is reminded about its new date, a completed or deleted one (or one on a deleted lead)
// not at all. Every reminder's key holds the date it is about, so however often this runs — restarts, missed runs, two
// API instances — each person gets each reminder once.
//
//  - Follow-ups (India calendar days, the app's business calendar): "due tomorrow" the day before and "due today" on
//    the day, to the assignee; from the day after, if still pending, "overdue" to the assignee and administrators. A
//    run that missed a stage's day skips that stage rather than sending it late ("due tomorrow" on the day itself).
//  - Lead reminders (the lead page's "Schedule Follow Up Reminder"): at their time, to whoever scheduled them and the
//    lead's owner. notified_at marks them sent.
// LOOKBACK_DAYS bounds both, so a first run (or one after a long outage) doesn't flood everyone with old ones.
// The data model has no expiry dates (contracts, documents…) to remind about; follow-up due dates are the deadlines.

export const LOOKBACK_DAYS = 7;
const TYPE = { whatsapp: "WhatsApp", call: "Call", email: "Email", meeting: "Meeting" } as const;
// "20/10/2026, 3:30 pm", as the app shows times (lib/api.ts dateTime), in India time.
const indiaTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Sends every reminder due at `now`; returns when the next lead reminder falls due (null: none scheduled). */
export async function sendDueReminders(now = new Date()) {
  const today = todayIST(now);
  const [followUps, reminders, next] = await Promise.all([
    prisma.followUp.findMany({
      where: {
        status: "pending",
        lead: { deletedAt: null },
        dueDate: { gte: parseDateOnly(addDays(today, -LOOKBACK_DAYS)), lte: parseDateOnly(addDays(today, 1)) },
      },
      select: { id: true, dueDate: true, type: true, assignedUserId: true, assignee: { select: { name: true } }, lead: { select: { title: true, contactName: true, companyName: true } } },
    }),
    prisma.reminder.findMany({
      where: { notifiedAt: null, dueAt: { lte: now, gte: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000) }, lead: { deletedAt: null } },
      select: { id: true, title: true, dueAt: true, createdById: true, lead: { select: { id: true, title: true, ownerId: true } } },
    }),
    prisma.reminder.findFirst({ where: { notifiedAt: null, dueAt: { gt: now } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
  ]);

  const notices: Notice[] = [];
  for (const f of followUps) {
    const due = dateOnly(f.dueDate);
    const subject = { kind: "follow_up" as const, id: f.id, label: leadLabel(f.lead), holderId: f.assignedUserId };
    const base = { actorId: null, subject };
    if (due === addDays(today, 1))
      notices.push({ ...base, key: `fu_due_soon:${f.id}:${due}`, people: [{ id: f.assignedUserId, say: { what: "Follow-up due tomorrow", detail: `${TYPE[f.type]} on ${indiaDate(due)}` } }] });
    else if (due === today)
      notices.push({ ...base, key: `fu_due_today:${f.id}:${due}`, people: [{ id: f.assignedUserId, say: { what: "Follow-up due today", detail: `${TYPE[f.type]} today, ${indiaDate(due)}` } }] });
    else
      notices.push({
        ...base,
        key: `fu_overdue:${f.id}:${due}`,
        people: [{ id: f.assignedUserId, say: { what: "Follow-up overdue", detail: `${TYPE[f.type]} was due on ${indiaDate(due)}` } }],
        admins: { what: "Follow-up overdue", detail: `${TYPE[f.type]} was due on ${indiaDate(due)}${f.assignee ? `, assigned to ${f.assignee.name}` : ""}` },
      });
  }
  for (const r of reminders) {
    const say = { what: "Reminder", detail: `${r.title}, ${indiaTime.format(r.dueAt)}` };
    notices.push({
      key: `reminder:${r.id}`,
      actorId: null,
      subject: { kind: "lead", id: r.lead.id, label: r.lead.title, holderId: r.lead.ownerId },
      people: [{ id: r.createdById, say }, { id: r.lead.ownerId, say }],
    });
  }
  // Saved first, marked sent after: a run that stops in between sends them again next time, and the keys keep that
  // from notifying anyone twice.
  await deliver(notices);
  if (reminders.length) await prisma.reminder.updateMany({ where: { id: { in: reminders.map((r) => r.id) } }, data: { notifiedAt: now } });
  return next?.dueAt ?? null;
}

// Every 15 minutes (follow-up stages are whole days, so this is plenty), and sooner when a lead reminder falls due.
// Not every minute: an idle Neon database suspends after a few minutes without queries, and a short timer would keep
// it (and its bill) running all night.
const EVERY_MS = 15 * 60_000;
let started = false; // by server.ts only: tests and scripts that load the routes never start it
let timer: NodeJS.Timeout | undefined;
let plannedAt = Infinity;

/** Plans the next run for `at` (default: now), unless one is already planned sooner or the timer isn't running. */
export function scheduleReminders(at = Date.now()) {
  if (!started || (timer && plannedAt <= at)) return;
  clearTimeout(timer);
  plannedAt = Math.min(at, Date.now() + EVERY_MS);
  timer = setTimeout(run, Math.max(0, plannedAt - Date.now()));
  timer.unref();
}

async function run() {
  timer = undefined;
  let next = Date.now() + EVERY_MS;
  try {
    const due = await sendDueReminders();
    if (due) next = Math.min(next, due.getTime());
  } catch (err) {
    logger.error({ reason: err instanceof Error ? err.message : String(err) }, "due-date reminders failed; retrying on the next run");
  }
  scheduleReminders(next);
}

export function startReminders() {
  started = true;
  scheduleReminders();
}

export function stopReminders() {
  started = false; // a run still in progress won't plan another
  clearTimeout(timer);
}
