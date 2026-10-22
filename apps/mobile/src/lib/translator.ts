import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import * as FileSystem from "expo-file-system";
import { api } from "./api";
import { setExtraMicBusy, setPlaybackMode } from "./audio";

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
): Promise<TranslatorTurn> {
  const form = new FormData();
  form.append("audio", { uri, name: "speech.m4a", type: "audio/m4a" } as unknown as Blob);
  form.append("langA", langA);
  form.append("langB", langB);
  form.append("gender", gender);
  try {
    const turn = await api<TranslatorTurn>("/ai/translator", {
      method: "POST",
      token,
      once: true,
      timeoutMs: 20_000,
      body: form,
    });
    onText?.(turn);
    if (turn?.audioBase64) void playTranslatorMp3(turn.audioBase64);
    return turn;
  } finally {
    void deleteLocalFile(uri);
  }
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
