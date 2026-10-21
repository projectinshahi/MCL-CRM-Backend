import { describe, expect, it } from "vitest";
import { csvCell, csvRow, inBatches } from "../../src/lib/csv.ts";

describe("CSV for spreadsheets", () => {
  it("quotes only what needs it, doubling quotes; empty for null", () => {
    expect(csvRow(["plain", 'say "hi"', "a,b", "two\nlines", null, undefined, 12.5])).toBe('plain,"say ""hi""","a,b","two\nlines",,,12.5\r\n');
  });

  it("never lets a cell run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"http://x\",\"click\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\",\"\"click\"\")\"");
    expect(["+91 98456", "-5", "@SUM(A1)", "\tx"].map(csvCell)).toEqual(["'+91 98456", "'-5", "'@SUM(A1)", "'\tx"]);
    expect(csvCell("Rate card – Dubai")).toBe("Rate card – Dubai");
  });

  it("reads every row in id-keyed pages, however many there are", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}` }));
    const calls: unknown[] = [];
    const page = async (args: { take: number; skip?: number; cursor?: { id: string } }) => {
      calls.push(args);
      const from = args.cursor ? all.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0) : 0;
      return all.slice(from, from + args.take);
    };
    const got = [];
    for await (const batch of inBatches(page, 2)) got.push(...batch);
    expect(got).toEqual(all);
    expect(calls).toEqual([{ take: 2 }, { take: 2, skip: 1, cursor: { id: "id-1" } }, { take: 2, skip: 1, cursor: { id: "id-3" } }]);
  });
});
