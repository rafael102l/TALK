export type LanguageCode =
  | "he"
  | "en"
  | "hi"
  | "fr"
  | "ar"
  | "ru"
  | "es"
  | "de"
  | "pt"
  | "it"
  | "tr"
  | "uk"
  | "ka"
  | "am"
  | "zh"
  | "ja"
  | "ko"
  | "pl"
  | "nl"
  | "id"
  | "sv"
  | "da"
  | "no"
  | "fi"
  | "el"
  | "cs"
  | "ro"
  | "hu"
  | "vi"
  | "th"
  | "ms"
  | "tl"
  | "bg"
  | "hr"
  | "sk"
  | "bn"
  | "ta"
  | "fa"
  | "ur"
  | "sw";

export type Language = {
  code: LanguageCode;
  nameHe: string;
  nameEn: string;
  nativeName: string;
  rtl?: boolean;
  ttsSupported: boolean;
};

export const LANGUAGES: Language[] = [
  { code: "he", nameHe: "עברית", nameEn: "Hebrew", nativeName: "עברית", rtl: true, ttsSupported: true },
  { code: "en", nameHe: "אנגלית", nameEn: "English", nativeName: "English", ttsSupported: true },
  { code: "ar", nameHe: "ערבית", nameEn: "Arabic", nativeName: "العربية", rtl: true, ttsSupported: true },
  { code: "ru", nameHe: "רוסית", nameEn: "Russian", nativeName: "Русский", ttsSupported: true },
  { code: "hi", nameHe: "הודית", nameEn: "Hindi", nativeName: "हिन्दी", ttsSupported: true },
  { code: "fr", nameHe: "צרפתית", nameEn: "French", nativeName: "Français", ttsSupported: true },
  { code: "es", nameHe: "ספרדית", nameEn: "Spanish", nativeName: "Español", ttsSupported: true },
  { code: "de", nameHe: "גרמנית", nameEn: "German", nativeName: "Deutsch", ttsSupported: true },
  { code: "pt", nameHe: "פורטוגזית", nameEn: "Portuguese", nativeName: "Português", ttsSupported: true },
  { code: "it", nameHe: "איטלקית", nameEn: "Italian", nativeName: "Italiano", ttsSupported: true },
  { code: "tr", nameHe: "טורקית", nameEn: "Turkish", nativeName: "Türkçe", ttsSupported: true },
  { code: "uk", nameHe: "אוקראינית", nameEn: "Ukrainian", nativeName: "Українська", ttsSupported: true },
  { code: "zh", nameHe: "סינית", nameEn: "Chinese", nativeName: "中文", ttsSupported: true },
  { code: "ja", nameHe: "יפנית", nameEn: "Japanese", nativeName: "日本語", ttsSupported: true },
  { code: "ko", nameHe: "קוריאנית", nameEn: "Korean", nativeName: "한국어", ttsSupported: true },
  { code: "pl", nameHe: "פולנית", nameEn: "Polish", nativeName: "Polski", ttsSupported: true },
  { code: "nl", nameHe: "הולנדית", nameEn: "Dutch", nativeName: "Nederlands", ttsSupported: true },
  { code: "id", nameHe: "אינדונזית", nameEn: "Indonesian", nativeName: "Bahasa Indonesia", ttsSupported: true },
  { code: "sv", nameHe: "שוודית", nameEn: "Swedish", nativeName: "Svenska", ttsSupported: true },
  { code: "da", nameHe: "דנית", nameEn: "Danish", nativeName: "Dansk", ttsSupported: true },
  { code: "no", nameHe: "נורווגית", nameEn: "Norwegian", nativeName: "Norsk", ttsSupported: true },
  { code: "fi", nameHe: "פינית", nameEn: "Finnish", nativeName: "Suomi", ttsSupported: true },
  { code: "el", nameHe: "יוונית", nameEn: "Greek", nativeName: "Ελληνικά", ttsSupported: true },
  { code: "cs", nameHe: "צ'כית", nameEn: "Czech", nativeName: "Čeština", ttsSupported: true },
  { code: "ro", nameHe: "רומנית", nameEn: "Romanian", nativeName: "Română", ttsSupported: true },
  { code: "hu", nameHe: "הונגרית", nameEn: "Hungarian", nativeName: "Magyar", ttsSupported: true },
  { code: "vi", nameHe: "וייטנאמית", nameEn: "Vietnamese", nativeName: "Tiếng Việt", ttsSupported: true },
  { code: "th", nameHe: "תאית", nameEn: "Thai", nativeName: "ไทย", ttsSupported: true },
  { code: "ms", nameHe: "מלאית", nameEn: "Malay", nativeName: "Bahasa Melayu", ttsSupported: true },
  { code: "tl", nameHe: "פיליפינית", nameEn: "Filipino", nativeName: "Filipino", ttsSupported: true },
  { code: "bg", nameHe: "בולגרית", nameEn: "Bulgarian", nativeName: "Български", ttsSupported: true },
  { code: "hr", nameHe: "קרואטית", nameEn: "Croatian", nativeName: "Hrvatski", ttsSupported: true },
  { code: "sk", nameHe: "סלובקית", nameEn: "Slovak", nativeName: "Slovenčina", ttsSupported: true },
  { code: "bn", nameHe: "בנגלית", nameEn: "Bengali", nativeName: "বাংলা", ttsSupported: true },
  { code: "ta", nameHe: "טמילית", nameEn: "Tamil", nativeName: "தமிழ்", ttsSupported: true },
  { code: "fa", nameHe: "פרסית", nameEn: "Persian", nativeName: "فارسی", rtl: true, ttsSupported: true },
  { code: "ur", nameHe: "אורדו", nameEn: "Urdu", nativeName: "اردو", rtl: true, ttsSupported: true },
  { code: "sw", nameHe: "סווהילי", nameEn: "Swahili", nativeName: "Kiswahili", ttsSupported: true },
  { code: "ka", nameHe: "גאורגית", nameEn: "Georgian", nativeName: "ქართული", ttsSupported: true },
  { code: "am", nameHe: "אמהרית", nameEn: "Amharic", nativeName: "አማርኛ", ttsSupported: true },
];

export const LANGUAGE_BY_CODE = Object.fromEntries(
  LANGUAGES.map((language) => [language.code, language]),
) as Record<LanguageCode, Language>;

export const DEFAULT_LANGUAGE: LanguageCode = "he";

export function isLanguageCode(value: string): value is LanguageCode {
  return value in LANGUAGE_BY_CODE;
}
