import * as SecureStore from "expo-secure-store";

const KEY = "talk.recent-searches";
const MAX = 12;

export type RecentSearch = {
  userId: string;
  displayName: string;
  phoneE164: string;
  avatarUrl?: string | null;
  at: number;
};

export async function loadRecents(): Promise<RecentSearch[]> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RecentSearch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function pushRecent(item: Omit<RecentSearch, "at">) {
  const current = await loadRecents();
  const next = [
    { ...item, at: Date.now() },
    ...current.filter((row) => row.userId !== item.userId),
  ].slice(0, MAX);
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  return next;
}

export async function clearRecents() {
  await SecureStore.deleteItemAsync(KEY);
}
