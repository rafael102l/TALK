import { MatchedContact } from "@talk/shared";
import { api } from "./api";
import { loadDeviceContacts } from "./contacts";

let inflight: Promise<MatchedContact[] | null> | null = null;
let cached: MatchedContact[] = [];
let lastSyncAt = 0;
const MIN_INTERVAL_MS = 2 * 60 * 1000;

function onlyTalk(list: MatchedContact[]) {
  return list.filter((contact) => contact.matchedUser && contact.status !== "BLOCKED");
}

export function cachedTalkContacts() {
  return cached;
}

export async function fetchTalkContacts(token: string): Promise<MatchedContact[]> {
  const list = onlyTalk(await api<MatchedContact[]>("/contacts", { token, timeoutMs: 5000 }));
  cached = list;
  return list;
}

async function runPhonebookSync(token: string, force: boolean): Promise<MatchedContact[] | null> {
  if (!force && Date.now() - lastSyncAt < MIN_INTERVAL_MS) return null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const device = await loadDeviceContacts({ request: false });
  if (!device.length) {
    lastSyncAt = Date.now();
    return null;
  }
  let list: MatchedContact[] = [];
  for (let i = 0; i < device.length; i += 400) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    list = await api<MatchedContact[]>("/contacts/sync", {
      method: "POST",
      token,
      timeoutMs: 20000,
      body: JSON.stringify({ contacts: device.slice(i, i + 400) }),
    });
  }
  lastSyncAt = Date.now();
  cached = onlyTalk(list);
  return cached;
}

export async function autoSyncContacts(
  token: string,
  force = false,
  onUpdated?: (list: MatchedContact[]) => void,
  phonebook = false,
): Promise<MatchedContact[]> {
  if (cached.length) onUpdated?.(cached);
  const list = await fetchTalkContacts(token).catch(() => cached);
  cached = list;
  onUpdated?.(list);

  if (phonebook && !inflight) {
    inflight = new Promise((resolve) => setTimeout(resolve, 600)).then(() =>
      runPhonebookSync(token, force)
        .catch(() => null)
        .finally(() => {
          inflight = null;
        }),
    );
    void inflight.then((next) => {
      if (next) onUpdated?.(next);
    });
  }
  return list;
}
