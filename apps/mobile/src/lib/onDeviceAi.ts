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
  if (Platform.OS === "ios") return gender === "child" ? 0.55 : 0.5;
  return gender === "child" ? 0.95 : 0.85;
}

function genderScore(voice: Speech.Voice, gender: VoiceGender) {
  const name = `${voice.name ?? ""} ${voice.identifier ?? ""}`.toLowerCase();
  if (gender === "child") {
    if (/child|kid|boy|girl|junior/.test(name)) return 6;
    if (/female|woman/.test(name)) return 2;
    return 0;
  }
  if (gender === "female") {
    if (/female|woman|girl|samantha|karen|zira|tamar|carmit|heera/.test(name)) return 5;
    if (/male|man|david|daniel|mark|asaf/.test(name)) return -3;
    return 0;
  }
  if (/male|man|david|daniel|mark|asaf|moshe|avri|onyx|echo|#male|x-m|hebm/.test(name)) return 5;
  if (/female|woman|girl|carmit|tamar|#female/.test(name)) return -8;
  return 0;
}

function cacheVoices(list: Speech.Voice[]) {
  allVoices = list;
}

function voiceFor(listenLang: string, gender: VoiceGender = "male") {
  const loc = locale(listenLang).toLowerCase();
  const lang = listenLang.toLowerCase();
  const inLang = allVoices.filter((voice) => {
    const code = (voice.language || "").toLowerCase();
    return code === loc || code.startsWith(`${lang}-`) || code === lang;
  });
  const pool = inLang.length ? inLang : allVoices;
  if (!pool.length) return undefined;
  const ranked = [...pool].sort((a, b) => genderScore(b, gender) - genderScore(a, gender));
  const best = ranked[0];
  if (!best) return undefined;
  if (genderScore(best, gender) >= 1) return best.identifier;
  if (gender === "male") {
    const notFemale = ranked.find((voice) => genderScore(voice, "female") < 1);
    if (notFemale) return notFemale.identifier;
  }
  if (genderScore(best, gender) >= 0) return best.identifier;
  return undefined;
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
  await Promise.race([voicesLoaded, new Promise((resolve) => setTimeout(resolve, 400))]);
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
  const pitch = gender === "child" ? 1.35 : gender === "female" ? 1.08 : 0.68;
  const language = locale(listenLang);
  const voice = voiceFor(listenLang, gender);

  const utter = (useVoice: boolean) =>
    new Promise<boolean>((resolve) => {
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
        ...(useVoice && voice ? { voice } : {}),
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

  return utter(true);
}

export async function stopRobot() {
  try {
    await Speech.stop();
  } catch {
    /* ignore */
  }
}
