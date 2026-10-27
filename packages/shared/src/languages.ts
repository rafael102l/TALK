export type AppLangCode =
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

export type LanguageCode =
  | AppLangCode
  | "ar-EG"
  | "ar-SA"
  | "ar-PS"
  | "ar-IL"
  | "ar-IQ"
  | "ar-LB"
  | "ar-MA"
  | "ar-DR"
  | "ar-BD"
  | "ar-SY"
  | "ar-JO"
  | "ar-DZ"
  | "ar-TN"
  | "ar-YE"
  | "ar-AE"
  | "ar-SD"
  | "hi-IN"
  | "pa"
  | "en-GB"
  | "en-AU"
  | "en-IN"
  | "es-MX"
  | "es-AR"
  | "pt-PT"
  | "fr-CA"
  | "zh-TW";

export type Language = {
  code: LanguageCode;
  /** App UI / RTL / script family. Dialects keep their parent here. */
  base: AppLangCode;
  nameHe: string;
  nameEn: string;
  nativeName: string;
  groupHe: string;
  groupEn: string;
  rtl?: boolean;
  ttsSupported: boolean;
  /** BCP-47 for on-device STT/TTS. */
  locale: string;
  /** ISO-639-1 for Whisper's `language` field. */
  whisper: string;
  /** Dialect name sent in STT/translate prompts. */
  prompt: string;
};

const APP_LANGS = new Set<string>([
  "he",
  "en",
  "hi",
  "fr",
  "ar",
  "ru",
  "es",
  "de",
  "pt",
  "it",
  "tr",
  "uk",
  "ka",
  "am",
  "zh",
  "ja",
  "ko",
  "pl",
  "nl",
  "id",
  "sv",
  "da",
  "no",
  "fi",
  "el",
  "cs",
  "ro",
  "hu",
  "vi",
  "th",
  "ms",
  "tl",
  "bg",
  "hr",
  "sk",
  "bn",
  "ta",
  "fa",
  "ur",
  "sw",
]);

function L(
  code: LanguageCode,
  nameHe: string,
  nameEn: string,
  nativeName: string,
  opts: {
    base?: AppLangCode;
    groupHe?: string;
    groupEn?: string;
    rtl?: boolean;
    ttsSupported?: boolean;
    locale?: string;
    whisper?: string;
    prompt?: string;
  } = {},
): Language {
  const base = opts.base || ((code.split("-")[0] || "en") as AppLangCode);
  return {
    code,
    base,
    nameHe,
    nameEn,
    nativeName,
    groupHe: opts.groupHe || nameHe,
    groupEn: opts.groupEn || nameEn,
    rtl: opts.rtl,
    ttsSupported: opts.ttsSupported !== false,
    locale: opts.locale || defaultLocale(code, base),
    whisper: opts.whisper || base,
    prompt: opts.prompt || nameEn,
  };
}

function defaultLocale(code: LanguageCode, base: AppLangCode) {
  if (code.includes("-")) return code;
  const tags: Partial<Record<AppLangCode, string>> = {
    he: "he-IL",
    en: "en-US",
    ar: "ar",
    ru: "ru-RU",
    hi: "hi-IN",
    fr: "fr-FR",
    es: "es-ES",
    de: "de-DE",
    pt: "pt-BR",
    it: "it-IT",
    tr: "tr-TR",
    uk: "uk-UA",
    zh: "zh-CN",
    ja: "ja-JP",
    ko: "ko-KR",
    pl: "pl-PL",
    nl: "nl-NL",
    id: "id-ID",
    sv: "sv-SE",
    da: "da-DK",
    no: "nb-NO",
    fi: "fi-FI",
    el: "el-GR",
    cs: "cs-CZ",
    ro: "ro-RO",
    hu: "hu-HU",
    vi: "vi-VN",
    th: "th-TH",
    ms: "ms-MY",
    tl: "fil-PH",
    bg: "bg-BG",
    hr: "hr-HR",
    sk: "sk-SK",
    bn: "bn-IN",
    ta: "ta-IN",
    fa: "fa-IR",
    ur: "ur-PK",
    sw: "sw-KE",
    ka: "ka-GE",
    am: "am-ET",
  };
  return tags[base] || code;
}

export const LANGUAGES: Language[] = [
  L("he", "עברית", "Hebrew", "עברית", { rtl: true, locale: "he-IL", prompt: "Hebrew" }),

  L("en", "אנגלית (ארה״ב)", "English (US)", "English (US)", {
    groupHe: "אנגלית",
    groupEn: "English",
    locale: "en-US",
    prompt: "American English",
  }),
  L("en-GB", "אנגלית (בריטניה)", "English (UK)", "English (UK)", {
    groupHe: "אנגלית",
    groupEn: "English",
    locale: "en-GB",
    prompt: "British English",
  }),
  L("en-AU", "אנגלית (אוסטרליה)", "English (Australia)", "English (AU)", {
    groupHe: "אנגלית",
    groupEn: "English",
    locale: "en-AU",
    prompt: "Australian English",
  }),
  L("en-IN", "אנגלית (הודו)", "English (India)", "English (IN)", {
    groupHe: "אנגלית",
    groupEn: "English",
    locale: "en-IN",
    prompt: "Indian English",
  }),

  L("ar", "ערבית ספרותית", "Arabic (MSA)", "العربية الفصحى", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar",
    prompt: "Modern Standard Arabic (Fusha)",
  }),
  L("ar-PS", "ערבית פלסטינית", "Palestinian Arabic", "العامية الفلسطينية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-PS",
    prompt: "Palestinian Levantine spoken Arabic, not Modern Standard Arabic and not a Latin transliteration",
  }),
  L("ar-IL", "ערבית מדוברת", "Spoken Arabic", "العامية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-IL",
    prompt: "Spoken colloquial Arabic (Amiya) as used in daily speech in Israel and the Levant, not Fusha",
  }),
  L("ar-EG", "ערבית מצרית", "Arabic (Egypt)", "العامية المصرية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-EG",
    prompt: "Egyptian Arabic (Masri)",
  }),
  L("ar-SA", "ערבית סעודית", "Saudi Arabic", "العربية السعودية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-SA",
    prompt: "Saudi Arabic (Hijazi / Najdi), not Bedouin Negev speech",
  }),
  L("ar-BD", "ערבית בדואית", "Bedouin Arabic", "العربية البدوية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-IL",
    whisper: "ar",
    prompt: "Bedouin Arabic as spoken by Bedouin communities in the Negev, Sinai, and the Levant. Not Fusha and not Egyptian Arabic",
  }),
  L("ar-SY", "ערבית סורית", "Syrian Arabic", "العامية السورية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-SY",
    prompt: "Syrian Levantine spoken Arabic",
  }),
  L("ar-JO", "ערבית ירדנית", "Jordanian Arabic", "العامية الأردنية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-JO",
    prompt: "Jordanian Levantine spoken Arabic",
  }),
  L("ar-DZ", "ערבית אלג'יראית", "Algerian Arabic", "الدارجة الجزائرية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-DZ",
    prompt: "Algerian Arabic (Darija)",
  }),
  L("ar-TN", "ערבית טוניסאית", "Tunisian Arabic", "الدارجة التونسية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-TN",
    prompt: "Tunisian Arabic (Darija)",
  }),
  L("ar-YE", "ערבית תימנית", "Yemeni Arabic", "العربية اليمنية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-YE",
    prompt: "Yemeni Arabic",
  }),
  L("ar-AE", "ערבית אמירתית", "Emirati Arabic", "العربية الإماراتية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-AE",
    prompt: "Emirati / Gulf Arabic",
  }),
  L("ar-SD", "ערבית סודאנית", "Sudanese Arabic", "العربية السودانية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-SD",
    prompt: "Sudanese Arabic",
  }),
  L("ar-LB", "ערבית לבנונית", "Arabic (Lebanon)", "العامية اللبنانية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-LB",
    prompt: "Lebanese Arabic",
  }),
  L("ar-IQ", "ערבית עיראקית", "Arabic (Iraq)", "العامية العراقية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-IQ",
    prompt: "Iraqi Arabic",
  }),
  L("ar-MA", "ערבית מגרבית", "Arabic (Maghreb)", "الدارجة المغربية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-MA",
    prompt: "Maghrebi Arabic (Darija)",
  }),
  L("ar-DR", "דרוזית", "Druze Arabic", "درزية", {
    groupHe: "ערבית",
    groupEn: "Arabic",
    rtl: true,
    locale: "ar-IL",
    whisper: "ar",
    prompt: "Druze Levantine Arabic as spoken by Druze communities in Israel, Syria, and Lebanon",
  }),

  L("hi", "הינדית", "Hindi", "हिन्दी", {
    groupHe: "הודית",
    groupEn: "Hindi",
    locale: "hi-IN",
    prompt: "Hindi in Devanagari script. Never romanize. Never write Latin letters",
  }),
  L("hi-IN", "הינדית (הודו)", "Hindi (India)", "हिन्दी", {
    base: "hi",
    groupHe: "הודית",
    groupEn: "Hindi",
    locale: "hi-IN",
    whisper: "hi",
    prompt: "Indian Hindi in Devanagari script. Never romanize",
  }),
  L("pa", "פנג'אבי", "Punjabi", "ਪੰਜਾਬੀ", {
    base: "hi",
    groupHe: "הודית",
    groupEn: "Hindi",
    locale: "pa-IN",
    whisper: "pa",
    prompt: "Punjabi (Gurmukhi)",
  }),

  L("ru", "רוסית", "Russian", "Русский", { locale: "ru-RU" }),
  L("fr", "צרפתית", "French", "Français", {
    groupHe: "צרפתית",
    groupEn: "French",
    locale: "fr-FR",
    prompt: "French (France)",
  }),
  L("fr-CA", "צרפתית (קנדה)", "French (Canada)", "Français (CA)", {
    groupHe: "צרפתית",
    groupEn: "French",
    locale: "fr-CA",
    prompt: "Canadian French",
  }),
  L("es", "ספרדית", "Spanish", "Español", {
    groupHe: "ספרדית",
    groupEn: "Spanish",
    locale: "es-ES",
    prompt: "Spanish (Spain)",
  }),
  L("es-MX", "ספרדית (מקסיקו)", "Spanish (Mexico)", "Español (MX)", {
    groupHe: "ספרדית",
    groupEn: "Spanish",
    locale: "es-MX",
    prompt: "Mexican Spanish",
  }),
  L("es-AR", "ספרדית (ארגנטינה)", "Spanish (Argentina)", "Español (AR)", {
    groupHe: "ספרדית",
    groupEn: "Spanish",
    locale: "es-AR",
    prompt: "Rioplatense / Argentine Spanish",
  }),
  L("de", "גרמנית", "German", "Deutsch"),
  L("pt", "פורטוגזית (ברזיל)", "Portuguese (Brazil)", "Português (BR)", {
    groupHe: "פורטוגזית",
    groupEn: "Portuguese",
    locale: "pt-BR",
    prompt: "Brazilian Portuguese",
  }),
  L("pt-PT", "פורטוגזית (פורטוגל)", "Portuguese (Portugal)", "Português (PT)", {
    groupHe: "פורטוגזית",
    groupEn: "Portuguese",
    locale: "pt-PT",
    prompt: "European Portuguese",
  }),
  L("it", "איטלקית", "Italian", "Italiano"),
  L("tr", "טורקית", "Turkish", "Türkçe"),
  L("uk", "אוקראינית", "Ukrainian", "Українська"),
  L("zh", "סינית (פשוטה)", "Chinese (Simplified)", "中文", {
    groupHe: "סינית",
    groupEn: "Chinese",
    locale: "zh-CN",
    prompt: "Mandarin Chinese, Simplified",
  }),
  L("zh-TW", "סינית (מסורתית)", "Chinese (Traditional)", "中文 (繁體)", {
    groupHe: "סינית",
    groupEn: "Chinese",
    locale: "zh-TW",
    prompt: "Mandarin Chinese, Traditional",
  }),
  L("ja", "יפנית", "Japanese", "日本語"),
  L("ko", "קוריאנית", "Korean", "한국어"),
  L("pl", "פולנית", "Polish", "Polski"),
  L("nl", "הולנדית", "Dutch", "Nederlands"),
  L("id", "אינדונזית", "Indonesian", "Bahasa Indonesia"),
  L("sv", "שוודית", "Swedish", "Svenska"),
  L("da", "דנית", "Danish", "Dansk"),
  L("no", "נורווגית", "Norwegian", "Norsk"),
  L("fi", "פינית", "Finnish", "Suomi"),
  L("el", "יוונית", "Greek", "Ελληνικά"),
  L("cs", "צ'כית", "Czech", "Čeština"),
  L("ro", "רומנית", "Romanian", "Română"),
  L("hu", "הונגרית", "Hungarian", "Magyar"),
  L("vi", "וייטנאמית", "Vietnamese", "Tiếng Việt"),
  L("th", "תאית", "Thai", "ไทย"),
  L("ms", "מלאית", "Malay", "Bahasa Melayu"),
  L("tl", "פיליפינית", "Filipino", "Filipino", { locale: "fil-PH", whisper: "tl" }),
  L("bg", "בולגרית", "Bulgarian", "Български"),
  L("hr", "קרואטית", "Croatian", "Hrvatski"),
  L("sk", "סלובקית", "Slovak", "Slovenčina"),
  L("bn", "בנגלית", "Bengali", "বাংলা"),
  L("ta", "טמילית", "Tamil", "தமிழ்"),
  L("fa", "פרסית", "Persian", "فارسی", { rtl: true }),
  L("ur", "אורדו", "Urdu", "اردو", { rtl: true }),
  L("sw", "סווהילי", "Swahili", "Kiswahili"),
  L("ka", "גאורגית", "Georgian", "ქართული"),
  L("am", "אמהרית", "Amharic", "አማርኛ"),
];

export const LANGUAGE_BY_CODE = Object.fromEntries(
  LANGUAGES.map((language) => [language.code, language]),
) as Record<LanguageCode, Language>;

export const DEFAULT_LANGUAGE: LanguageCode = "he";

export function isAppLangCode(value: string): value is AppLangCode {
  return APP_LANGS.has(value);
}

/** ISO-639-1 codes the production translator accepts (he, en, ar, ru, ...). */
export const API_LANG_CODES = [...APP_LANGS] as AppLangCode[];

/** Keep full picker/dialect tags for translator A/B. Never collapse `ar-DR` → `ar`. */
export function keepSpeechCode(value?: string | null, fallback = ""): string {
  const canon = canonicalSpeech(value);
  if (canon) return canon;
  const raw = (value || "").trim().toLowerCase().replace(/_/g, "-");
  return raw || fallback;
}

/**
 * Map a picker / device / dialect tag to the 2-letter code the walkie translator allows.
 * `en-AU` → `en`, `ar-DR` → `ar`, `ru-RU` → `ru`.
 */
export function apiLangCode(value?: string | null, fallback: AppLangCode = "en"): AppLangCode {
  const canon = canonicalSpeech(value);
  if (canon) {
    const primary = canon.split("-")[0] || "";
    if (isAppLangCode(primary)) return primary;
    const base = speechBase(canon);
    if (base && isAppLangCode(base)) return base;
  }
  const raw = (value || "").trim().toLowerCase().replace(/_/g, "-");
  const token = raw.split(/[-_\s/,;]/)[0] || "";
  const two = token.slice(0, 2);
  if (isAppLangCode(two)) return two;
  return fallback;
}

export function isLanguageCode(value: string): value is LanguageCode {
  return value in LANGUAGE_BY_CODE;
}

/** Normalize a picker / profile / Whisper value to the exact stored speech code. */
export function canonicalSpeech(value?: string | null): LanguageCode | "" {
  const raw = (value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase().replace(/_/g, "-");
  if (lower === "iw" || lower === "heb" || lower === "hebrew") return "he";
  if (lower === "ara" || lower === "arabic" || lower === "fusha" || lower === "msa") return "ar";
  if (lower === "urd" || lower === "urdu") return "ur";
  if (lower === "fas" || lower === "per" || lower === "persian" || lower === "farsi") return "fa";
  if (lower === "chi" || lower === "chinese" || lower === "cmn") return "zh";
  if (lower === "fil" || lower === "tl") return "tl";
  if (lower === "nb" || lower === "nn" || lower === "nor") return "no";
  if (lower === "jpn" || lower === "japanese") return "ja";
  if (lower === "kor" || lower === "korean") return "ko";
  if (lower === "tur") return "tr";
  if (lower === "ukr") return "uk";
  if (lower === "pol" || lower === "po") return "pl";
  if (lower === "pan" || lower === "punjabi" || lower === "pa") return isLanguageCode("pa") ? "pa" : "hi";
  const parts = lower.split("-").filter(Boolean);
  const primary = parts[0] || "";
  const region = parts[1] ? parts[1].toUpperCase() : "";
  const code = region ? `${primary}-${region}` : primary;
  if (isLanguageCode(code)) return code;
  if (isLanguageCode(primary)) return primary;
  return "";
}

export function speechOf(code?: string | null): Language | undefined {
  const canon = canonicalSpeech(code);
  return canon ? LANGUAGE_BY_CODE[canon] : undefined;
}

export function speechBase(code?: string | null): AppLangCode | "" {
  const lang = speechOf(code);
  if (lang) return lang.base;
  const canon = canonicalSpeech(code);
  return canon && isAppLangCode(canon) ? canon : "";
}

export function whisperLang(code?: string | null): string {
  return speechOf(code)?.whisper || speechBase(code) || "";
}

export function speechLocale(code?: string | null): string {
  return speechOf(code)?.locale || canonicalSpeech(code) || "";
}

export function speechPrompt(code?: string | null): string {
  const lang = speechOf(code);
  return lang?.prompt || lang?.nameEn || canonicalSpeech(code) || "";
}

export function languageLabel(code?: string | null, hebrew = false): string {
  const lang = speechOf(code);
  if (!lang) return code || "";
  return hebrew ? lang.nameHe : lang.nativeName || lang.nameEn;
}

function prettyLangLabel(label: string) {
  const first = label.charAt(0);
  if (!first || /[^\u0000-\u024F]/.test(first)) return label;
  return first.toUpperCase() + label.slice(1);
}

export function languageDisplayName(code?: string | null, uiLang?: string | null): string {
  const lang = speechOf(code);
  if (!lang) return code || "";
  const ui = speechBase(uiLang) || canonicalSpeech(uiLang) || "";
  if (ui === "he") return lang.nameHe;
  if (ui === "en") return lang.nameEn;
  const locales = [speechLocale(uiLang), ui, "en"].filter(Boolean);
  try {
    const dn = new Intl.DisplayNames(locales, { type: "language" });
    const baseLabel = prettyLangLabel(dn.of(lang.base) || "");
    for (const tag of [lang.locale, lang.code, lang.base]) {
      const raw = dn.of(tag);
      if (!raw || raw === tag) continue;
      const label = prettyLangLabel(raw);
      if (lang.code !== lang.base && baseLabel && label.toLowerCase() === baseLabel.toLowerCase()) {
        const region = lang.code.split("-")[1] || "";
        if (region && region !== "DR") {
          try {
            const regionName = new Intl.DisplayNames(locales, { type: "region" }).of(region);
            if (regionName) return `${label} (${prettyLangLabel(regionName)})`;
          } catch {
            /* no region data */
          }
        }
        return lang.nameEn || label;
      }
      return label;
    }
  } catch {
    /* Intl.DisplayNames missing */
  }
  return lang.nameEn || lang.nativeName || lang.code;
}

function normName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const NAME_ALIASES: Record<string, LanguageCode> = {
  hebrew: "he",
  ivrit: "he",
  עברית: "he",
  english: "en",
  אנגלית: "en",
  arabic: "ar",
  ערבית: "ar",
  fusha: "ar",
  druze: "ar-DR",
  דרוזית: "ar-DR",
  דרוזי: "ar-DR",
  درزي: "ar-DR",
  درزية: "ar-DR",
  egyptian: "ar-EG",
  מצרית: "ar-EG",
  lebanese: "ar-LB",
  לבנונית: "ar-LB",
  iraqi: "ar-IQ",
  עיראקית: "ar-IQ",
  maghreb: "ar-MA",
  מרוקאית: "ar-MA",
  saudi: "ar-SA",
  סעודית: "ar-SA",
  bedouin: "ar-BD",
  בדואית: "ar-BD",
  בדואי: "ar-BD",
  بدوي: "ar-BD",
  بدوية: "ar-BD",
  palestinian: "ar-PS",
  פלסטינית: "ar-PS",
  israeli: "ar-IL",
  מדוברת: "ar-IL",
  عامية: "ar-IL",
  amiya: "ar-IL",
  spoken: "ar-IL",
  hindi: "hi",
  הינדית: "hi",
  הינדי: "hi",
  הודית: "hi",
  हिन्दी: "hi",
  punjabi: "pa",
  "פנג'אבי": "pa",
  urdu: "ur",
  אורדו: "ur",
  russian: "ru",
  רוסית: "ru",
};

/** Map a spoken or typed language name to the exact catalog code, including dialects. */
export function matchLanguageName(spoken: string): LanguageCode | "" {
  const q = normName(spoken);
  if (!q) return "";
  const alias = NAME_ALIASES[q.replace(/-/g, "")];
  if (alias) return alias;
  let best: { code: LanguageCode; score: number } | null = null;
  for (const lang of LANGUAGES) {
    const fields = [lang.nativeName, lang.nameHe, lang.nameEn, lang.groupHe, lang.groupEn, lang.prompt, lang.code];
    for (const field of fields) {
      const n = normName(field);
      if (!n) continue;
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q) || q.startsWith(n)) score = 80;
      else if (n.includes(q) || q.includes(n)) score = Math.min(n.length, q.length) >= 3 ? 55 : 0;
      if (score && (!best || score > best.score)) best = { code: lang.code, score };
    }
  }
  for (const [alias, code] of Object.entries(NAME_ALIASES)) {
    const n = normName(alias);
    if (n === q) return code;
    if (n.includes(q) || q.includes(n)) {
      const score = 70;
      if (!best || score > best.score) best = { code, score };
    }
  }
  return best && best.score >= 55 ? best.code : "";
}
