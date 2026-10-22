import { TransmissionReadyPayload } from "@talk/shared";
import { api } from "./api";

export type UnreadInfo = {
  total: number;
  byPeer: Record<string, number>;
};

export const EMPTY_UNREAD: UnreadInfo = { total: 0, byPeer: {} };

let unreadCache: UnreadInfo = EMPTY_UNREAD;
let unreadAt = 0;
let unreadInflight: Promise<UnreadInfo> | null = null;

export function fetchUnread(token: string, maxAgeMs = 0) {
  if (maxAgeMs > 0 && unreadAt && Date.now() - unreadAt < maxAgeMs) {
    return Promise.resolve(unreadCache);
  }
  if (unreadInflight) return unreadInflight;
  unreadInflight = api<UnreadInfo>("/transmissions/unread", { token })
    .then((info) => {
      unreadCache = info || EMPTY_UNREAD;
      unreadAt = Date.now();
      return unreadCache;
    })
    .finally(() => {
      unreadInflight = null;
    });
  return unreadInflight;
}

export function fetchWaitingWalkies(token: string) {
  return api<TransmissionReadyPayload[]>("/transmissions/waiting", { token });
}

export function markPeerTextRead(token: string, peerId: string) {
  return api("/transmissions/read", {
    method: "POST",
    token,
    body: JSON.stringify({ peerId }),
  });
}

export function markDelivered(token: string, transmissionId: string) {
  return api(`/transmissions/${transmissionId}/delivered`, {
    method: "POST",
    token,
    once: true,
    timeoutMs: 8000,
  });
}

export function ackDelivered(
  token: string | null | undefined,
  payload: { transmissionId?: string; senderId?: string; kind?: string; audioUrl?: string | null; durationMs?: number | null },
  myId?: string | null,
) {
  if (!token || !payload.transmissionId || payload.senderId === myId) return;
  if (!isInboxMessage(payload)) return;
  void markDelivered(token, payload.transmissionId).catch(() => undefined);
}

export function isInboxMessage(payload: { kind?: string; audioUrl?: string | null; durationMs?: number | null }) {
  if (payload.kind === "text" || payload.kind === "voice") return true;
  if (payload.kind === "walkie") return false;
  return !payload.audioUrl && !payload.durationMs;
}
