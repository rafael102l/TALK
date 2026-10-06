import { TransmissionReadyPayload } from "@talk/shared";
import * as SecureStore from "expo-secure-store";

const KEY = "talk.pendingVoice";
let queue: TransmissionReadyPayload[] = [];
let loaded = false;

async function persist() {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(queue.slice(-20)));
  } catch {
    /* ignore */
  }
}

export async function loadPendingVoice() {
  if (loaded) return queue;
  loaded = true;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw) queue = JSON.parse(raw) as TransmissionReadyPayload[];
  } catch {
    queue = [];
  }
  return queue;
}

export async function enqueueVoice(payload: TransmissionReadyPayload) {
  await loadPendingVoice();
  if (queue.some((item) => item.transmissionId === payload.transmissionId)) return;
  queue = [...queue, payload].slice(-20);
  await persist();
}

export async function takePendingVoice() {
  await loadPendingVoice();
  const items = [...queue];
  queue = [];
  await persist();
  return items;
}

export function pendingVoiceCount() {
  return queue.length;
}
