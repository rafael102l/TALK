import { HistoryItem, MessageReceipt } from "@talk/shared";
import * as FileSystem from "expo-file-system";
import { api } from "./api";

const HISTORY_FILE = `${FileSystem.documentDirectory || ""}talk-history.json`;
let diskReady = false;
let cacheUserId = "";

let cache: HistoryItem[] = [];
let fetchedAt = 0;
let inflight: Promise<HistoryItem[]> | null = null;
const pendingReceipts = new Map<string, MessageReceipt>();
const receiptListeners = new Set<(transmissionId: string, receipt: MessageReceipt) => void>();

function txIdOf(id: string) {
  return typeof id === "string" && id ? id.split(":")[0] : "";
}

function receiptRank(receipt?: string | null) {
  if (receipt === "read") return 3;
  if (receipt === "delivered") return 2;
  if (receipt === "sent") return 1;
  return 0;
}

export function mergeReceipt(a?: MessageReceipt | null, b?: MessageReceipt | null): MessageReceipt | undefined {
  if (!a) return b || undefined;
  if (!b) return a;
  return receiptRank(a) >= receiptRank(b) ? a : b;
}

export function onChatReceipt(listener: (transmissionId: string, receipt: MessageReceipt) => void) {
  receiptListeners.add(listener);
  return () => receiptListeners.delete(listener);
}

export function applyReceipt(transmissionId: string, receipt: MessageReceipt, peerId?: string) {
  if (!transmissionId || !receipt) return;
  pendingReceipts.set(transmissionId, mergeReceipt(pendingReceipts.get(transmissionId), receipt) || receipt);
  let changed = false;
  cache = cache.map((item) => {
    if (!item.mine) return item;
    const sameTx = txIdOf(item.id) === transmissionId;
    const sameLocal = Boolean(peerId && typeof item.id === "string" && item.id.startsWith("local-") && item.peerId === peerId);
    if (!sameTx && !sameLocal) return item;
    const next = mergeReceipt(item.receipt, receipt);
    if (next === item.receipt) return item;
    changed = true;
    return { ...item, receipt: next };
  });
  if (changed) {
    fetchedAt = Date.now();
    persistHistory();
  }
  for (const listener of receiptListeners) {
    try {
      listener(transmissionId, receipt);
    } catch {
      /* a broken subscriber must never break receipt delivery */
    }
  }
}

export function takePendingReceipt(transmissionId: string) {
  const receipt = pendingReceipts.get(transmissionId);
  pendingReceipts.delete(transmissionId);
  return receipt;
}

function withKeptReceipts(incoming: HistoryItem[], current: HistoryItem[]) {
  const safeIncoming = Array.isArray(incoming) ? incoming : [];
  const safeCurrent = Array.isArray(current) ? current : [];
  const valid = (item: HistoryItem | null | undefined): item is HistoryItem => Boolean(item && item.id != null);
  const prev = new Map(safeCurrent.filter(valid).map((item) => [item.id, item]));
  const byTx = new Map(
    safeCurrent.filter((item) => valid(item) && item.mine).map((item) => [txIdOf(item.id), item] as const),
  );
  const out: HistoryItem[] = [];
  for (const item of safeIncoming) {
    if (!valid(item)) continue;
    try {
      const old = prev.get(item.id) || (item.mine ? byTx.get(txIdOf(item.id)) : undefined);
      const pending = pendingReceipts.get(txIdOf(item.id));
      out.push({ ...item, receipt: mergeReceipt(mergeReceipt(old?.receipt, item.receipt), pending) });
    } catch {
      // Keep the raw row rather than dropping the whole list on one bad item.
      out.push(item);
    }
  }
  return out;
}

export function clearHistoryCache() {
  cache = [];
  fetchedAt = 0;
  inflight = null;
  pendingReceipts.clear();
  persistHistory();
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
  try {
    cache = withKeptReceipts(Array.isArray(items) ? items : [], cache);
  } catch {
    if (!Array.isArray(cache)) cache = [];
  }
  fetchedAt = Date.now();
  persistHistory();
}

function persistHistory() {
  if (!FileSystem.documentDirectory || typeof FileSystem.writeAsStringAsync !== "function") return;
  let payload: string;
  try {
    const rows = Array.isArray(cache) ? cache.slice(0, 150) : [];
    payload = JSON.stringify({ userId: cacheUserId, items: rows });
  } catch {
    return;
  }
  void FileSystem.writeAsStringAsync(HISTORY_FILE, payload).catch(() => undefined);
}

/** Last chats stay on the phone so Messages does not go empty while Render wakes. */
export async function hydrateHistoryCache(userId?: string) {
  if (diskReady) {
    if (userId && cacheUserId && userId !== cacheUserId) {
      cache = [];
      fetchedAt = 0;
      cacheUserId = userId;
      persistHistory();
    } else if (userId) {
      cacheUserId = userId;
    }
    return cache;
  }
  diskReady = true;
  if (!FileSystem.documentDirectory || typeof FileSystem.readAsStringAsync !== "function") return cache;
  try {
    const raw = await FileSystem.readAsStringAsync(HISTORY_FILE);
    const parsed = JSON.parse(raw) as HistoryItem[] | { userId?: string; items?: HistoryItem[] };
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
    const owner = Array.isArray(parsed) ? "" : parsed.userId || "";
    if (userId && owner && owner !== userId) {
      cache = [];
      fetchedAt = 0;
      cacheUserId = userId;
      return cache;
    }
    if (owner) cacheUserId = owner;
    if (rows.length) {
      cache = withKeptReceipts(rows, cache);
      if (!fetchedAt) fetchedAt = 1;
    }
  } catch {
    /* first launch, or a corrupt/empty cache file: fall back to empty cache */
  }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

export function historyForPeer(peerId: string) {
  return cache.filter((item) => (item.peerId || (!item.mine && item.senderId)) === peerId);
}

export function clearPeerHistory(peerId: string) {
  cache = cache.filter((item) => (item.peerId || (!item.mine && item.senderId)) !== peerId);
  fetchedAt = Date.now();
  persistHistory();
  return cache;
}

export async function refreshHistory(token: string, opts?: { maxAgeMs?: number }) {
  const maxAge = opts?.maxAgeMs ?? 0;
  if (maxAge > 0 && isHistoryFresh(maxAge)) {
    return cache;
  }
  if (inflight) return inflight;
  inflight = api<HistoryItem[]>("/transmissions", { token, timeoutMs: 45000 })
    .then((items) => {
      const incoming = Array.isArray(items) ? items : [];
      const merged: HistoryItem[] = withKeptReceipts(incoming, cache);
      const seen = new Set(merged.map((item) => item.id));
      for (const item of cache) {
        if (item && typeof item.id === "string" && item.id.startsWith("local-") && !seen.has(item.id)) merged.push(item);
      }
      cache = merged;
      fetchedAt = Date.now();
      persistHistory();
      return cache;
    })
    .catch((error) => {
      if (cache.length) return cache;
      throw error;
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
