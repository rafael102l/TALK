export type ChatCapture = {
  uri: string;
  kind: "image" | "video";
  durationMs: number;
  mime: string;
  name: string;
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
