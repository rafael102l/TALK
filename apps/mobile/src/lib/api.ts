import { apiBaseUrl } from "./config";
import { anchorMedia, currentApiBase, discoveryHeld, ensureApiBase, refreshApiBase } from "./discover";

type Options = RequestInit & { token?: string | null; timeoutMs?: number };

export function getApiBase() {
  return currentApiBase() ?? apiBaseUrl();
}

export { anchorMedia };

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const form = isFormBody(options.body);
  const headers: Record<string, string> = {};
  if (!form) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const timeoutMs = options.timeoutMs ?? (form ? 45000 : 8000);
  const base = (await ensureApiBase()) || getApiBase();
  try {
    return await requestOnce<T>(base, path, options, headers, timeoutMs);
  } catch (error) {
    const message = (error as Error).message || "";
    if (message.startsWith("שגיאת שרת") || message.includes("מספר")) throw error;
    if (discoveryHeld()) {
      throw new Error("אין חיבור לשרת. בדקו שהפלאפון והמחשב באותו Wi‑Fi ושהשרת רץ.");
    }
    const next = await refreshApiBase();
    if (!next || next === base) {
      throw new Error("אין חיבור לשרת. בדקו שהפלאפון והמחשב באותו Wi‑Fi ושהשרת רץ.");
    }
    return requestOnce<T>(next, path, options, headers, timeoutMs);
  }
}

async function requestOnce<T>(
  base: string,
  path: string,
  options: Options,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  const res = await fetchWithTimeout(`${base}${path}`, { ...options, headers }, timeoutMs);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message ?? data?.error ?? `שגיאת שרת (${res.status})`;
    throw new Error(Array.isArray(message) ? message.join(", ") : message);
  }
  return retarget(data) as T;
}

function retarget(value: unknown): unknown {
  if (typeof value === "string") return anchorMedia(value);
  if (Array.isArray(value)) return value.map(retarget);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, retarget(item)]));
  }
  return value;
}

function isFormBody(body: RequestInit["body"]) {
  if (!body || typeof body === "string") return false;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  return typeof body === "object" && "_parts" in body;
}

async function fetchWithTimeout(url: string, options: RequestInit, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
