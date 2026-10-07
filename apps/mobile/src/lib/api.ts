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

  const base = ((await ensureApiBase()) || getApiBase()).replace(/\/$/, "");
  const cloud = isCloudBase(base);
  const timeoutMs = options.timeoutMs ?? (form ? 60000 : cloud ? 45000 : 8000);

  try {
    return await requestOnce<T>(base, path, options, headers, timeoutMs);
  } catch (error) {
    const message = (error as Error).message || "";
    if (isAuthError(message) || message.startsWith("שגיאת שרת") || message.includes("מספר")) {
      throw error;
    }
    if (discoveryHeld()) {
      throw new Error(offlineMessage());
    }

    // Render free tier often needs a second wake-up attempt on the same URL.
    if (cloud) {
      try {
        return await requestOnce<T>(base, path, options, headers, Math.max(timeoutMs, 60000));
      } catch (retryError) {
        const retryMessage = (retryError as Error).message || "";
        if (isAuthError(retryMessage) || retryMessage.startsWith("שגיאת שרת")) throw retryError;
        /* fall through to discovery */
      }
    }

    const next = await refreshApiBase();
    const retryBase = (next || base).replace(/\/$/, "");
    if (!retryBase) throw new Error(offlineMessage());
    return requestOnce<T>(retryBase, path, options, headers, Math.max(timeoutMs, cloud || isCloudBase(retryBase) ? 60000 : 8000));
  }
}

export function isAuthFailure(message: string) {
  return /unauthorized|session replaced|לא מורשה|401|session expired|session invalidated/i.test(message);
}

function isAuthError(message: string) {
  return isAuthFailure(message);
}

function offlineMessage() {
  return "אין חיבור לשרת. בדקו אינטרנט — השרת בענן (Render) עלול להתעורר עד דקה.";
}

function isCloudBase(url: string) {
  return /^https:\/\//i.test(url) || /\.onrender\.com/i.test(url);
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
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new Error(`שגיאת שרת (${res.status})`);
    throw new Error("תשובת שרת לא תקינה");
  }
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
