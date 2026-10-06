import { type CountryCode } from "libphonenumber-js";
export declare function toE164(input: string, defaultCountry?: CountryCode): string | null;
export declare function hashPhone(e164: string, salt: string): string;
export declare function maskPhone(e164: string): string;
