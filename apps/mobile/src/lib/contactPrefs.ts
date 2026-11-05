import * as SecureStore from "expo-secure-store";

const MUTE_PREFIX = "talk.mute.";
const MUTE_UNTIL_PREFIX = "talk.muteUntil.";
const VISIBLE_PREFIX = "talk.mediaVisible.";
const BLOCKED_KEY = "talk.blockedIds";
const DISAPPEAR_PREFIX = "talk.disappear.";
const DISAPPEAR_DEFAULT = "talk.disappear.default";
const PINNED_KEY = "talk.pinnedPeers";

export const MUTE_ALWAYS = -1;
export const MAX_PINNED = 3;

async function readSet(key: string) {
  try {
    const raw = await SecureStore.getItemAsync(key);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(list) ? list.filter(Boolean) : []);
  } catch {
    return new Set<string>();
  }
}

async function writeSet(key: string, ids: Set<string>) {
  await SecureStore.setItemAsync(key, JSON.stringify([...ids]));
}

export async function getMuteUntil(userId: string) {
  if (!userId) return 0;
  const raw = await SecureStore.getItemAsync(`${MUTE_UNTIL_PREFIX}${userId}`);
  if (raw === "always") return MUTE_ALWAYS;
  const until = raw ? Number(raw) : 0;
  if (until === MUTE_ALWAYS) return MUTE_ALWAYS;
  if (until > Date.now()) return until;
  const legacy = await SecureStore.getItemAsync(`${MUTE_PREFIX}${userId}`);
  return legacy === "1" ? MUTE_ALWAYS : 0;
}

export async function isPeerMuted(userId: string) {
  const until = await getMuteUntil(userId);
  return until === MUTE_ALWAYS || until > Date.now();
}

export async function setPeerMuted(userId: string, muted: boolean) {
  if (!userId) return;
  await setPeerMuteUntil(userId, muted ? MUTE_ALWAYS : 0);
}

export async function setPeerMuteUntil(userId: string, until: number) {
  if (!userId) return;
  const value = until === MUTE_ALWAYS ? "always" : until > Date.now() ? String(until) : "";
  await SecureStore.setItemAsync(`${MUTE_UNTIL_PREFIX}${userId}`, value);
  await SecureStore.setItemAsync(`${MUTE_PREFIX}${userId}`, until === MUTE_ALWAYS || until > Date.now() ? "1" : "0");
}

export async function isMediaVisible(userId: string) {
  if (!userId) return true;
  const value = await SecureStore.getItemAsync(`${VISIBLE_PREFIX}${userId}`);
  return value !== "0";
}

export async function setMediaVisible(userId: string, visible: boolean) {
  if (!userId) return;
  await SecureStore.setItemAsync(`${VISIBLE_PREFIX}${userId}`, visible ? "1" : "0");
}

export async function isPeerBlockedLocal(userId: string) {
  if (!userId) return false;
  const ids = await readSet(BLOCKED_KEY);
  return ids.has(userId);
}

export async function setPeerBlockedLocal(userId: string, blocked: boolean) {
  if (!userId) return;
  const ids = await readSet(BLOCKED_KEY);
  if (blocked) ids.add(userId);
  else ids.delete(userId);
  await writeSet(BLOCKED_KEY, ids);
}

export async function getDisappearAfterSec(id: string) {
  if (!id) return 0;
  const raw = await SecureStore.getItemAsync(`${DISAPPEAR_PREFIX}${id}`);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function setDisappearAfterSec(id: string, seconds: number) {
  if (!id) return;
  await SecureStore.setItemAsync(`${DISAPPEAR_PREFIX}${id}`, String(Math.max(0, seconds)));
}

export async function getDefaultDisappearSec() {
  const raw = await SecureStore.getItemAsync(DISAPPEAR_DEFAULT);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function setDefaultDisappearSec(seconds: number) {
  await SecureStore.setItemAsync(DISAPPEAR_DEFAULT, String(Math.max(0, seconds)));
}

// Pinned chats: ordered list (most-recently pinned first), capped at MAX_PINNED.
export async function getPinnedPeers(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(PINNED_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? [...new Set(list.filter(Boolean))].slice(0, MAX_PINNED) : [];
  } catch {
    return [];
  }
}

export async function setPinnedPeers(ids: string[]): Promise<string[]> {
  const trimmed = [...new Set(ids.filter(Boolean))].slice(0, MAX_PINNED);
  await SecureStore.setItemAsync(PINNED_KEY, JSON.stringify(trimmed));
  return trimmed;
}

// Toggle one chat's pin. Returns the new list and `limited: true` when a pin was
// rejected because MAX_PINNED is already reached (so the UI can warn the user).
export async function togglePinnedPeer(
  userId: string,
): Promise<{ pinned: string[]; limited: boolean }> {
  const current = await getPinnedPeers();
  if (!userId) return { pinned: current, limited: false };
  if (current.includes(userId)) {
    return { pinned: await setPinnedPeers(current.filter((id) => id !== userId)), limited: false };
  }
  if (current.length >= MAX_PINNED) return { pinned: current, limited: true };
  return { pinned: await setPinnedPeers([userId, ...current]), limited: false };
}
