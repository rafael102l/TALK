export const SOCKET_EVENTS = {
  PTT_START: "ptt:start",
  PTT_AUDIO: "ptt:audio",
  /** Translated phrase for one listener. free = text for the phone's TTS. plus = cloned voice file. */
  PTT_CAPTION: "ptt:caption",
  PTT_SPEAKING: "ptt:speaking",
  PTT_FLOOR_BUSY: "ptt:floor-busy",
  PTT_RELEASED: "ptt:released",
  TRANSMISSION_PROCESSING: "transmission:processing",
  TRANSMISSION_READY: "transmission:ready",
  TRANSMISSION_FAILED: "transmission:failed",
  TRANSMISSION_REMOVED: "transmission:removed",
  PRESENCE: "presence:update",
  INCOMING: "incoming:transmission",
  CONTACT_REQUEST: "contact:request",
  CONTACT_ACCEPTED: "contact:accepted",
  /** Previous device must drop auth — another device claimed this phone's session. */
  SESSION_REPLACED: "session:replaced",
} as const;

export type PttStartPayload = {
  channelId: string;
};

export type PttCaptionPayload = {
  speakerId: string;
  seq: number;
  text: string;
  lang: string;
  mode: "free" | "plus";
  audioUrl?: string | null;
  voiceGender?: "male" | "female" | "child";
};

export type PttSpeakingPayload = {
  channelId: string;
  speakerId: string;
  speakerName: string;
  speakerAvatarUrl?: string | null;
  voiceGender?: "male" | "female" | "child";
  /** True when this listener must hear a translation, never the original voice. */
  translate?: boolean;
};

export type PttFloorBusyPayload = {
  channelId: string;
  speakerId: string;
  speakerName: string;
};

export type TransmissionReadyPayload = {
  transmissionId: string;
  channelId: string;
  senderId: string;
  senderName: string;
  language: string;
  speakLang: string;
  mode: "free" | "plus";
  audioUrl: string | null;
  originalText?: string | null;
  translatedText?: string | null;
  durationMs?: number | null;
  usedOriginalVoice: boolean;
  needsAccept?: boolean;
  /** Live walkie: both accepted each other and both online. Otherwise queue until tap. */
  live?: boolean;
  senderPhone?: string;
  senderAvatarUrl?: string | null;
  voiceGender?: "male" | "female" | "child";
  kind?: "walkie" | "voice" | "text";
  viewOnce?: boolean;
  releasedAt?: number;
  readyAt?: number;
  /** Listener language differs: do not play the original recording. */
  suppressOriginal?: boolean;
};
