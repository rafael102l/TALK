import { apiBaseUrl } from "./config";
import { anchorMedia, currentApiBase, discoveryHeld, ensureApiBase, refreshApiBase } from "./discover";

type Options = RequestInit & {
  token?: string | null;
  timeoutMs?: number;
  /** One attempt. Do not wait out a cold server or scan the LAN. */
  once?: boolean;
};

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
    // 502/503/504 come from Render's proxy when the free server (or its database) is still waking.
    // One more try on the same URL. Other server errors stay final.
    if (isGatewayTimeout(message) && cloud && !options.once) {
      return await requestOnce<T>(base, path, options, headers, Math.max(timeoutMs, 60000));
    }
    if (options.once || isAuthError(message) || message.startsWith("שגיאת שרת") || message.includes("מספר")) {
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

function isGatewayTimeout(message: string) {
  return /שגיאת שרת \((502|503|504)\)/.test(message);
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
  if (isFormBody(options.body)) {
    return uploadForm<T>(`${base}${path}`, options.body, headers, timeoutMs);
  }
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

function uploadForm<T>(
  url: string,
  body: RequestInit["body"],
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "content-type") continue;
      xhr.setRequestHeader(key, value);
    }
    xhr.onload = () => {
      const text = xhr.responseText || "";
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        reject(new Error(xhr.status >= 200 && xhr.status < 300 ? "תשובת שרת לא תקינה" : `שגיאת שרת (${xhr.status})`));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const record = data && typeof data === "object" ? (data as { message?: unknown; error?: unknown }) : null;
        const message = record?.message ?? record?.error ?? `שגיאת שרת (${xhr.status})`;
        reject(new Error(Array.isArray(message) ? message.join(", ") : String(message)));
        return;
      }
      resolve(retarget(data) as T);
    };
    xhr.onerror = () => reject(new Error("Network request failed"));
    xhr.ontimeout = () => reject(new Error("Network request failed"));
    xhr.send(body as XMLHttpRequestBodyInit);
  });
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
