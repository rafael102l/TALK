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
