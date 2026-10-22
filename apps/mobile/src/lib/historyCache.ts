import { HistoryItem, MessageReceipt } from "@talk/shared";
import { api } from "./api";

let cache: HistoryItem[] = [];
let fetchedAt = 0;
let inflight: Promise<HistoryItem[]> | null = null;
const pendingReceipts = new Map<string, MessageReceipt>();
const receiptListeners = new Set<(transmissionId: string, receipt: MessageReceipt) => void>();

function txIdOf(id: string) {
  return id.split(":")[0];
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
    const sameLocal = Boolean(peerId && item.id.startsWith("local-") && item.peerId === peerId);
    if (!sameTx && !sameLocal) return item;
    const next = mergeReceipt(item.receipt, receipt);
    if (next === item.receipt) return item;
    changed = true;
    return { ...item, receipt: next };
  });
  if (changed) fetchedAt = Date.now();
  for (const listener of receiptListeners) listener(transmissionId, receipt);
}

export function takePendingReceipt(transmissionId: string) {
  const receipt = pendingReceipts.get(transmissionId);
  pendingReceipts.delete(transmissionId);
  return receipt;
}

function withKeptReceipts(incoming: HistoryItem[], current: HistoryItem[]) {
  const prev = new Map(current.map((item) => [item.id, item]));
  const byTx = new Map(
    current.filter((item) => item.mine).map((item) => [txIdOf(item.id), item] as const),
  );
  return incoming.map((item) => {
    const old = prev.get(item.id) || (item.mine ? byTx.get(txIdOf(item.id)) : undefined);
    const pending = pendingReceipts.get(txIdOf(item.id));
    return {
      ...item,
      receipt: mergeReceipt(mergeReceipt(old?.receipt, item.receipt), pending),
    };
  });
}

export function clearHistoryCache() {
  cache = [];
  fetchedAt = 0;
  inflight = null;
  pendingReceipts.clear();
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
  cache = withKeptReceipts(items, cache);
  fetchedAt = Date.now();
}

export function historyForPeer(peerId: string) {
  return cache.filter((item) => (item.peerId || (!item.mine && item.senderId)) === peerId);
}

export function clearPeerHistory(peerId: string) {
  cache = cache.filter((item) => (item.peerId || (!item.mine && item.senderId)) !== peerId);
  fetchedAt = Date.now();
  return cache;
}

export async function refreshHistory(token: string, opts?: { maxAgeMs?: number }) {
  const maxAge = opts?.maxAgeMs ?? 0;
  if (maxAge > 0 && isHistoryFresh(maxAge)) {
    return cache;
  }
  if (inflight) return inflight;
  inflight = api<HistoryItem[]>("/transmissions", { token, timeoutMs: 8000 })
    .then((items) => {
      const incoming = Array.isArray(items) ? items : [];
      const merged = withKeptReceipts(incoming, cache);
      const seen = new Set(merged.map((item) => item.id));
      for (const item of cache) {
        if (item.id.startsWith("local-") && !seen.has(item.id)) merged.push(item);
      }
      cache = merged;
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
