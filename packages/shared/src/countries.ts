import { getCountries, getCountryCallingCode, type CountryCode } from "libphonenumber-js";

const PRIORITY: CountryCode[] = [
  "IL",
  "US",
  "GB",
  "RU",
  "UA",
  "FR",
  "DE",
  "ES",
  "IT",
  "TR",
  "AE",
  "IN",
  "BR",
  "CA",
  "AU",
  "PL",
  "NL",
  "PT",
  "RO",
  "CN",
  "JP",
  "KR",
  "MX",
  "AR",
  "ZA",
  "EG",
  "MA",
  "JO",
  "PS",
  "LB",
  "SA",
  "IQ",
  "IR",
  "ET",
  "KE",
  "NG",
  "PH",
  "TH",
  "VN",
  "ID",
  "MY",
  "SG",
  "NZ",
  "SE",
  "NO",
  "FI",
  "DK",
  "CH",
  "AT",
  "BE",
  "GR",
  "CZ",
  "HU",
  "IE",
];

export type PhoneCountry = {
  iso: CountryCode;
  callingCode: string;
  name: string;
  flag: string;
};

export function countryFlag(iso: string) {
  if (!/^[A-Z]{2}$/i.test(iso)) return "🌐";
  return iso
    .toUpperCase()
    .split("")
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");
}

function countryName(iso: string) {
  try {
    return new Intl.DisplayNames(["he"], { type: "region" }).of(iso) ?? iso;
  } catch {
    return iso;
  }
}

let cached: PhoneCountry[] | null = null;

export function listPhoneCountries(): PhoneCountry[] {
  if (cached) return cached;
  const priority = new Map(PRIORITY.map((iso, index) => [iso, index]));
  cached = getCountries()
    .map((iso) => ({
      iso,
      callingCode: getCountryCallingCode(iso),
      name: countryName(iso),
      flag: countryFlag(iso),
    }))
    .sort((a, b) => {
      const pa = priority.get(a.iso) ?? 1000;
      const pb = priority.get(b.iso) ?? 1000;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name, "he");
    });
  return cached;
}

export function findPhoneCountry(iso: CountryCode) {
  return listPhoneCountries().find((row) => row.iso === iso) ?? listPhoneCountries()[0];
}
