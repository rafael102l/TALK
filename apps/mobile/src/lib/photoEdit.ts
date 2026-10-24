import { Image } from "react-native";
import { cacheChatMedia } from "./mediaCache";

export type CropBox = { x: number; y: number; w: number; h: number };

export function containRect(boxW: number, boxH: number, imgW: number, imgH: number) {
  if (!boxW || !boxH || !imgW || !imgH) return { x: 0, y: 0, w: boxW, h: boxH, scale: 1 };
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale };
}

export function imageSize(uri: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export async function cropPhoto(uri: string, crop: CropBox, hd: boolean) {
  try {
    const ImageManipulator = require("expo-image-manipulator") as typeof import("expo-image-manipulator");
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ crop: { originX: Math.round(crop.x), originY: Math.round(crop.y), width: Math.round(crop.w), height: Math.round(crop.h) } }],
      {
        compress: hd ? 0.95 : 0.72,
        format: ImageManipulator.SaveFormat.JPEG,
      },
    );
    return result.uri;
  } catch {
    return uri;
  }
}

export async function compressPhoto(uri: string, hd: boolean) {
  if (hd) return uri;
  try {
    const ImageManipulator = require("expo-image-manipulator") as typeof import("expo-image-manipulator");
    const result = await ImageManipulator.manipulateAsync(uri, [], {
      compress: 0.72,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return result.uri;
  } catch {
    return uri;
  }
}

export async function flattenStage(ref: { current: unknown }, hd: boolean) {
  if (!ref.current) return null;
  try {
    const ViewShot = require("react-native-view-shot") as { captureRef: (node: unknown, opts: object) => Promise<string> };
    return await ViewShot.captureRef(ref.current, {
      format: "jpg",
      quality: hd ? 0.95 : 0.72,
      result: "tmpfile",
    });
  } catch {
    return null;
  }
}

export async function saveEditedToGallery(uri: string) {
  const local = await cacheChatMedia(uri, { album: true });
  return local;
}
