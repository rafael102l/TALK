import { HistoryItem } from "@talk/shared";
import { api } from "./api";

let cache: HistoryItem[] = [];
let fetchedAt = 0;
let inflight: Promise<HistoryItem[]> | null = null;

export function clearHistoryCache() {
  cache = [];
  fetchedAt = 0;
  inflight = null;
}

export function peekHistoryCache() {
  return cache;
}

export function historyCacheAgeMs() {
  return fetchedAt ? Date.now() - fetchedAt : Number.POSITIVE_INFINITY;
}

export function isHistoryFresh(maxAgeMs = 30_000) {
  return cache.length > 0 && historyCacheAgeMs() < maxAgeMs;
}

export function seedHistoryCache(items: HistoryItem[]) {
  cache = items;
  fetchedAt = Date.now();
}

export function historyForPeer(peerId: string) {
  return cache.filter((item) => (item.peerId || (!item.mine && item.senderId)) === peerId);
}

export async function refreshHistory(token: string, opts?: { maxAgeMs?: number }) {
  const maxAge = opts?.maxAgeMs ?? 0;
  if (maxAge > 0 && isHistoryFresh(maxAge)) {
    return cache;
  }
  if (inflight) return inflight;
  inflight = api<HistoryItem[]>("/transmissions", { token, timeoutMs: 8000 })
    .then((items) => {
      cache = Array.isArray(items) ? items : [];
      fetchedAt = Date.now();
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Warm cache from home so Messages opens instantly. */
export function prefetchHistory(token: string) {
  void refreshHistory(token, { maxAgeMs: 20_000 }).catch(() => undefined);
}
