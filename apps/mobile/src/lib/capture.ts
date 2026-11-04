export type ChatCapture = {
  uri: string;
  kind: "image" | "video";
  durationMs: number;
  mime: string;
  name: string;
  note?: boolean;
};

type CaptureOpts = { mime?: string; kind?: "image" | "video"; durationMs?: number; note?: boolean };

const PICKER_OPTS = {
  videoMaxDuration: 60,
  quality: 0.8,
  allowsEditing: false,
  copyToCacheDirectory: true,
};

function mimeOf(uri: string, type?: string | null) {
  if (type && type !== "image" && type !== "video") return type;
  const path = uri.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4";
  if (type === "video") return "video/mp4";
  return "image/jpeg";
}

function nameOf(uri: string, mime: string) {
  const fromUri = uri.split("?")[0].split("/").pop();
  if (fromUri && fromUri.includes(".")) return fromUri;
  if (mime.startsWith("video/")) return "clip.mp4";
  if (mime.includes("png")) return "photo.png";
  return "photo.jpg";
}

function durationOf(value: unknown) {
  const n = Number(value) || 0;
  if (n <= 0) return 0;
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

export async function captureChatMedia(): Promise<ChatCapture | null> {
  const ImagePicker = require("expo-image-picker") as typeof import("expo-image-picker");
  const cam = await ImagePicker.requestCameraPermissionsAsync();
  if (!cam.granted) throw new Error("אין הרשאה למצלמה. אשרו מצלמה בהגדרות הטלפון.");
  const picked = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions?.All ?? ["images", "videos"],
    videoMaxDuration: 60,
    quality: 1,
    allowsEditing: false,
  });
  if (picked.canceled || !picked.assets?.[0]) return null;
  const asset = picked.assets[0];
  const mime = mimeOf(asset.uri, asset.mimeType || asset.type);
  const kind: "image" | "video" = mime.startsWith("video/") || asset.type === "video" ? "video" : "image";
  const durationMs = kind === "video" ? durationOf(asset.duration) : 0;
  if (kind === "video" && durationMs > 61_500) throw new Error("אפשר לצלם סרטון עד דקה.");
  return {
    uri: asset.uri,
    kind,
    durationMs,
    mime,
    name: nameOf(asset.uri, mime),
  };
}

type PickerAsset = { uri: string; mimeType?: string | null; type?: string | null; duration?: number | null };

async function fromPickerAsset(asset: PickerAsset, camera: boolean): Promise<ChatCapture> {
  const mime = mimeOf(asset.uri, asset.mimeType || asset.type);
  const kind: "image" | "video" = mime.startsWith("video/") || asset.type === "video" ? "video" : "image";
  const durationMs = kind === "video" ? durationOf(asset.duration) : 0;
  if (kind === "video" && durationMs > 61_500) {
    throw new Error(camera ? "אפשר לצלם סרטון עד דקה." : "אפשר לבחור סרטון עד דקה.");
  }
  const { keepLocalCapture } = await import("./mediaCache");
  const uri = await keepLocalCapture(asset.uri, kind);
  return {
    uri,
    kind,
    durationMs,
    mime: kind === "image" ? "image/jpeg" : mime,
    name: kind === "image" ? "photo.jpg" : nameOf(uri, mime),
  };
}

export function captureFromUri(uri: string, opts?: CaptureOpts): ChatCapture {
  const mime = opts?.mime || mimeOf(uri, opts?.kind || null);
  const kind = opts?.kind || (mime.startsWith("video/") ? "video" : "image");
  return {
    uri,
    kind,
    durationMs: kind === "video" ? durationOf(opts?.durationMs) : 0,
    mime,
    name: opts?.note ? "videonote.mp4" : nameOf(uri, mime),
    note: Boolean(opts?.note),
  };
}

export async function captureFromLocalUri(uri: string, opts?: CaptureOpts): Promise<ChatCapture> {
  const taken = captureFromUri(uri, opts);
  const { keepLocalCapture } = await import("./mediaCache");
  taken.uri = await keepLocalCapture(taken.uri, taken.kind);
  if (taken.kind === "image") {
    taken.mime = "image/jpeg";
    taken.name = "photo.jpg";
  }
  return taken;
}

export async function lastGalleryThumb(): Promise<string> {
  try {
    const MediaLibrary = require("expo-media-library") as typeof import("expo-media-library");
    const perm = await MediaLibrary.getPermissionsAsync();
    if (!perm.granted) return "";
    const page = await MediaLibrary.getAssetsAsync({
      first: 1,
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [MediaLibrary.SortBy.creationTime],
    });
    return page.assets?.[0]?.uri || "";
  } catch {
    return "";
  }
}

export async function pickStickerPhoto(source: "camera" | "library"): Promise<string | null> {
  const ImagePicker = require("expo-image-picker") as typeof import("expo-image-picker");
  const images = ImagePicker.MediaTypeOptions?.Images ?? ["images"];
  let picked: ImagePicker.ImagePickerResult;
  if (source === "camera") {
    const cam = await ImagePicker.requestCameraPermissionsAsync();
    if (!cam.granted) throw new Error("אין הרשאה למצלמה. אשרו מצלמה בהגדרות הטלפון.");
    picked = await ImagePicker.launchCameraAsync({
      mediaTypes: images,
      quality: 0.9,
      allowsEditing: false,
      copyToCacheDirectory: true,
    });
  } else {
    try {
      await ImagePicker.requestMediaLibraryPermissionsAsync();
    } catch {
      /* Android Photo Picker can still open without this grant. */
    }
    picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: images,
      quality: 0.9,
      allowsEditing: false,
      copyToCacheDirectory: true,
    });
  }
  const uri = picked.canceled ? "" : picked.assets?.[0]?.uri || "";
  if (!uri) return null;
  const { keepLocalCapture } = await import("./mediaCache");
  return keepLocalCapture(uri, "image");
}

export async function pickChatMedia(): Promise<ChatCapture | null> {
  const ImagePicker = require("expo-image-picker") as typeof import("expo-image-picker");
  try {
    await ImagePicker.requestMediaLibraryPermissionsAsync();
  } catch {
    /* Android Photo Picker can still open without this grant. */
  }
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions?.All ?? ["images", "videos"],
    ...PICKER_OPTS,
  });
  if (picked.canceled || !picked.assets?.[0]) return null;
  return fromPickerAsset(picked.assets[0], false);
}
