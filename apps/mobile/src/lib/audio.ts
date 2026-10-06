import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import { prepareNativePlayback } from "./phoneCall";

let recording: Audio.Recording | null = null;
let player: Audio.Sound | null = null;
let peakDb = -160;
let micLock: Promise<void> = Promise.resolve();

function withMic<T>(task: () => Promise<T>): Promise<T> {
  const run = micLock.then(task, task);
  micLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const RECORD_OPTS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: ".m4a",
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 96000,
  },
  ios: {
    extension: ".m4a",
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 96000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/webm",
    bitsPerSecond: 48000,
  },
};

/** True while a local PTT/voice recording object is live. */
export function isMicRecording() {
  return Boolean(recording);
}

export async function ensureAudioMode(forRecording = false) {
  // Never steal the mic for playback while this device is still recording.
  // Devices are independent — remote talk must not end local capture.
  if (!forRecording && recording) return;
  // Xiaomi/MIUI often keeps the mic focus after PTT and then playback is silent
  // or stuck on the earpiece — force speaker + release recording focus every time.
  if (!forRecording) {
    await prepareNativePlayback();
  }
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: forRecording,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    interruptionModeIOS: forRecording ? InterruptionModeIOS.DoNotMix : InterruptionModeIOS.DuckOthers,
    interruptionModeAndroid: forRecording
      ? InterruptionModeAndroid.DoNotMix
      : InterruptionModeAndroid.DuckOthers,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
}

export async function setPlaybackMode() {
  await ensureAudioMode(false);
}

export async function setLoudSpeaker(on: boolean) {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    interruptionModeIOS: InterruptionModeIOS.DuckOthers,
    interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: !on,
  });
}

let micPermission: boolean | null = null;

export async function startRecording() {
  if (micPermission !== true) {
    const permission = await Audio.requestPermissionsAsync();
    micPermission = permission.granted;
    if (!permission.granted) {
      throw new Error("אין הרשאה למיקרופון. אשרו מיקרופון בהגדרות הטלפון.");
    }
  }
  return withMic(async () => {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    peakDb = -160;
    if (recording) {
      try {
        await recording.stopAndUnloadAsync();
      } catch {
        /* ignore */
      }
      recording = null;
    }
    const rec = new Audio.Recording();
    rec.setOnRecordingStatusUpdate((status) => {
      if (typeof status.metering === "number" && status.metering > peakDb) peakDb = status.metering;
    });
    await rec.prepareToRecordAsync(RECORD_OPTS);
    await rec.startAsync();
    recording = rec;
    return rec;
  });
}

export async function pauseRecording() {
  if (!recording) return;
  const status = await recording.getStatusAsync();
  if (status.canRecord && !status.isRecording) return;
  await recording.pauseAsync();
}

export async function resumeRecording() {
  if (!recording) return;
  await recording.startAsync();
}

export async function getRecordingMeter() {
  if (!recording) return { db: -160, durationMs: 0, recording: false };
  const status = await recording.getStatusAsync();
  if (typeof status.metering === "number" && status.metering > peakDb) peakDb = status.metering;
  return {
    db: typeof status.metering === "number" ? status.metering : -160,
    durationMs: status.durationMillis ?? 0,
    recording: Boolean(status.isRecording),
  };
}

export function stopRecording(): Promise<{ uri: string; durationMs: number; peakDb: number } | null> {
  return withMic(async () => {
    if (!recording) return null;
    const rec = recording;
    recording = null;
    let durationMs = 0;
    let uri: string | null = null;
    try {
      const before = await rec.getStatusAsync().catch(() => null);
      durationMs = before?.durationMillis ?? 0;
      uri = rec.getURI();
      await rec.stopAndUnloadAsync();
    } catch {
      /* already stopped — still try URI */
    }
    try {
      uri = uri || rec.getURI();
    } catch {
      /* ignore */
    }
    // Do not await speaker restore here — it blocked "מקליט" forever on some phones.
    void ensureAudioMode(false);
    if (!uri) return null;
    return { uri, durationMs, peakDb };
  });
}

export async function cancelRecording() {
  if (!recording) return;
  const rec = recording;
  recording = null;
  try {
    await rec.stopAndUnloadAsync();
  } catch {
    /* ignore */
  }
  await ensureAudioMode(false);
}

export async function stopPlayer() {
  if (!player) return;
  const sound = player;
  player = null;
  try {
    await sound.stopAsync();
  } catch {
    /* ignore */
  }
  try {
    await sound.unloadAsync();
  } catch {
    /* ignore */
  }
}

export async function stopPlayback() {
  await stopPlayer();
}

export async function playUri(uri: string) {
  if (recording) throw new Error("recording");
  const { anchorMedia } = await import("./api");
  uri = anchorMedia(uri);
  await ensureAudioMode(false);
  await stopPlayer();
  const { sound } = await Audio.Sound.createAsync(
    { uri },
    { shouldPlay: false, volume: 1, progressUpdateIntervalMillis: 200 },
  );
  player = sound;
  await sound.setVolumeAsync(1);
  await sound.playAsync();
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) return;
      if (status.didJustFinish) {
        finish();
        return;
      }
      // Some Android devices never fire didJustFinish — end when near duration.
      const duration = status.durationMillis ?? 0;
      const position = status.positionMillis ?? 0;
      if (duration > 400 && position >= duration - 60 && !status.isPlaying) {
        finish();
      }
    });
    setTimeout(finish, 90000);
  });
  await stopPlayer();
}

export async function playUrl(
  uri: string,
  onTick?: (positionMs: number, durationMs: number, playing: boolean) => void,
) {
  await ensureAudioMode(false);
  await stopPlayer();
  const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
  player = sound;
  sound.setOnPlaybackStatusUpdate((status) => {
    if (!status.isLoaded) return;
    onTick?.(status.positionMillis, status.durationMillis ?? 0, status.isPlaying);
    if (status.didJustFinish) {
      onTick?.(status.durationMillis ?? 0, status.durationMillis ?? 0, false);
    }
  });
  return sound;
}

export async function pausePlayer() {
  if (!player) return;
  await player.pauseAsync();
}

export async function resumePlayer() {
  if (!player) return;
  await player.playAsync();
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
