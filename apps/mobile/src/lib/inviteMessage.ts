import { guessE164, parsePastedPhone, type CountryCode, type LanguageCode } from "@talk/shared";

/** SMS invite body language from the recipient's dialing country. */
const COUNTRY_TO_LANG: Partial<Record<CountryCode, LanguageCode>> = {
  IL: "he",
  RU: "ru",
  BY: "ru",
  KZ: "ru",
  UA: "uk",
  US: "en",
  GB: "en",
  AU: "en",
  CA: "en",
  IE: "en",
  NZ: "en",
  ZA: "en",
  SA: "ar",
  AE: "ar",
  EG: "ar",
  JO: "ar",
  KW: "ar",
  QA: "ar",
  BH: "ar",
  OM: "ar",
  LB: "ar",
  IQ: "ar",
  MA: "ar",
  DZ: "ar",
  TN: "ar",
  FR: "fr",
  BE: "fr",
  DE: "de",
  AT: "de",
  CH: "de",
  ES: "es",
  MX: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  IN: "hi",
  PT: "pt",
  BR: "pt",
  IT: "it",
  TR: "tr",
  PL: "pl",
  NL: "nl",
  CN: "zh",
  TW: "zh",
  HK: "zh",
  JP: "ja",
  KR: "ko",
  TH: "th",
  VN: "vi",
  ID: "id",
  MY: "ms",
  PH: "tl",
  SE: "sv",
  NO: "no",
  DK: "da",
  FI: "fi",
  GR: "el",
  CZ: "cs",
  RO: "ro",
  HU: "hu",
  BG: "bg",
  HR: "hr",
  SK: "sk",
  AM: "am",
  GE: "ka",
  IR: "fa",
  PK: "ur",
  BD: "bn",
};

const INVITE_BY_LANG: Partial<Record<LanguageCode, string>> & { en: string } = {
  he: "רוצה לשוחח איתי ב־TALK? אפשר לדבר באופן מהיר, פשוט ומאובטח — והכול בחינם. בואו לדבר בכל שפה בסגנון ווקי־טוקי / מירס.",
  en: "Want to talk with me on TALK? You can chat fast, simple and secure — and it's all free. Come talk in any language, walkie-talkie / MIRS style.",
  ru: "Хочешь поговорить со мной в TALK? Можно общаться быстро, просто и безопасно — и всё бесплатно. Давай говорить на любом языке в стиле рации / MIRS.",
  uk: "Хочеш поговорити зі мною в TALK? Можна спілкуватися швидко, просто і безпечно — і все безкоштовно. Давай говорити будь-якою мовою у стилі рації / MIRS.",
  ar: "تبغى تحكي معي على TALK؟ تقدر تتكلم بسرعة وببساطة وبأمان — والكل مجاناً. يلا نحكي بأي لغة بأسلوب جهاز اللاسلكي / ميرس.",
  fr: "Tu veux discuter avec moi sur TALK ? On peut parler rapidement, simplement et en toute sécurité — et c’est gratuit. Venez parler dans toutes les langues, style talkie-walkie / MIRS.",
  de: "Willst du mit mir auf TALK sprechen? Schnell, einfach und sicher — und alles kostenlos. Komm, lass uns in jeder Sprache sprechen, Walkie-Talkie- / MIRS-Stil.",
  es: "¿Quieres hablar conmigo en TALK? Puedes chatear de forma rápida, simple y segura — y todo gratis. Ven a hablar en cualquier idioma, estilo walkie-talkie / MIRS.",
  hi: "क्या आप मुझसे TALK पर बात करना चाहते हैं? तेज़, आसान और सुरक्षित — और सब कुछ मुफ़्त। किसी भी भाषा में वॉकी-टॉकी / MIRS स्टाइल में बात करें।",
  pt: "Quer falar comigo no TALK? Rápido, simples e seguro — e tudo de graça. Venha falar em qualquer idioma, estilo walkie-talkie / MIRS.",
  it: "Vuoi parlare con me su TALK? Veloce, semplice e sicuro — e tutto gratis. Parliamo in qualsiasi lingua, stile walkie-talkie / MIRS.",
  tr: "TALK’ta benimle konuşmak ister misin? Hızlı, basit ve güvenli — hepsi ücretsiz. Her dilde walkie-talkie / MIRS tarzında konuşalım.",
  pl: "Chcesz ze mną pogadać na TALK? Szybko, prosto i bezpiecznie — i wszystko za darmo. Gadajmy w każdym języku w stylu walkie-talkie / MIRS.",
  nl: "Wil je met me praten op TALK? Snel, eenvoudig en veilig — en helemaal gratis. Kom praten in elke taal, walkie-talkie- / MIRS-stijl.",
  zh: "想在 TALK 上和我聊天吗？快速、简单又安全——而且全部免费。用任何语言，对讲机 / MIRS 风格来聊吧。",
  ja: "TALKで話しませんか？速くてシンプルで安全、そして無料です。どんな言語でもトランシーバー / MIRSスタイルで話しましょう。",
  ko: "TALK에서 나랑 대화할래? 빠르고 간단하고 안전하며 전부 무료야. 어떤 언어든 무전 / MIRS 스타일로 이야기하자.",
};

export type InviteTarget = {
  e164: string;
  country: CountryCode;
  display: string;
  messageLang: LanguageCode;
  message: string;
};

export function inviteTargetFromQuery(query: string, fallbackCountry: CountryCode = "IL"): InviteTarget | null {
  // Same normalization as lookup — spaces/dashes must not block invite.
  const cleaned = query.trim().replace(/[\s()-]/g, "");
  if (!cleaned) return null;
  const parsed =
    parsePastedPhone(cleaned, fallbackCountry) ||
    parsePastedPhone(query.trim(), fallbackCountry) ||
    (() => {
      const e164 = guessE164(query);
      if (!e164) return null;
      return { e164, country: fallbackCountry as CountryCode, national: e164 };
    })();
  if (!parsed) return null;
  const fromPlus = parsePastedPhone(parsed.e164, fallbackCountry);
  const country = (fromPlus?.country || parsed.country || fallbackCountry) as CountryCode;
  const messageLang = COUNTRY_TO_LANG[country] || "en";
  const message = INVITE_BY_LANG[messageLang] || INVITE_BY_LANG.en;
  return {
    e164: parsed.e164,
    country,
    display: formatInvitePhone(parsed.e164),
    messageLang,
    message,
  };
}

export function formatInvitePhone(e164: string) {
  // +972505225543 → +972 50-522-5543 (simple IL-friendly; otherwise spaced groups)
  if (e164.startsWith("+972") && e164.length >= 12) {
    const rest = e164.slice(4);
    return `+972 ${rest.slice(0, 2)}-${rest.slice(2, 5)}-${rest.slice(5)}`;
  }
  if (e164.length > 6) {
    return `${e164.slice(0, 3)} ${e164.slice(3, 6)}-${e164.slice(6, 9)}-${e164.slice(9)}`.replace(/-+$/, "");
  }
  return e164;
}
