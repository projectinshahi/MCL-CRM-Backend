import { parsePhoneNumberFromString, validatePhoneNumberLength, type CountryCode } from "libphonenumber-js/max";
import { env } from "../config/env.ts";

// Phone numbers are validated against full numbering-plan metadata ("max": real number patterns per country,
// not just digit counts) and stored as E.164 ("+919876543210"). MCL-CRM-Frontend/lib/phone.ts applies the same
// rules with the same pinned library version and messages, so the form and the API agree.

export const PHONE_MESSAGES = {
  required: "Enter a phone number.",
  noCountry: "Select a country.",
  incomplete: "This number appears incomplete.",
  badCountryCode: "Please check the country code and number.",
  invalid: "Enter a valid phone number for the selected country.",
  extension: "Enter the number without an extension.",
} as const;

/**
 * "+…" numbers carry their own country. Digits without "+" (older API callers, legacy rows) are read as numbers of
 * `region` (DEFAULT_PHONE_COUNTRY), whose national and international dialling prefixes ("0…", "00…") are honoured.
 * A valid-looking number is not proof that the line exists or belongs to anyone.
 */
export function checkPhone(input: string, region: CountryCode | null = env.DEFAULT_PHONE_COUNTRY as CountryCode): { e164: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: PHONE_MESSAGES.required };
  const country = text.startsWith("+") ? undefined : (region ?? undefined); // null = no country known
  if (!text.startsWith("+") && !country) return { error: PHONE_MESSAGES.noCountry };
  const length = validatePhoneNumberLength(text, country);
  if (length === "TOO_SHORT") return { error: PHONE_MESSAGES.incomplete };
  if (length === "INVALID_COUNTRY") return { error: PHONE_MESSAGES.badCountryCode };
  const number = parsePhoneNumberFromString(text, country);
  if (length || !number?.isValid()) return { error: PHONE_MESSAGES.invalid };
  if (number.ext) return { error: PHONE_MESSAGES.extension }; // E.164 cannot hold it, and it is never dropped silently
  return { e164: number.number };
}
