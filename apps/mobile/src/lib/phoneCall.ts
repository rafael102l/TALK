import { requireNativeModule } from "expo-modules-core";
import * as SecureStore from "expo-secure-store";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const native = NativeModules.TalkCallState as
  | {
      isInCall: (cb?: (err: Error | null, value: boolean) => void) => Promise<boolean>;
      preparePlayback?: () => Promise<boolean>;
      releasePlayback?: () => Promise<boolean>;
    }
  | undefined;

export async function isInPhoneCall(): Promise<boolean> {
  if (Platform.OS !== "android" || !native?.isInCall) return false;
  try {
    return Boolean(await native.isInCall());
  } catch {
    return false;
  }
}

type TalkPcm = {
  startPhoneRing?: () => boolean;
  stopPhoneRing?: () => boolean;
  startRingback?: () => boolean;
  stopRingback?: () => boolean;
  setCallRoute?: (speaker: boolean, preferBluetooth?: boolean) => boolean;
  routeSpeaker?: () => boolean;
  releaseAudioRoute?: () => boolean;
  setSecureScreen?: (on: boolean) => boolean;
  refreshTts?: () => boolean;
  openTtsInstall?: () => boolean;
  warmTts?: () => Promise<void>;
  speakMedia?: (text: string, locale: string, voiceName: string, gender: string) => Promise<string>;
  requestBatteryExemption?: () => boolean;
  showIncomingCall?: (callId: string, name: string, phone: string, video: boolean, avatar: string) => boolean;
  hideIncomingCall?: () => boolean;
  bringCallToFront?: () => boolean;
  addListener?: (event: "onCallAction", listener: (event: { action?: string; callId?: string }) => void) => { remove(): void };
  consumeCallActions?: () => { action?: string; callId?: string }[];
  needsXiaomiOverlay?: () => boolean;
  requestOverlayPermission?: () => boolean;
  startCallAlive?: () => boolean;
  stopCallAlive?: () => boolean;
};

let talkPcmCache: TalkPcm | null | undefined;

function talkPcm(): TalkPcm | null {
  if (talkPcmCache !== undefined) return talkPcmCache;
  if (Platform.OS !== "android") {
    talkPcmCache = null;
    return null;
  }
  try {
    const mod = requireNativeModule<TalkPcm>("TalkPcm");
    talkPcmCache = mod && typeof mod === "object" ? mod : null;
  } catch {
    talkPcmCache = null;
  }
  return talkPcmCache;
}

function pcmCall(name: keyof TalkPcm, ...args: unknown[]) {
  const pcm = talkPcm();
  const fn = pcm?.[name];
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as (...values: unknown[]) => unknown).apply(pcm, args);
  } catch (error) {
    console.log(`[call] pcm ${String(name)} ${(error as Error).message}`);
    return undefined;
  }
}

/** Forget the cached engine so a voice installed a moment ago is used on the next caption. */
export function refreshOnDeviceTts() {
  pcmCall("refreshTts");
}

/** Open the system screen where the user installs a missing TTS voice. */
export function openTtsInstall() {
  pcmCall("openTtsInstall");
}

/** Open Android TTS at launch so the first caption does not wait for a cold engine. */
export function warmOnDeviceTts() {
  const result = pcmCall("warmTts");
  if (result && typeof (result as Promise<void>).then === "function") {
    void (result as Promise<void>).catch(() => undefined);
  }
}

/** Device TTS on STREAM_MUSIC through the loudspeaker. */
export async function speakOnMedia(text: string, localeTag: string, voiceName = "", gender = "male"): Promise<string> {
  const pcm = talkPcm();
  if (typeof pcm?.speakMedia !== "function") return "skip";
  try {
    const result = await pcm.speakMedia(text, localeTag, voiceName, gender);
    console.log(`[live dub] media tts ${result}`);
    return result;
  } catch (error) {
    const message = (error as Error).message || "fail";
    console.log(`[live dub] media tts fail ${message}`);
    return `fail ${message}`;
  }
}

/** Play the phone's own ringtone and vibration pattern. */
export function startDeviceRing() {
  pcmCall("startPhoneRing");
}

export function stopDeviceRing() {
  pcmCall("stopPhoneRing");
}

/** Local ringback for the person who placed the call. Not the incoming ringtone. */
export function startRingback() {
  pcmCall("startRingback");
}

const BATTERY_KEY = "talk.batteryAsked";

/** Once per install: ask Android not to put TALK to sleep. */
export async function askBatteryExemptionOnce() {
  if (Platform.OS !== "android") return;
  try {
    const seen = await SecureStore.getItemAsync(BATTERY_KEY);
    if (seen) return;
    const opened = Boolean(pcmCall("requestBatteryExemption"));
    if (opened) await SecureStore.setItemAsync(BATTERY_KEY, "1");
  } catch (error) {
    console.log(`[call] battery ${(error as Error).message}`);
  }
}

/** Lock-screen call notification. Category is CALL and the intent is full screen. */
export function showIncomingCallScreen(callId: string, name: string, phone: string, video = false, avatar = "") {
  if (!callId) return;
  pcmCall("showIncomingCall", callId, name, phone, Boolean(video), avatar || "");
}

export function hideIncomingCallScreen() {
  pcmCall("hideIncomingCall");
}

/** One-tap answer from the banner opens the in-app call screen. */
export function bringCallToFront() {
  pcmCall("bringCallToFront");
}

export function subscribeCallActions(onAction: (action: string, callId: string) => void) {
  const pcm = talkPcm();
  if (!pcm?.addListener) return () => undefined;
  try {
    const apply = (event: { action?: string; callId?: string }) => {
      if (event?.action && event.callId) onAction(event.action, event.callId);
    };
    const sub = pcm.addListener("onCallAction", apply);
    for (const event of pcm.consumeCallActions?.() ?? []) apply(event);
    return () => sub.remove();
  } catch (error) {
    console.log(`[call] actions ${(error as Error).message}`);
    return () => undefined;
  }
}

let overlayAsked = false;

/** Xiaomi/Redmi: open the pop-up permission screen until it is granted. */
export function askXiaomiOverlayOnce() {
  if (Platform.OS !== "android" || overlayAsked) return;
  try {
    const pcm = talkPcm();
    if (!pcm?.needsXiaomiOverlay?.()) return;
    const opened = Boolean(pcm.requestOverlayPermission?.());
    if (opened) overlayAsked = true;
  } catch (error) {
    console.log(`[call] overlay ${(error as Error).message}`);
  }
}

/** Keep the process awake so the call socket survives the home screen. */
export function startCallAlive() {
  pcmCall("startCallAlive");
}

export function stopCallAlive() {
  pcmCall("stopCallAlive");
}

export function stopRingback() {
  pcmCall("stopRingback");
}

let callAudioHeld = false;
let liveAudioHeld = false;

export function setCallRoute(speaker: boolean, preferBluetooth = false) {
  pcmCall("setCallRoute", speaker, preferBluetooth);
}

export function startCallAudio(preferSpeaker: boolean) {
  callAudioHeld = true;
  pcmCall("setCallRoute", preferSpeaker, true);
}

export function routeToSpeaker() {
  const ok = pcmCall("routeSpeaker");
  if (ok !== undefined) console.log(`[live dub] route speaker ok=${String(ok)}`);
}

/** Voice call owns the phone audio session until hang-up. */
export function holdPhoneAudio(held: boolean) {
  callAudioHeld = held;
}

/** Live PCM speaker — do not reset routing mid-stream while TALK is in front. */
export function holdLiveAudio(held: boolean) {
  liveAudioHeld = held;
}

/** Undo speakerphone / VoIP mode so other apps can use the earpiece. */
export function releasePhoneAudio(opts?: { evenIfLive?: boolean }) {
  if (callAudioHeld) return;
  if (liveAudioHeld && !opts?.evenIfLive) return;
  const ok = pcmCall("releaseAudioRoute");
  if (ok !== undefined) console.log(`[audio] release route ok=${String(ok)}`);
  if (typeof native?.releasePlayback === "function") {
    void native.releasePlayback().catch(() => undefined);
  }
}

export function endCallAudio() {
  callAudioHeld = false;
  releasePhoneAudio({ evenIfLive: true });
}

/** Android FLAG_SECURE — blocks screenshots and screen recording of the current window. */
export function setSecureScreen(on: boolean) {
  if (Platform.OS !== "android") return;
  pcmCall("setSecureScreen", on);
}

/** MIUI keeps MODE_IN_COMMUNICATION after PTT — force speaker before play. */
export async function prepareNativePlayback() {
  if (Platform.OS !== "android" || !native?.preparePlayback) return;
  try {
    await native.preparePlayback();
  } catch {
    /* ignore */
  }
}

export function subscribePhoneCall(onChange: (inCall: boolean) => void) {
  if (Platform.OS !== "android" || !native) return () => undefined;
  const emitter = new NativeEventEmitter(native as never);
  const sub = emitter.addListener("talkCallState", (value) => onChange(Boolean(value)));
  void isInPhoneCall().then(onChange).catch(() => undefined);
  return () => sub.remove();
}
