import { PublicUser } from "@talk/shared";
import { api } from "./api";

export async function pickLocalPhoto() {
  try {
    const ImagePicker = require("expo-image-picker") as typeof import("expo-image-picker");
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return null;
    const picked = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (picked.canceled || !picked.assets[0]) return null;
    return picked.assets[0].uri;
  } catch {
    return null;
  }
}

export async function uploadAvatar(token: string, uri: string) {
  const name = uri.split("/").pop() || "avatar.jpg";
  const type = name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  const form = new FormData();
  form.append("photo", { uri, name, type } as unknown as Blob);
  return api<PublicUser>("/users/me/avatar", { method: "POST", token, body: form });
}
