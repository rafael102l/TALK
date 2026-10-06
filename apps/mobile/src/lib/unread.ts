import { TransmissionReadyPayload } from "@talk/shared";
import { api } from "./api";

export type UnreadInfo = {
  total: number;
  byPeer: Record<string, number>;
};

export const EMPTY_UNREAD: UnreadInfo = { total: 0, byPeer: {} };

export function fetchUnread(token: string) {
  return api<UnreadInfo>("/transmissions/unread", { token });
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

export function isInboxMessage(payload: { kind?: string; audioUrl?: string | null; durationMs?: number | null }) {
  if (payload.kind === "text" || payload.kind === "voice") return true;
  if (payload.kind === "walkie") return false;
  return !payload.audioUrl && !payload.durationMs;
}
