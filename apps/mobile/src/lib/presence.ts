import { api } from "./api";

export async function fetchOnlineIds(token: string, userIds: string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Set<string>();
  const res = await api<{ online: string[] }>(`/presence?userIds=${ids.join(",")}`, {
    token,
    timeoutMs: 4000,
  });
  return new Set(res.online || []);
}

type PresencePayload = { userId?: string; online?: boolean; lastSeen?: number | string };

const online = new Map<string, boolean>();
const lastSeen = new Map<string, number>();
const listeners = new Set<(payload?: PresencePayload) => void>();

function notify(payload?: PresencePayload) {
  for (const fn of listeners) fn(payload);
}

export function notePresence(payload: PresencePayload) {
  if (!payload?.userId) return;
  online.set(payload.userId, Boolean(payload.online));
  const seen = Number(payload.lastSeen);
  if (Number.isFinite(seen) && seen > 0) lastSeen.set(payload.userId, seen);
  notify(payload);
}

export function isCachedOnline(id: string) {
  return online.get(id) === true;
}

export function knownLastSeen(id: string): number | null {
  return lastSeen.get(id) ?? null;
}

export function rememberLastSeen(id: string, at: number) {
  if (!id || !at) return;
  lastSeen.set(id, at);
  notify();
}

export function subscribePresence(fn: (payload?: PresencePayload) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function fetchPresence(
  token: string,
  userIds: string[],
): Promise<{ online: Set<string>; lastSeen: Record<string, number> }> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const empty = { online: new Set<string>(), lastSeen: {} as Record<string, number> };
  if (!ids.length) return empty;
  const res = await api<{ online: string[]; lastSeen?: Record<string, number | string> }>(
    `/presence?userIds=${ids.join(",")}`,
    { token, timeoutMs: 4000 },
  );
  const set = new Set(res.online || []);
  const seen: Record<string, number> = {};
  for (const id of ids) online.set(id, set.has(id));
  for (const [id, raw] of Object.entries(res.lastSeen || {})) {
    const at = Number(raw);
    if (!id || !Number.isFinite(at) || at <= 0) continue;
    lastSeen.set(id, at);
    seen[id] = at;
  }
  notify();
  return { online: set, lastSeen: seen };
}
