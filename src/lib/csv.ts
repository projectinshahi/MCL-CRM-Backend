import { once } from "node:events";
import type { Response } from "express";
import { todayIST } from "./format.ts";

// Report downloads (Leads, Customers, Follow-ups): every record matching the list's search and filters, within the
// caller's scope — the same query as the list, never just the page on screen.
//
// CSV that spreadsheet apps open correctly: UTF-8 with a byte-order mark (Excel then shows ₹ and Indian names), CRLF
// lines, fields quoted per RFC 4180. A cell starting with = + - @ or a tab/CR is prefixed with ' so a spreadsheet
// shows it as text instead of running it as a formula (CSV injection: a lead titled =HYPERLINK(...) is data).

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;

/** Rows of a list query in pages of `size`, keyset-paginated on id (no offsets: stable while rows are added). */
export async function* inBatches<T extends { id: string }>(page: (args: { take: number; skip?: number; cursor?: { id: string } }) => Promise<T[]>, size = 500) {
  let cursor: string | undefined;
  for (;;) {
    const rows = await page({ take: size, ...(cursor && { skip: 1, cursor: { id: cursor } }) });
    if (rows.length) yield rows;
    if (rows.length < size) return;
    cursor = rows.at(-1)!.id;
  }
}

/**
 * Streams a CSV download named `<name>-<India date>.csv`: the header, then each batch as it is read (memory stays
 * flat however many rows match; a slow client is waited for). The first batch is read before anything is sent, so
 * most failures still get the API's normal JSON error. Resolves to the number of data rows.
 */
export async function sendCsv<T>(res: Response, name: string, header: string[], batches: AsyncIterable<T[]>, cells: (row: T) => unknown[]) {
  const it = batches[Symbol.asyncIterator]();
  let next = await it.next();
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}-${todayIST()}.csv"` });
  let rows = 0;
  let chunk = `﻿${csvRow(header)}`;
  while (!next.done) {
    for (const r of next.value) chunk += csvRow(cells(r));
    rows += next.value.length;
    if (!res.write(chunk)) await once(res, "drain");
    chunk = "";
    next = await it.next();
  }
  res.end(chunk);
  return rows;
}
