import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { sha256 } from "js-sha256";

export { isSupportedCountry, type CountryCode };

export const DEFAULT_COUNTRY: CountryCode = "IL";

function phoneCandidates(input: string, defaultCountry: CountryCode) {
  const trimmed = input.trim().replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  if (!trimmed) return [];
  const compact = trimmed.replace(/[^\d+]/g, "");
  const candidates = [trimmed];
  if (compact.startsWith("+")) candidates.unshift(compact);
  if (compact.startsWith("00")) candidates.unshift(`+${compact.slice(2)}`);
  // 9725... without a plus, and local 054... / 54..., all become the same +972 number.
  if (!compact.startsWith("+") && compact.startsWith("972")) candidates.unshift(`+${compact}`);
  if (defaultCountry === "IL" && /^5\d{8}$/.test(compact)) candidates.unshift(`0${compact}`);
  return [...new Set(candidates.filter(Boolean))];
}

export function toE164(input: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  for (const candidate of phoneCandidates(input, defaultCountry)) {
    const parsed = candidate.startsWith("+")
      ? parsePhoneNumberFromString(candidate)
      : parsePhoneNumberFromString(candidate, defaultCountry);
    if (parsed?.isValid()) return parsed.number;
  }
  return null;
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
