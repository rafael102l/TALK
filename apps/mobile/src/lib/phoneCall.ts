import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const native = NativeModules.TalkCallState as
  | {
      isInCall: (cb?: (err: Error | null, value: boolean) => void) => Promise<boolean>;
      preparePlayback?: () => Promise<boolean>;
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
