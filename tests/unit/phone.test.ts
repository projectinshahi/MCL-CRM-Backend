import { getCountries, getExampleNumber, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import examples from "libphonenumber-js/examples.mobile.json";
import { describe, expect, it } from "vitest";
import { blankToNull, phone } from "../../src/lib/http.ts";
import { checkPhone, PHONE_MESSAGES as M } from "../../src/lib/phone.ts";

// Numbers come from the library's own metadata (per-country example numbers) or are long-standing
// libphonenumber test lines (Google's +1 650-253-0000 and +44 20 7031 3000) — none are invented.
const ok = (input: string, region?: CountryCode | null) => checkPhone(input, region);
const example = (c: CountryCode) => getExampleNumber(c, examples)!;

describe("checkPhone — valid numbers become E.164", () => {
  it("accepts every country's example number, entered internationally or nationally", () => {
    const countries = getCountries();
    expect(countries.length).toBeGreaterThan(240);
    for (const c of countries) {
      const n = example(c);
      expect(ok(n.number), `${c} international`).toEqual({ e164: n.number });
      expect(ok(n.formatNational(), c), `${c} national`).toEqual({ e164: n.number });
    }
  });

  it("India: mobile with or without +91, trunk 0, 00 prefix and punctuation", () => {
    for (const input of ["+91 81234 56789", "8123456789", "081234 56789", "0091 81234 56789", "+91 (812) 345-6789", "91 81234 56789"])
      expect(ok(input, "IN"), input).toEqual({ e164: "+918123456789" });
  });

  it("US, UK, UAE and Australia", () => {
    expect(ok("+1 (650) 253-0000")).toEqual({ e164: "+16502530000" });
    expect(ok("(650) 253-0000", "US")).toEqual({ e164: "+16502530000" });
    expect(ok("+44 20 7031 3000")).toEqual({ e164: "+442070313000" });
    expect(ok("020 7031 3000", "GB")).toEqual({ e164: "+442070313000" });
    expect(ok(example("AE").formatInternational())).toEqual({ e164: example("AE").number });
    expect(ok(example("AU").formatNational(), "AU")).toEqual({ e164: example("AU").number });
  });

  it("countries sharing a calling code resolve to the right region", () => {
    for (const [c, shared] of [["CA", "US"], ["JE", "GB"], ["KZ", "RU"]] as const) {
      const n = example(c);
      // Entered with the neighbouring country selected, the number still validates and keeps its own region.
      const result = ok(n.formatNational(), shared);
      expect(result, c).toEqual({ e164: n.number });
      expect(parsePhoneNumberFromString(n.number)?.country).toBe(c);
    }
  });

  it("numbers of different lengths are judged by the numbering plan, not a digit count", () => {
    const lengths = new Set(getCountries().map((c) => example(c).nationalNumber.length));
    expect(lengths.size).toBeGreaterThan(4); // e.g. 7-digit to 11-digit national numbers
  });
});

describe("checkPhone — problems are explained", () => {
  it("empty, missing country, incomplete, unknown code, impossible pattern, too long, not a number", () => {
    expect(ok("")).toEqual({ error: M.required });
    expect(ok("8123456789", null)).toEqual({ error: M.noCountry });
    expect(ok("+91 81234")).toEqual({ error: M.incomplete });
    expect(ok("+999 1234567")).toEqual({ error: M.badCountryCode });
    expect(ok("+1 123 456 7890")).toEqual({ error: M.invalid }); // right length, but NANP area codes never start with 1
    expect(ok("+91 81234 56789 0123")).toEqual({ error: M.invalid });
    expect(ok("call me")).toEqual({ error: M.invalid });
    expect(ok("+44 20 7031 3000 ext. 12")).toEqual({ error: M.extension }); // refused, not silently dropped
    expect(ok("020 7031 3000 x12", "GB")).toEqual({ error: M.extension });
  });

  it("the same digits are a different number in a different country", () => {
    expect(ok("020 7031 3000", "GB")).toEqual({ e164: "+442070313000" }); // London
    expect(ok("020 7031 3000", "IN")).toEqual({ e164: "+912070313000" }); // Pune (STD code 020), also valid
  });
});

describe("phone field schema (API bodies)", () => {
  const optional = blankToNull(phone);
  it("normalises to E.164, treats blank as no value, and reports the reason", () => {
    expect(optional.parse(" +44 20 7031 3000 ")).toBe("+442070313000");
    expect(optional.parse("")).toBeNull();
    expect(optional.parse(null)).toBeNull();
    expect(optional.parse(undefined)).toBeUndefined();
    expect(optional.safeParse("+91 81234").error?.issues[0]?.message).toBe(M.incomplete);
    expect(optional.safeParse("+".padEnd(60, "1")).success).toBe(false);
    expect(optional.safeParse(9876543210).success).toBe(false); // numbers are strings, never numeric
  });
});
