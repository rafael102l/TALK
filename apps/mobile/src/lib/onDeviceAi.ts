import { LANGUAGE_BY_CODE, LanguageCode, VoiceGender, isLanguageCode } from "@talk/shared";
import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { Platform } from "react-native";
import { setPlaybackMode } from "./audio";

const BCP47: Partial<Record<LanguageCode, string>> = {
  he: "he-IL",
  en: "en-US",
  hi: "hi-IN",
  fr: "fr-FR",
  ar: "ar-SA",
  ru: "ru-RU",
  es: "es-ES",
  de: "de-DE",
  pt: "pt-BR",
  it: "it-IT",
  tr: "tr-TR",
  uk: "uk-UA",
  ka: "ka-GE",
  am: "am-ET",
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
  bn: "bn-BD",
  ta: "ta-IN",
  fa: "fa-IR",
  ur: "ur-PK",
  sw: "sw-KE",
};

function locale(code: string) {
  return (isLanguageCode(code) ? BCP47[code] : undefined) || code;
}

function canOnDeviceTranslate(from: string, to: string) {
  if (from === to) return true;
  if (!isLanguageCode(from) || !isLanguageCode(to)) return false;
  return from !== "am" && to !== "am";
}

export async function transcribeOnDevice(uri: string, speakLang: string): Promise<string> {
  try {
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return "";
    return await new Promise((resolve) => {
      let settled = false;
      let finalText = "";
      const resultSub = ExpoSpeechRecognitionModule.addListener("result", (event) => {
        const piece = event.results?.[0]?.transcript?.trim() ?? "";
        if (piece) finalText = piece;
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resultSub.remove();
        errorSub.remove();
        endSub.remove();
        resolve(finalText);
      };
      const errorSub = ExpoSpeechRecognitionModule.addListener("error", () => finish());
      const endSub = ExpoSpeechRecognitionModule.addListener("end", () => finish());
      const timer = setTimeout(() => {
        try {
          ExpoSpeechRecognitionModule.stop();
        } catch {
          finish();
        }
      }, 15000);
      try {
        ExpoSpeechRecognitionModule.start({
          lang: locale(speakLang),
          interimResults: false,
          addsPunctuation: true,
          requiresOnDeviceRecognition: Platform.OS === "ios",
          audioSource: { uri },
        });
      } catch {
        finish();
      }
    });
  } catch {
    return "";
  }
}

type TranslateFn = (input: {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  downloadModelIfNeeded?: boolean;
}) => Promise<unknown>;

export async function translateOnDevice(text: string, from: string, to: string): Promise<string> {
  if (!text) return "";
  if (from === to) return text;
  if (!canOnDeviceTranslate(from, to)) return text;
  try {
    const mod = (await import("@react-native-ml-kit/translate-text")) as {
      default?: { translate: TranslateFn };
      TranslateText?: { translate: TranslateFn };
    };
    const api = mod.default ?? mod.TranslateText;
    if (!api?.translate) return text;
    const result = await api.translate({
      text,
      sourceLanguage: from,
      targetLanguage: to,
      downloadModelIfNeeded: true,
    });
    if (typeof result === "string" && result.trim()) return result.trim();
    return text;
  } catch {
    return text;
  }
}

let allVoices: Speech.Voice[] = [];
let voicesLoaded: Promise<Speech.Voice[]> | null = null;
let warmGen = 0;
let realSpeak = false;

function speechRate(gender: VoiceGender = "male") {
  if (Platform.OS === "ios") return gender === "child" ? 0.58 : gender === "female" ? 0.5 : 0.48;
  return gender === "child" ? 0.98 : gender === "female" ? 0.88 : 0.82;
}

/** Google on-device voice codes (Galaxy dump): real male/female engines, not pitch fakes. */
const MALE_CODES = /\b(x-iob|x-iom|x-iol|x-iog|x-iab|x-ieg|x-dlg|x-gol|x-rjs|x-heb|x-hed|#male|_male)\b/;
const FEMALE_CODES =
  /\b(x-sfg|x-tpf|x-tpc|x-tpd|x-bfd|x-cjc|x-cmb|x-afa|x-hec|x-hee|carmit|tamar|#female|_female)\b/;

function voiceBlob(voice: Speech.Voice) {
  return `${voice.language ?? ""} ${voice.name ?? ""} ${voice.identifier ?? ""}`.toLowerCase();
}

function isLocalVoice(voice: Speech.Voice) {
  return /-local\b/.test(voiceBlob(voice)) || !/-network\b/.test(voiceBlob(voice));
}

function genderScore(voice: Speech.Voice, gender: VoiceGender) {
  const name = voiceBlob(voice);
  const femaleHint = FEMALE_CODES.test(name) || /female|woman|girl|samantha|karen|zira|heera/.test(name);
  const maleHint = MALE_CODES.test(name) || /(?:^|[^a-z])male(?:[^a-z]|$)|(?:^|[^a-z])man(?:[^a-z]|$)|david|daniel|mark|asaf|moshe|avri/.test(name);
  const childHint = /child|kid|junior/.test(name);
  let score = 0;
  if (gender === "child") {
    if (childHint) score = 8;
    else if (femaleHint) score = 3;
    else if (maleHint) score = -2;
  } else if (gender === "female") {
    if (femaleHint) score = 6;
    else if (maleHint) score = -6;
  } else {
    if (maleHint) score = 6;
    else if (femaleHint) score = -8;
  }
  // Prefer on-device packs (no network TTS).
  if (score > 0 && isLocalVoice(voice)) score += 2;
  if (score > 0 && /-network\b/.test(name)) score -= 1;
  return score;
}

function langAliases(listenLang: string) {
  const lang = listenLang.toLowerCase();
  const loc = locale(listenLang).toLowerCase();
  const aliases = new Set([lang, loc, loc.replace("-", "_")]);
  if (lang === "he" || loc.startsWith("he")) {
    aliases.add("iw");
    aliases.add("iw-il");
    aliases.add("iw_il");
    aliases.add("he-il");
  }
  if (lang === "iw") {
    aliases.add("he");
    aliases.add("he-il");
  }
  return aliases;
}

function cacheVoices(list: Speech.Voice[]) {
  allVoices = list;
}

function voiceFor(listenLang: string, gender: VoiceGender = "male") {
  const aliases = langAliases(listenLang);
  const inLang = allVoices.filter((voice) => {
    const blob = voiceBlob(voice);
    const code = (voice.language || "").toLowerCase();
    if (aliases.has(code) || [...aliases].some((a) => code.startsWith(`${a}-`) || code.startsWith(`${a}_`))) {
      return true;
    }
    return [...aliases].some((a) => blob.includes(a));
  });
  const pool = inLang.length ? inLang : allVoices;
  if (!pool.length) return undefined;
  const ranked = [...pool].sort((a, b) => {
    const diff = genderScore(b, gender) - genderScore(a, gender);
    if (diff) return diff;
    const localDiff = Number(isLocalVoice(b)) - Number(isLocalVoice(a));
    if (localDiff) return localDiff;
    return String(a.identifier).localeCompare(String(b.identifier));
  });
  const best = ranked[0];
  if (!best) return undefined;
  if (gender === "male") {
    const male = ranked.find((voice) => genderScore(voice, "male") >= 1);
    return male?.identifier;
  }
  if (gender === "female") {
    const female = ranked.find((voice) => genderScore(voice, "female") >= 1);
    return (female || best).identifier;
  }
  const child = ranked.find((voice) => genderScore(voice, "child") >= 1);
  return (child || best).identifier;
}

async function ensureVoices() {
  if (!voicesLoaded) {
    voicesLoaded = Speech.getAvailableVoicesAsync()
      .then((list) => {
        cacheVoices(list);
        return list;
      })
      .catch(() => [] as Speech.Voice[]);
  }
  await voicesLoaded;
}

export function warmRobot(listenLang?: string, gender: VoiceGender = "male") {
  void ensureVoices();
  void gender;
  void listenLang;
}

export async function speakRobot(
  text: string,
  listenLang: string,
  gender: VoiceGender = "male",
): Promise<boolean> {
  const once = text.replace(/(\S+)(?:\s+\1){1,}/g, "$1").replace(/\s+/g, " ").trim();
  if (!once) return false;
  if (isLanguageCode(listenLang) && LANGUAGE_BY_CODE[listenLang].ttsSupported === false) return false;
  await ensureVoices();
  realSpeak = true;
  const gen = ++warmGen;
  try {
    await Speech.stop();
  } catch {
    /* ignore */
  }
  try {
    await setPlaybackMode();
  } catch {
    /* ignore */
  }
  const rate = speechRate(gender);
  const language = locale(listenLang);
  const voice = voiceFor(listenLang, gender);
  // Real engine voices stay at pitch 1. Child gets a light lift only.
  const pitch = gender === "child" ? 1.35 : 1;

  return new Promise<boolean>((resolve) => {
    if (gen !== warmGen) {
      resolve(false);
      return;
    }
    let finished = false;
    let started = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      if (gen === warmGen) realSpeak = false;
      resolve(ok);
    };
    Speech.speak(once, {
      language,
      ...(voice ? { voice } : {}),
      rate,
      pitch,
      onStart: () => {
        started = true;
      },
      onDone: () => finish(true),
      onStopped: () => finish(started),
      onError: () => finish(false),
    });
    setTimeout(() => finish(started), 25000);
  });
}

export async function stopRobot() {
  try {
    await Speech.stop();
  } catch {
    /* ignore */
  }
}

const voiceMissingListeners = new Set<(missing: boolean) => void>();

export function onTtsVoiceMissing(fn: (missing: boolean) => void) {
  voiceMissingListeners.add(fn);
  return () => {
    voiceMissingListeners.delete(fn);
  };
}

function notifyVoiceMissing(missing: boolean) {
  for (const fn of voiceMissingListeners) fn(missing);
}

export function refreshTtsVoices() {
  voicesLoaded = null;
  void Speech.getAvailableVoicesAsync()
    .then((list) => {
      cacheVoices(list);
      notifyVoiceMissing(list.length === 0);
    })
    .catch(() => notifyVoiceMissing(true));
  void import("./phoneCall")
    .then((mod) => mod.refreshOnDeviceTts())
    .catch(() => undefined);
}

export function openVoiceInstaller() {
  void import("./phoneCall")
    .then((mod) => mod.openTtsInstall())
    .catch(() => undefined);
}
