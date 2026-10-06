export const SOCKET_EVENTS = {
  PTT_START: "ptt:start",
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

export type PttSpeakingPayload = {
  channelId: string;
  speakerId: string;
  speakerName: string;
  speakerAvatarUrl?: string | null;
  voiceGender?: "male" | "female" | "child";
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
};
