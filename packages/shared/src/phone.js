"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toE164 = toE164;
exports.hashPhone = hashPhone;
exports.maskPhone = maskPhone;
const libphonenumber_js_1 = require("libphonenumber-js");
const js_sha256_1 = require("js-sha256");
const DEFAULT_COUNTRY = "IL";
function toE164(input, defaultCountry = DEFAULT_COUNTRY) {
    const trimmed = input.trim();
    if (!trimmed)
        return null;
    const parsed = (0, libphonenumber_js_1.parsePhoneNumberFromString)(trimmed, defaultCountry);
    if (!parsed || !parsed.isValid())
        return null;
    return parsed.number;
}
function hashPhone(e164, salt) {
    return (0, js_sha256_1.sha256)(`${salt}:${e164}`);
}
function maskPhone(e164) {
    if (e164.length < 6)
        return e164;
    return `${e164.slice(0, 4)}••••${e164.slice(-3)}`;
}
//# sourceMappingURL=phone.js.map