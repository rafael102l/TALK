import { decodeReply, HistoryItem, MessageReceipt, TransmissionReadyPayload } from "@talk/shared";
import * as FileSystem from "expo-file-system";
import { api } from "./api";
import { isGroupPayload, peekGroups } from "./groups";
import { isStableLocalAudio } from "./localFirst/audioStore";
import {
  isRelayReadEnabled,
  isShadowDbEnabled,
  loadLocalMessages,
  onAudioPinned,
  onOutboxKept,
  onOutboxSent,
  shadowDeleteMessage,
  shadowDeletePeer,
  shadowPersist,
  shadowReset,
  shadowUpsertNow,
} from "./localFirst";

const HISTORY_FILE = `${FileSystem.documentDirectory || ""}talk-history.json`;
let diskReady = false;
let cacheUserId = "";

let cache: HistoryItem[] = [];
let fetchedAt = 0;
let inflight: Promise<HistoryItem[]> | null = null;
const pendingReceipts = new Map<string, MessageReceipt>();
const receiptListeners = new Set<(transmissionId: string, receipt: MessageReceipt) => void>();
const historyListeners = new Set<(items: HistoryItem[]) => void>();

function txIdOf(id: string) {
  return typeof id === "string" && id ? id.split(":")[0] : "";
}

/** Chat-voice transmissions that already received cross-lang TTS — ignore late original retries. */
const dubbedVoiceIds = new Set<string>();

export function markVoiceDubbed(transmissionId?: string | null) {
  const id = String(transmissionId || "").trim();
  if (id) dubbedVoiceIds.add(id);
}

export function isVoiceDubbed(transmissionId?: string | null) {
  const id = String(transmissionId || "").trim();
  return Boolean(id && dubbedVoiceIds.has(id));
}

function itemKindOf(item: HistoryItem) {
  if (item.kind === "text" || item.kind === "voice" || item.kind === "walkie" || item.kind === "image" || item.kind === "video") {
    return item.kind;
  }
  if (item.audioUrl || item.durationMs) return "walkie";
  return "text";
}

function chatBody(item: { originalText?: string | null; translatedText?: string | null }) {
  return (item.originalText || item.translatedText || "").replace(/\s+/g, " ").trim();
}

/** Optimistic local- bubble that the server echo already replaced. */
function isPendingTwin(local: HistoryItem, ready: HistoryItem) {
  if (typeof local?.id !== "string" || !local.id.startsWith("local-")) return false;
  if (typeof ready?.id !== "string" || !ready.id || ready.id.startsWith("local-")) return false;
  if (!local.mine || !ready.mine) return false;
  if ((local.peerId || "") !== (ready.peerId || "")) return false;
  if (itemKindOf(local) !== itemKindOf(ready)) return false;
  const a = chatBody(local);
  const b = chatBody(ready);
  if (a && b && a !== b) return false;
  const t1 = Date.parse(local.createdAt || "") || 0;
  const t2 = Date.parse(ready.createdAt || "") || 0;
  if (t1 && t2 && Math.abs(t1 - t2) > 180_000) return false;
  return true;
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

/** READY echo must not jump to blue ticks. Blue comes only from chat:receipt after the peer reads. */
export function receiptFromEcho(receipt?: MessageReceipt | null): MessageReceipt {
  return receipt === "delivered" || receipt === "read" ? "delivered" : "sent";
}

/** Clock → one gray tick, then keep any delivered/read that already arrived. */
export function receiptAfterSend(current?: MessageReceipt | null, serverId?: string): MessageReceipt {
  return mergeReceipt(mergeReceipt(current, "sent"), serverId ? pendingReceipts.get(serverId) : undefined) || "sent";
}

export function onChatReceipt(listener: (transmissionId: string, receipt: MessageReceipt) => void) {
  receiptListeners.add(listener);
  return () => receiptListeners.delete(listener);
}

export function applyReceipt(transmissionId: string, receipt: MessageReceipt, _peerId?: string) {
  if (!transmissionId || !receipt) return;
  // Status sync only — never creates/resends a message.
  pendingReceipts.set(transmissionId, mergeReceipt(pendingReceipts.get(transmissionId), receipt) || receipt);
  let changed = false;
  cache = cache.map((item) => {
    if (!item.mine) return item;
    const tx = txIdOf(item.id);
    if (tx !== transmissionId && item.id !== transmissionId) return item;
    const next = mergeReceipt(item.receipt, receipt);
    if (next === item.receipt) return item;
    changed = true;
    return { ...item, receipt: next };
  });
  if (changed) {
    fetchedAt = Date.now();
    persistHistory();
    notifyHistory();
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
      out.push({
        ...item,
        senderName: item.senderName || old?.senderName || "",
        peerName: item.peerName || old?.peerName,
        originalText: item.originalText ?? old?.originalText ?? null,
        translatedText: item.translatedText ?? old?.translatedText ?? null,
        audioUrl: preferLocalAudio(old?.audioUrl, item.audioUrl),
        receipt: mergeReceipt(mergeReceipt(old?.receipt, item.receipt), pending),
      });
    } catch {
      // Keep the raw row rather than dropping the whole list on one bad item.
      out.push(item);
    }
  }
  return out;
}

function preferLocalAudio(a?: string | null, b?: string | null) {
  if (a && isStableLocalAudio(a)) return a;
  if (b && isStableLocalAudio(b)) return b;
  return a || b || null;
}

/** SQLite rows win for local files/text; RAM/JSON fills names; receipts never downgrade. */
function mergeLocalRows(local: HistoryItem[], current: HistoryItem[]) {
  const safeLocal = Array.isArray(local) ? local : [];
  const safeCurrent = Array.isArray(current) ? current : [];
  const prev = new Map(safeCurrent.filter((item) => item?.id).map((item) => [item.id, item]));
  const out: HistoryItem[] = [];
  const seen = new Set<string>();
  for (const item of safeLocal) {
    if (!item?.id) continue;
    const old = prev.get(item.id);
    const pending = pendingReceipts.get(txIdOf(item.id));
    out.push({
      ...(old || {}),
      ...item,
      senderName: item.senderName || old?.senderName || "",
      peerName: item.peerName || old?.peerName,
      originalText: item.originalText ?? old?.originalText ?? null,
      translatedText: item.translatedText ?? old?.translatedText ?? null,
      audioUrl: preferLocalAudio(item.audioUrl, old?.audioUrl),
      receipt: mergeReceipt(mergeReceipt(old?.receipt, item.receipt), pending),
    });
    seen.add(item.id);
  }
  for (const item of safeCurrent) {
    if (!item?.id || seen.has(item.id)) continue;
    if (typeof item.id === "string" && item.id.startsWith("local-") && out.some((row) => isPendingTwin(item, row))) {
      continue;
    }
    out.push(item);
    seen.add(item.id);
  }
  return out;
}

function keepCacheExtras(incoming: HistoryItem[], current: HistoryItem[]) {
  const merged = withKeptReceipts(incoming, current);
  const seen = new Set(merged.map((item) => item.id));
  const keepAll = isShadowDbEnabled();
  for (const item of current) {
    if (!item?.id || seen.has(item.id)) continue;
    if (typeof item.id === "string" && item.id.startsWith("local-") && incoming.some((row) => isPendingTwin(item, row))) {
      continue;
    }
    if (keepAll || (typeof item.id === "string" && item.id.startsWith("local-"))) {
      merged.push(item);
      seen.add(item.id);
    }
  }
  return merged;
}

function notifyHistory() {
  const rows = cache;
  for (const listener of historyListeners) {
    try {
      listener(rows);
    } catch {
      /* a broken subscriber must never break history delivery */
    }
  }
}

export function onHistoryCacheChange(listener: (items: HistoryItem[]) => void) {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}

export function clearHistoryCache() {
  cache = [];
  fetchedAt = 0;
  inflight = null;
  pendingReceipts.clear();
  persistHistory();
  shadowReset();
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

export function applyLocalKept(localId: string) {
  if (!localId) return;
  let changed = false;
  cache = cache.map((item) => {
    if (item.id !== localId && !(typeof item.id === "string" && item.id.startsWith(`${localId}:`))) return item;
    const next = receiptAfterSend(item.receipt);
    if (next === item.receipt) return item;
    changed = true;
    return { ...item, receipt: next };
  });
  if (changed) {
    persistHistory();
    notifyHistory();
  }
}

export function applyLocalSent(localId: string, serverId: string, peerId?: string) {
  if (!localId || !serverId) return;
  let changed = false;
  cache = cache.map((item) => {
    if (item.id !== localId && !(typeof item.id === "string" && item.id.startsWith(`${localId}:`))) return item;
    changed = true;
    const peer = peerId || item.peerId || "";
    return {
      ...item,
      id: peer ? `${serverId}:${peer}` : serverId,
      receipt: receiptAfterSend(item.receipt, serverId),
    };
  });
  if (changed) {
    persistHistory();
    notifyHistory();
  }
}

onOutboxSent((localId, serverId) => {
  applyLocalSent(localId, serverId);
});

onOutboxKept((localId) => {
  applyLocalKept(localId);
});

onAudioPinned((id, path) => {
  if (!id || !path) return;
  const tx = txIdOf(id);
  let changed = false;
  cache = cache.map((item) => {
    if (item.id !== id && txIdOf(item.id) !== tx) return item;
    const audioUrl = preferLocalAudio(path, item.audioUrl);
    if (audioUrl === item.audioUrl) return item;
    changed = true;
    return { ...item, audioUrl };
  });
  if (changed) {
    persistHistory();
    notifyHistory();
  }
});

export function seedHistoryCache(items: HistoryItem[]) {
  try {
    cache = keepCacheExtras(Array.isArray(items) ? items : [], cache);
  } catch {
    if (!Array.isArray(cache)) cache = [];
  }
  fetchedAt = Date.now();
  persistHistory();
  notifyHistory();
}

export function mergeLocalIntoCache(local: HistoryItem[]) {
  if (!Array.isArray(local) || !local.length) return cache;
  cache = mergeLocalRows(local, cache);
  persistHistory();
  notifyHistory();
  return cache;
}

function upsertOne(item: HistoryItem, opts?: { replaceAudio?: boolean }) {
  if (!item?.id) return;
  const tx = txIdOf(item.id);
  let found = false;
  const pickAudio = (next?: string | null, prev?: string | null) =>
    opts?.replaceAudio && next ? next : preferLocalAudio(next, prev);
  cache = cache.map((row) => {
    if (row.id !== item.id && !(tx && txIdOf(row.id) === tx && (row.peerId || "") === (item.peerId || ""))) {
      return row;
    }
    found = true;
    return {
      ...row,
      ...item,
      createdAt: row.createdAt || item.createdAt,
      audioUrl: pickAudio(item.audioUrl, row.audioUrl),
      receipt: mergeReceipt(row.receipt, item.receipt),
    };
  });
  if (!found) {
    const twin = cache.find((row) => isPendingTwin(row, item));
    if (twin) {
      cache = cache.map((row) =>
        row.id === twin.id
          ? {
              ...row,
              ...item,
              createdAt: row.createdAt || item.createdAt,
              audioUrl: pickAudio(item.audioUrl, row.audioUrl),
              receipt: mergeReceipt(row.receipt, item.receipt),
            }
          : row,
      );
    } else {
      cache = [item, ...cache];
    }
  }
}

export function historyItemFromReady(payload: TransmissionReadyPayload, myId?: string): HistoryItem | null {
  if (!payload?.transmissionId || !payload.senderId) return null;
  const mine = Boolean(myId && payload.senderId === myId);
  const kind = payload.kind || (payload.audioUrl ? "walkie" : "text");
  const group = isGroupPayload(payload);
  const peerId = group ? payload.channelId : mine ? "" : payload.senderId;
  if (mine && !peerId) return null;
  const myText = mine
    ? payload.originalText || payload.translatedText || null
    : payload.translatedText || payload.originalText || null;
  const packed = decodeReply(myText || "");
  return {
    id: mine ? `${payload.transmissionId}:${peerId}` : payload.transmissionId,
    senderName: payload.senderName || "",
    senderId: payload.senderId,
    originalText: mine ? packed.text || myText : payload.originalText ?? null,
    translatedText: packed.text || myText,
    audioUrl: kind === "text" ? null : payload.audioUrl ?? null,
    language: payload.language,
    speakLang: payload.speakLang,
    mode: payload.mode,
    createdAt: new Date(payload.readyAt || Date.now()).toISOString(),
    durationMs: payload.durationMs ?? null,
    mine,
    peerId,
    peerName: group
      ? peekGroups().find((row) => row.id === payload.channelId)?.name || (mine ? undefined : payload.senderName)
      : mine
        ? undefined
        : payload.senderName,
    peerPhone: group ? null : payload.senderPhone ?? null,
    peerAvatar: group
      ? peekGroups().find((row) => row.id === payload.channelId)?.avatarUrl ?? payload.senderAvatarUrl ?? null
      : payload.senderAvatarUrl ?? null,
    peerGender: payload.voiceGender,
    kind,
    viewOnce: payload.viewOnce,
    replyToId: payload.replyToId || packed.reply?.id || null,
    replyToName: payload.replyToName || packed.reply?.name || null,
    replyToText: payload.replyToText || packed.reply?.text || null,
    receipt: mine
      ? mergeReceipt(receiptFromEcho(payload.receipt), takePendingReceipt(payload.transmissionId)) || "sent"
      : undefined,
    channelId: payload.channelId || (group ? payload.channelId : null),
    expiresAt: payload.expiresAt || null,
  };
}

/** Socket incoming → SQLite + RAM immediately. No-op when the flag is off. */
export function ingestTransmissionReady(payload: TransmissionReadyPayload, myId?: string) {
  if (!isShadowDbEnabled()) return;
  if (payload.kind === "voice" && payload.usedOriginalVoice && isVoiceDubbed(payload.transmissionId)) return;
  if (payload.kind === "voice" && payload.usedOriginalVoice === false && payload.audioUrl) {
    markVoiceDubbed(payload.transmissionId);
  }
  const item = historyItemFromReady(payload, myId);
  if (!item) return;
  upsertOne(item, { replaceAudio: payload.kind === "voice" && payload.usedOriginalVoice === false });
  fetchedAt = Date.now();
  persistHistory();
  shadowUpsertNow([item]);
  notifyHistory();
}

function persistHistory() {
  const rows = Array.isArray(cache) ? cache : [];
  if (FileSystem.documentDirectory && typeof FileSystem.writeAsStringAsync === "function") {
    try {
      const payload = JSON.stringify({ userId: cacheUserId, items: rows.slice(0, 150) });
      void FileSystem.writeAsStringAsync(HISTORY_FILE, payload).catch(() => undefined);
    } catch {
      /* JSON write is best-effort; sqlite shadow still runs below */
    }
  }
  shadowPersist(rows);
}

/** Last chats stay on the phone so Messages does not go empty while Render wakes. */
export async function hydrateHistoryCache(userId?: string) {
  if (diskReady) {
    if (userId && cacheUserId && userId !== cacheUserId) {
      cache = [];
      fetchedAt = 0;
      cacheUserId = userId;
      persistHistory();
      shadowReset();
    } else if (userId) {
      cacheUserId = userId;
    }
    return cache;
  }
  diskReady = true;
  let skipLocal = false;
  if (FileSystem.documentDirectory && typeof FileSystem.readAsStringAsync === "function") {
    try {
      const raw = await FileSystem.readAsStringAsync(HISTORY_FILE);
      const parsed = JSON.parse(raw) as HistoryItem[] | { userId?: string; items?: HistoryItem[] };
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
      const owner = Array.isArray(parsed) ? "" : parsed.userId || "";
      if (userId && owner && owner !== userId) {
        cache = [];
        fetchedAt = 0;
        cacheUserId = userId;
        skipLocal = true;
        shadowReset();
      } else {
        if (owner) cacheUserId = owner;
        if (rows.length) {
          cache = withKeptReceipts(rows, cache);
          if (!fetchedAt) fetchedAt = 1;
        }
      }
    } catch {
      /* first launch, or a corrupt/empty cache file: fall back to empty cache */
    }
  }
  if (!Array.isArray(cache)) cache = [];
  if (!skipLocal && isShadowDbEnabled()) {
    try {
      const local = await loadLocalMessages();
      if (local.length) {
        cache = mergeLocalRows(local, cache);
        if (!fetchedAt) fetchedAt = 1;
        console.log("[localFirst] hydrate", local.length);
      }
    } catch {
      /* sqlite read is best-effort; JSON cache still paints */
    }
  }
  shadowPersist(cache);
  return cache;
}

export function historyForPeer(peerId: string) {
  return cache.filter((item) => (item.peerId || (!item.mine && item.senderId)) === peerId);
}

export function clearPeerHistory(peerId: string) {
  cache = cache.filter((item) => (item.peerId || (!item.mine && item.senderId)) !== peerId);
  fetchedAt = Date.now();
  persistHistory();
  shadowDeletePeer(peerId);
  return cache;
}

export function removeFromHistory(transmissionId: string, opts?: { opened?: boolean }) {
  if (!transmissionId) return cache;
  const id = txIdOf(transmissionId);
  if (opts?.opened) {
    cache = cache.map((item) =>
      txIdOf(item.id) === id
        ? { ...item, openedOnce: true, audioUrl: item.mine ? item.audioUrl : null, receipt: item.mine ? "read" : item.receipt }
        : item,
    );
  } else {
    cache = cache.filter((item) => txIdOf(item.id) !== id);
    shadowDeleteMessage(id);
  }
  fetchedAt = Date.now();
  persistHistory();
  notifyHistory();
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
      // Phase 6: server list is dual-write backfill. Local files/text never lose to empty relay URLs.
      cache = keepCacheExtras(incoming, cache);
      fetchedAt = Date.now();
      persistHistory();
      notifyHistory();
      if (isRelayReadEnabled()) console.log("[localFirst] relay backfill", incoming.length, "keep", cache.length);
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
