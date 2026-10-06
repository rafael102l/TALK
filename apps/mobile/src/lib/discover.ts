import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { apiBaseUrl } from "./config";

const SAVED_KEY = "talk.apiBase";
const PORT = 3000;

let base: string | null = null;
let loaded = false;
let hold = false;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<(url: string) => void>();

export function currentApiBase() {
  return base;
}

export function discoveryHeld() {
  return hold;
}

/** While the finger is on the talk button, do not scan the network. */
export function holdDiscovery(next: boolean) {
  hold = next;
}

export function onApiBase(listener: (url: string) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearApiBase() {
  base = null;
  loaded = false;
}

/** Fast path: return the last working address. Never scans. */
export async function ensureApiBase() {
  if (!loaded) {
    loaded = true;
    const configured = apiBaseUrl().replace(/\/$/, "");
    const saved = await SecureStore.getItemAsync(SAVED_KEY).catch(() => null);
    // Prefer cloud config over a stale LAN IP left from older installs.
    if (saved && isLanUrl(saved) && !isLanUrl(configured)) {
      base = configured;
      await SecureStore.setItemAsync(SAVED_KEY, configured).catch(() => undefined);
    } else {
      base = saved || configured;
      if (!saved && configured) {
        await SecureStore.setItemAsync(SAVED_KEY, configured).catch(() => undefined);
      }
    }
  }
  return base;
}

/** Slow path: only after a real request failure. */
export function refreshApiBase() {
  if (hold) return Promise.resolve(base);
  if (!refreshing) {
    refreshing = findServer().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function findServer() {
  const configured = apiBaseUrl().replace(/\/$/, "");
  // Cloud / Render first (free tier cold start can take ~1 minute).
  if (configured && (await ping(configured, 55000))) {
    adopt(configured);
    await SecureStore.setItemAsync(SAVED_KEY, configured).catch(() => undefined);
    return configured;
  }
  const phoneIp = await Network.getIpAddressAsync().catch(() => "");
  const prefix = subnetOf(phoneIp);
  if (base && (await ping(base, 800))) return base;
  if (hold) return base;
  const saved = await SecureStore.getItemAsync(SAVED_KEY).catch(() => null);
  if (saved && saved !== base && (!prefix || subnetOf(hostOf(saved)) === prefix) && (await ping(saved, 800))) {
    adopt(saved);
    return saved;
  }
  if (hold || !prefix) return base || configured || null;
  const own = hostOf(`http://${phoneIp}`);
  const hosts = Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`).filter((host) => host !== own);
  const found = await scan(hosts);
  if (!found || hold) return base || configured || null;
  adopt(found);
  await SecureStore.setItemAsync(SAVED_KEY, found).catch(() => undefined);
  return found;
}

function adopt(url: string) {
  if (base === url) return;
  base = url;
  for (const listener of listeners) listener(url);
}

async function scan(hosts: string[]) {
  const size = 24;
  for (let index = 0; index < hosts.length; index += size) {
    if (hold) return null;
    const batch = hosts.slice(index, index + size);
    const winner = await Promise.race([
      Promise.all(batch.map((host) => probe(host))).then((rows) => rows.find(Boolean) ?? null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
    ]);
    if (winner) return winner;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return null;
}

async function probe(host: string) {
  const url = `http://${host}:${PORT}`;
  return (await ping(url, 700)) ? url : null;
}

async function ping(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const data = (await res.json()) as { name?: string };
    return data?.name === "talk-api";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function subnetOf(ip: string) {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return "";
  return parts.slice(0, 3).join(".");
}

function hostOf(url: string) {
  return url.replace(/^https?:\/\//, "").split(":")[0].split("/")[0];
}

function isLanUrl(url: string) {
  return /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|localhost|127\.0\.0\.1)/i.test(url);
}

export function anchorMedia(url: string) {
  if (!url || !base || url.startsWith("file:")) return url;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname || "";
    if (!path.startsWith("/media") && parsed.port !== String(PORT)) return url;
    const root = new URL(base);
    return `${root.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}
