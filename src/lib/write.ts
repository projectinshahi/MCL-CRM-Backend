import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "./prisma.ts";

// Edits that also leave history (activity entries, audit rows) are written as ONE SQL statement: a single round trip,
// and atomic like a transaction (all or nothing). A Prisma transaction for the same work makes ~5 sequential round
// trips (BEGIN, update, re-read, insert, COMMIT): ~1.6 s to Neon from India, where one round trip is ~0.3 s.

// Every model field written here is its camelCase name in snake_case (the @map convention in schema.prisma).
const snake = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const snakeKeys = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));
const columns = (names: string[]) => Prisma.join(names.map((n) => Prisma.raw(`"${n}"`)));

type Table = "leads" | "customers" | "follow_ups";
type HistoryTable = "lead_activities" | "audit_logs";

/**
 * `INSERT INTO table … SELECT` of `rows` (model field → value; an undefined value leaves that column to its
 * default), typed by the table's own columns like the updates below. A fragment for a WITH clause: several inserts
 * in one statement are one round trip and all or nothing, and foreign keys between them are checked at its end.
 * Fields mapped to another column name are passed by that name in camelCase (createdBy for "created_by").
 */
export function insertRows(table: "leads" | "lead_attachments", rows: object[]) {
  const clean = rows.map((r) => snakeKeys(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))));
  const names = [...new Set(clean.flatMap(Object.keys))];
  return Prisma.sql`INSERT INTO ${Prisma.raw(table)} (${columns(names)})
    SELECT ${Prisma.join(names.map((n) => Prisma.raw(`x."${n}"`)))} FROM json_populate_recordset(NULL::${Prisma.raw(table)}, ${JSON.stringify(clean)}::json) x`;
}

/**
 * Updates the live row `id` of `table` (deleted_at IS NULL; follow-ups have no soft delete) with `set` (model field → value; null clears) and
 * inserts `history` rows (model fields, camelCase) only if the update happened. `version` adds an optimistic-lock
 * condition; a versioned table's version always goes up by one. The API's clock stamps updated_at and the history
 * rows' created_at, as Prisma's @updatedAt does. Returns the row's new updatedAt (and version), or null when no live
 * row matched (deleted, or no longer at `version`). `also`: further WITH clauses (", name AS (…)") of the same
 * statement, each acting only WHERE EXISTS (SELECT FROM upd).
 */
export async function updateWithHistory(
  table: Table,
  id: string,
  { set, version, history = [], also = [] }: { set: object; version?: number; history?: { table: HistoryTable; rows: object[] }[]; also?: Prisma.Sql[] },
) {
  const now = new Date();
  const fields = Object.keys(set).map(snake);
  // json_populate_record turns the JSON values into the columns' own types (numeric, enums, uuid, timestamptz).
  const assign = fields.length
    ? Prisma.sql`(${columns(fields)}) = (SELECT ${Prisma.join(fields.map((f) => Prisma.raw(`r."${f}"`)))} FROM json_populate_record(NULL::${Prisma.raw(table)}, ${JSON.stringify(snakeKeys(set))}::json) r),`
    : Prisma.empty;
  const versioned = table === "leads";
  const inserts = history
    .filter((h) => h.rows.length)
    .map((h, i) => {
      // Activity entries take their id from here; audit rows number themselves (bigserial).
      const rows = h.rows.map((r) => snakeKeys({ ...(h.table === "lead_activities" && { id: randomUUID() }), ...r, createdAt: now }));
      const names = [...new Set(rows.flatMap(Object.keys))];
      return Prisma.sql`, h${Prisma.raw(String(i))} AS (
        INSERT INTO ${Prisma.raw(h.table)} (${columns(names)})
        SELECT ${Prisma.join(names.map((n) => Prisma.raw(`x."${n}"`)))} FROM json_populate_recordset(NULL::${Prisma.raw(h.table)}, ${JSON.stringify(rows)}::json) x
        WHERE EXISTS (SELECT FROM upd))`;
    });
  const [row] = await prisma.$queryRaw<{ updated_at: Date; version?: number }[]>`
    WITH upd AS (
      UPDATE ${Prisma.raw(table)} SET ${assign} ${versioned ? Prisma.sql`version = version + 1,` : Prisma.empty} updated_at = ${now}
      WHERE id = ${id}::uuid ${table === "follow_ups" ? Prisma.empty : Prisma.sql`AND deleted_at IS NULL`} ${version === undefined ? Prisma.empty : Prisma.sql`AND version = ${version}`}
      RETURNING updated_at${versioned ? Prisma.raw(", version") : Prisma.empty}
    )${inserts.length ? Prisma.join(inserts, "") : Prisma.empty}${also.length ? Prisma.join(also, "") : Prisma.empty}
    SELECT * FROM upd`;
  return row ? { updatedAt: row.updated_at, ...(versioned && { version: row.version! }) } : null;
}
