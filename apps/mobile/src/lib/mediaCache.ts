import * as FileSystem from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { Image } from "react-native";
import { resolveMediaUri } from "./mediaUri";

const AUTO_KEY = "talk.autoSaveMedia";
const SAVED_KEY = "talk.albumSaved";
const CACHE_DIR = `${FileSystem.documentDirectory || ""}talk-cache/`;

let autoSave: boolean | null = null;
let savedAlbum = new Set<string>();
let savedAlbumLoaded = false;

function cacheName(uri: string) {
  const clean = uri.split("?")[0];
  const base = clean.split("/").pop() || "file";
  const safe = base.replace(/[^\w.-]/g, "_").slice(0, 80);
  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) hash = (Math.imul(31, hash) + clean.charCodeAt(i)) | 0;
  return `${Math.abs(hash)}-${safe}`;
}

async function ensureCacheDir() {
  if (!FileSystem.documentDirectory) return;
  const info = await FileSystem.getInfoAsync(CACHE_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
}

export async function isAutoSaveMedia() {
  if (autoSave !== null) return autoSave;
  const raw = await SecureStore.getItemAsync(AUTO_KEY).catch(() => null);
  autoSave = raw !== "0";
  return autoSave;
}

export async function setAutoSaveMedia(on: boolean) {
  autoSave = on;
  await SecureStore.setItemAsync(AUTO_KEY, on ? "1" : "0");
}

async function loadSavedAlbum() {
  if (savedAlbumLoaded) return;
  savedAlbumLoaded = true;
  const raw = await SecureStore.getItemAsync(SAVED_KEY).catch(() => null);
  if (!raw) return;
  try {
    const rows = JSON.parse(raw) as string[];
    if (Array.isArray(rows)) savedAlbum = new Set(rows);
  } catch {
    /* ignore */
  }
}

async function rememberAlbum(name: string) {
  savedAlbum.add(name);
  const rows = [...savedAlbum].slice(-200);
  savedAlbum = new Set(rows);
  await SecureStore.setItemAsync(SAVED_KEY, JSON.stringify(rows)).catch(() => undefined);
}

function mediaLibrary() {
  try {
    return require("expo-media-library") as typeof import("expo-media-library");
  } catch {
    return null;
  }
}

async function saveToTalkAlbum(localUri: string, name: string) {
  if (!(await isAutoSaveMedia())) return;
  await loadSavedAlbum();
  if (savedAlbum.has(name)) return;
  const MediaLibrary = mediaLibrary();
  if (!MediaLibrary) return;
  try {
    const perm = await MediaLibrary.requestPermissionsAsync(true);
    if (!perm.granted) return;
    const asset = await MediaLibrary.createAssetAsync(localUri);
    const albums = await MediaLibrary.getAlbumAsync("TALK");
    if (albums) await MediaLibrary.addAssetsToAlbumAsync([asset], albums, false);
    else await MediaLibrary.createAlbumAsync("TALK", asset, false);
    await rememberAlbum(name);
  } catch {
    /* permission denied or library missing */
  }
}

/** Copy a camera file into the app folder so it is not lost if the gallery is cleared. */
export async function keepLocalCapture(uri: string, _kind?: "image" | "video") {
  if (!uri) return uri;
  if (!/^(file:|content:)/i.test(uri) || !FileSystem.documentDirectory || typeof FileSystem.copyAsync !== "function") {
    return uri;
  }
  try {
    await ensureCacheDir();
    const dest = `${CACHE_DIR}${cacheName(uri)}`;
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri;
  }
}

/** Keep a copy inside the app forever. Optionally also copy to the phone's TALK album. */
export async function cacheChatMedia(uri: string | null | undefined, opts?: { album?: boolean }) {
  const remote = resolveMediaUri(uri);
  if (!remote) return null;
  if (/^(file:|content:|data:)/i.test(remote)) {
    if (opts?.album !== false) void saveToTalkAlbum(remote, cacheName(remote));
    return remote;
  }
  if (!FileSystem.documentDirectory || typeof FileSystem.downloadAsync !== "function") return remote;
  try {
    await ensureCacheDir();
    const dest = `${CACHE_DIR}${cacheName(remote)}`;
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) {
      const result = await FileSystem.downloadAsync(remote, dest);
      if (result.status !== 200) return remote;
    }
    if (opts?.album !== false) void saveToTalkAlbum(dest, cacheName(remote));
    return dest;
  } catch {
    return remote;
  }
}

function asFileUri(uri: string) {
  const value = (uri || "").trim();
  if (!value) return value;
  if (/^(file:|content:|https?:|data:)/i.test(value)) return value;
  if (value.startsWith("/")) return `file://${value}`;
  return value;
}

function loadManipulator(): typeof import("expo-image-manipulator") | null {
  try {
    const core = require("expo-modules-core") as typeof import("expo-modules-core");
    if (core.requireOptionalNativeModule && !core.requireOptionalNativeModule("ExpoImageManipulator")) return null;
    return require("expo-image-manipulator") as typeof import("expo-image-manipulator");
  } catch {
    return null;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** Make a gallery/camera URI a real JPEG/MP4 file Android XHR can upload. */
export async function prepareMediaUpload(
  uri: string,
  kind: "image" | "video",
  mime?: string,
  name?: string,
): Promise<{ uri: string; name: string; type: string }> {
  const local = await keepLocalCapture(uri, kind);
  const fileUri = asFileUri(local);
  if (kind === "video") {
    return {
      uri: fileUri,
      name: name && /\.(mp4|mov|m4v)$/i.test(name) ? name : "clip.mp4",
      type: mime && mime.startsWith("video/") ? mime : "video/mp4",
    };
  }
  const keepRaw = /gif|png|webp/i.test(mime || "") || /\.(gif|png|webp)(\?|$)/i.test(name || uri);
  if (keepRaw) {
    const rawName =
      name && /\.(gif|png|webp)$/i.test(name)
        ? name
        : /gif/i.test(mime || uri)
          ? "clip.gif"
          : /png/i.test(mime || uri)
            ? "sticker.png"
            : "photo.webp";
    return { uri: fileUri, name: rawName, type: mime || "image/gif" };
  }
  const ImageManipulator = loadManipulator();
  if (ImageManipulator) {
    try {
      const dims = await withTimeout(
        new Promise<{ w: number; h: number } | null>((resolve) => {
          Image.getSize(
            fileUri,
            (w, h) => resolve({ w, h }),
            () => resolve(null),
          );
        }),
        2500,
        null,
      );
      const long = dims ? Math.max(dims.w, dims.h) : 0;
      const actions =
        long > 1600 ? (dims && dims.w >= dims.h ? [{ resize: { width: 1600 } }] : [{ resize: { height: 1600 } }]) : [];
      const result = await withTimeout(
        ImageManipulator.manipulateAsync(fileUri, actions, {
          compress: 0.72,
          format: ImageManipulator.SaveFormat.JPEG,
        }),
        8000,
        null,
      );
      if (result?.uri) {
        return { uri: asFileUri(result.uri), name: "photo.jpg", type: "image/jpeg" };
      }
    } catch {
      /* keep the copied file */
    }
  }
  return { uri: fileUri, name: "photo.jpg", type: "image/jpeg" };
}
