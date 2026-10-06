"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LANGUAGE = exports.LANGUAGE_BY_CODE = exports.LANGUAGES = void 0;
exports.isLanguageCode = isLanguageCode;
exports.LANGUAGES = [
    { code: "he", nameHe: "עברית", nameEn: "Hebrew", rtl: true, ttsSupported: true },
    { code: "en", nameHe: "אנגלית", nameEn: "English", ttsSupported: true },
    { code: "hi", nameHe: "הודית", nameEn: "Hindi", ttsSupported: true },
    { code: "fr", nameHe: "צרפתית", nameEn: "French", ttsSupported: true },
    { code: "ar", nameHe: "ערבית", nameEn: "Arabic", rtl: true, ttsSupported: true },
    { code: "ru", nameHe: "רוסית", nameEn: "Russian", ttsSupported: true },
    { code: "es", nameHe: "ספרדית", nameEn: "Spanish", ttsSupported: true },
    { code: "de", nameHe: "גרמנית", nameEn: "German", ttsSupported: true },
    { code: "pt", nameHe: "פורטוגזית", nameEn: "Portuguese", ttsSupported: true },
    { code: "it", nameHe: "איטלקית", nameEn: "Italian", ttsSupported: true },
    { code: "tr", nameHe: "טורקית", nameEn: "Turkish", ttsSupported: true },
    { code: "uk", nameHe: "אוקראינית", nameEn: "Ukrainian", ttsSupported: true },
    { code: "ka", nameHe: "גאורגית", nameEn: "Georgian", ttsSupported: false },
    { code: "am", nameHe: "אמהרית", nameEn: "Amharic", ttsSupported: false },
    { code: "zh", nameHe: "סינית", nameEn: "Chinese", ttsSupported: true },
    { code: "ja", nameHe: "יפנית", nameEn: "Japanese", ttsSupported: true },
    { code: "ko", nameHe: "קוריאנית", nameEn: "Korean", ttsSupported: true },
    { code: "pl", nameHe: "פולנית", nameEn: "Polish", ttsSupported: true },
];
exports.LANGUAGE_BY_CODE = Object.fromEntries(exports.LANGUAGES.map((language) => [language.code, language]));
exports.DEFAULT_LANGUAGE = "he";
function isLanguageCode(value) {
    return value in exports.LANGUAGE_BY_CODE;
}
//# sourceMappingURL=languages.js.map