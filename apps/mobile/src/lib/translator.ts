import { apiLangCode, type VoiceGender } from "@talk/shared";
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import * as FileSystem from "expo-file-system";
import { api } from "./api";
import { setExtraMicBusy, setPlaybackMode } from "./audio";
import { speakRobot, transcribeOnDevice } from "./onDeviceAi";

const CAPTURE_OPTS: Audio.RecordingOptions = {
  isMeteringEnabled: false,
  android: {
    extension: ".m4a",
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
  },
  ios: {
    extension: ".m4a",
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/webm",
    bitsPerSecond: 64000,
  },
};

let capture: Audio.Recording | null = null;
let clip: Audio.Sound | null = null;
let lastCaptureUri = "";
let stopJob: Promise<string> | null = null;
let skipTail: (() => void) | null = null;
const TAIL_MS = 400;
const cacheDir =
  (typeof FileSystem.cacheDirectory === "string" && FileSystem.cacheDirectory) ||
  (typeof FileSystem.documentDirectory === "string" && FileSystem.documentDirectory) ||
  "";
const CLIP_PATH = cacheDir ? `${cacheDir}translation.mp3` : "";
const BASE64 = FileSystem.EncodingType?.Base64 ?? "base64";

export type TranslatorTurn = {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  audioBase64: string;
  mime: string;
  /** STT done; translation may still be in flight. */
  partial?: boolean;
};

export async function startTranslatorCapture() {
  await resetTranslatorCapture();
  setExtraMicBusy?.(true);
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(CAPTURE_OPTS);
    await rec.startAsync();
    capture = rec;
  } catch (error) {
    setExtraMicBusy?.(false);
    capture = null;
    throw error;
  }
}

export async function stopTranslatorCapture(opts?: { tail?: boolean }): Promise<string> {
  if (stopJob) {
    if (!opts?.tail) skipTail?.();
    return stopJob;
  }
  const rec = capture;
  if (!rec) return "";
  stopJob = (async () => {
    if (opts?.tail) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (skipTail === skip) skipTail = null;
          resolve();
        }, TAIL_MS);
        const skip = () => {
          clearTimeout(timer);
          skipTail = null;
          resolve();
        };
        skipTail = skip;
      });
    } else {
      skipTail?.();
    }
    if (capture !== rec) return "";
    capture = null;
    setExtraMicBusy?.(false);
    try {
      await rec.stopAndUnloadAsync?.();
    } catch {
      /* already stopped */
    }
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        playThroughEarpieceAndroid: false,
        interruptionModeIOS: InterruptionModeIOS.DuckOthers,
        interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
        shouldDuckAndroid: true,
      });
    } catch {
      /* Xiaomi still tries playback from file */
    }
    const uri = rec.getURI?.() || "";
    lastCaptureUri = uri;
    return uri;
  })().finally(() => {
    stopJob = null;
    skipTail = null;
  });
  return stopJob;
}

export async function resetTranslatorCapture() {
  await stopTranslatorAudio?.();
  const uri = await stopTranslatorCapture();
  if (uri) await deleteLocalFile(uri);
  if (lastCaptureUri && lastCaptureUri !== uri) await deleteLocalFile(lastCaptureUri);
  lastCaptureUri = "";
  if (CLIP_PATH) await deleteLocalFile(CLIP_PATH);
  capture = null;
}

export async function runTranslatorTurn(
  uri: string,
  langA: string,
  langB: string,
  gender: string,
  token: string | null,
  onText?: (turn: TranslatorTurn) => void,
  opts?: { play?: boolean },
): Promise<TranslatorTurn> {
  const from = apiLangCode(langA, "he");
  const to = apiLangCode(langB, "en");
  let heard = "";
  try {
    heard = (await transcribeOnDevice(uri, from))?.trim() || "";
  } catch {
    heard = "";
  }
  if (heard) {
    onText?.({
      sourceText: heard,
      translatedText: "",
      sourceLang: from,
      targetLang: to,
      audioBase64: "",
      mime: "audio/mpeg",
      partial: true,
    });
  }
  const form = new FormData();
  if (heard) {
    form.append("text", heard);
  } else {
    form.append("audio", { uri, name: "speech.m4a", type: "audio/m4a" } as unknown as Blob);
  }
  form.append("langA", from);
  form.append("langB", to);
  form.append("gender", gender);
  try {
    const turn = await api<TranslatorTurn>("/ai/translator", {
      method: "POST",
      token,
      once: true,
      timeoutMs: 20_000,
      body: form,
    });
    const sourceText = (turn?.sourceText || heard || "").trim();
    const translatedText = (turn?.translatedText || "").trim();
    const full: TranslatorTurn = {
      sourceText,
      translatedText,
      sourceLang: apiLangCode(turn?.sourceLang || from, from),
      targetLang: apiLangCode(turn?.targetLang || to, to),
      audioBase64: turn?.audioBase64 || "",
      mime: turn?.mime || "audio/mpeg",
    };
    onText?.(full);
    if (opts?.play !== false && translatedText) {
      const genderVoice = (gender === "female" || gender === "child" ? gender : "male") as VoiceGender;
      const serverTarget = apiLangCode(full.targetLang, to);
      if (full.audioBase64 && serverTarget === to) void playTranslatorMp3(full.audioBase64);
      else void speakRobot(translatedText, to, genderVoice);
    }
    return full;
  } finally {
    void deleteLocalFile(uri);
  }
}

/** Hear a short utterance (language name) without playing a translation. */
export async function hearTranslatorText(uri: string, listenLang: string, token: string | null): Promise<string> {
  try {
    const local = await transcribeOnDevice(uri, listenLang);
    if (local?.trim()) {
      void deleteLocalFile(uri);
      return local.trim();
    }
  } catch {
    /* cloud fallback */
  }
  const hear = apiLangCode(listenLang, "he");
  const other = hear === "en" ? "he" : "en";
  const turn = await runTranslatorTurn(uri, hear, other, "male", token, undefined, { play: false });
  return (turn?.sourceText || "").trim();
}

export async function playTranslatorMp3(base64: string) {
  if (!base64 || !CLIP_PATH || typeof FileSystem.writeAsStringAsync !== "function") return;
  await stopTranslatorAudio?.();
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      playThroughEarpieceAndroid: false,
      interruptionModeIOS: InterruptionModeIOS.DuckOthers,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      shouldDuckAndroid: true,
    });
  } catch {
    /* file playback still tried */
  }
  try {
    await setPlaybackMode?.();
  } catch {
    /* Xiaomi speaker still tries from file */
  }
  try {
    await FileSystem.writeAsStringAsync(CLIP_PATH, base64, { encoding: BASE64 });
    const { sound } = await Audio.Sound.createAsync({ uri: CLIP_PATH }, { shouldPlay: false, volume: 1 });
    clip = sound;
    sound.setOnPlaybackStatusUpdate?.((status) => {
      if (!status.isLoaded || !status.didJustFinish) return;
      void sound.unloadAsync?.().catch(() => undefined);
      if (clip === sound) clip = null;
    });
    await sound.playAsync();
  } catch {
    await stopTranslatorAudio?.();
  }
}

export async function stopTranslatorAudio() {
  const current = clip;
  clip = null;
  if (!current) return;
  try {
    await current.stopAsync?.();
  } catch {
    /* already stopped */
  }
  try {
    await current.unloadAsync?.();
  } catch {
    /* already unloaded */
  }
}

async function deleteLocalFile(uri: string) {
  if (!uri || typeof FileSystem.deleteAsync !== "function") return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    /* temp clip already gone */
  }
}
