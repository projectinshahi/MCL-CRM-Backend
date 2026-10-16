// Pure helpers (no env / database imports) so unit tests can load them directly.

// Money is NUMERIC(14,2) in PostgreSQL and a JSON number of rupees on the wire.
export const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
export const toMoney = (d: { toFixed(digits: number): string } | null) => (d == null ? null : Number(d.toFixed(2)));

// Business calendar is India (report Q20): "today" is the Asia/Kolkata date, timestamps stay UTC.
const istDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const todayIST = (now = new Date()) => istDay.format(now); // "YYYY-MM-DD"

export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export const parseDateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

// Overdue is derived, never stored: a pending follow-up whose due date is before today (IST).
export function followUpStatus(status: "pending" | "completed", dueDate: Date, today = todayIST()) {
  if (status === "completed") return "completed" as const;
  return dateOnly(dueDate) < today ? ("overdue" as const) : ("pending" as const);
}

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

// Label used by the follow-up "Lead / Contact" select and tables: "Company - Contact", else the lead title.
export const leadLabel = (l: { title: string; companyName: string | null; contactName: string | null }) =>
  [l.companyName, l.contactName].filter(Boolean).join(" - ") || l.title;
