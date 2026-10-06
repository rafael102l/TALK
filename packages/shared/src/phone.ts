import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { sha256 } from "js-sha256";

export { isSupportedCountry, type CountryCode };

export const DEFAULT_COUNTRY: CountryCode = "IL";

export function toE164(input: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

export function guessE164(input: string): string | null {
  const trimmed = input.trim().replace(/[\s()-]/g, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return toE164(trimmed);
  return toE164(trimmed, DEFAULT_COUNTRY) ?? toE164(trimmed, "US");
}

export function parsePastedPhone(input: string, fallbackCountry: CountryCode = DEFAULT_COUNTRY) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = trimmed.startsWith("+")
    ? parsePhoneNumberFromString(trimmed)
    : parsePhoneNumberFromString(trimmed, fallbackCountry);
  if (!parsed || !parsed.isValid()) return null;
  return {
    e164: parsed.number,
    country: (parsed.country ?? fallbackCountry) as CountryCode,
    national: parsed.nationalNumber,
  };
}

export function hashPhone(e164: string, salt: string): string {
  return sha256(`${salt}:${e164}`);
}

export function maskPhone(e164: string): string {
  if (e164.length < 6) return e164;
  return `${e164.slice(0, 4)}••••${e164.slice(-3)}`;
}
