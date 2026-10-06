import { TransmissionReadyPayload, VoiceGender } from "@talk/shared";
import { anchorMedia } from "./api";

type Handler = (payload: TransmissionReadyPayload, opened?: boolean) => void;
const handlers = new Set<Handler>();

export function payloadFromPush(data: Record<string, unknown> | undefined): TransmissionReadyPayload | null {
  if (!data) return null;
  const senderId = String(data.senderId || "");
  const transmissionId = String(data.transmissionId || "");
  if (!senderId || !transmissionId) return null;
  const gender = data.voiceGender === "female" || data.voiceGender === "child" ? data.voiceGender : "male";
  const kind = data.kind === "voice" || data.kind === "text" ? data.kind : "walkie";
  return {
    transmissionId,
    channelId: String(data.channelId || ""),
    senderId,
    senderName: String(data.senderName || data.senderPhone || ""),
    language: String(data.language || ""),
    speakLang: String(data.speakLang || ""),
    mode: "free",
    audioUrl: data.audioUrl ? anchorMedia(String(data.audioUrl)) : null,
    originalText: data.originalText ? String(data.originalText) : null,
    translatedText: data.translatedText ? String(data.translatedText) : null,
    usedOriginalVoice: data.usedOriginalVoice === "1" || data.usedOriginalVoice === true,
    needsAccept: data.needsAccept === "1" || data.needsAccept === true,
    live: data.live === "1" || data.live === true,
    senderPhone: data.senderPhone ? String(data.senderPhone) : undefined,
    senderAvatarUrl: data.senderAvatarUrl ? anchorMedia(String(data.senderAvatarUrl)) : null,
    voiceGender: gender as VoiceGender,
    kind,
  };
}

export function subscribeIncomingPush(handler: Handler) {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitIncomingPush(payload: TransmissionReadyPayload, opened = false) {
  for (const handler of handlers) handler(payload, opened);
}
