export const SOCKET_EVENTS = {
  PTT_START: "ptt:start",
  PTT_AUDIO: "ptt:audio",
  /** One finished WAV for this press. The server does not stitch PCM frames. */
  PTT_CLIP: "ptt:clip",
  /** Finished walkie clip over the existing socket — skips the HTTP multipart round trip. */
  WALKIE_SEND: "walkie:send",
  /** Chat voice clip over the socket — emit-first to peers, HTTP/DB persist in background. */
  VOICE_SEND: "voice:send",
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
  PRESENCE_APP: "presence:app",
  CHAT_TYPING: "chat:typing",
  CHAT_REACTION: "chat:reaction",
  CHAT_RECEIPT: "chat:receipt",
  CHAT_EDIT: "chat:edit",
  INCOMING: "incoming:transmission",
  CONTACT_REQUEST: "contact:request",
  CONTACT_ACCEPTED: "contact:accepted",
  /** Peer changed their profile photo — refresh every surface that shows them. */
  USER_UPDATED: "user:updated",
  /** Group photo / members / name changed. New joiners get this plus GET /channels. */
  CHANNEL_UPDATE: "channel:update",
  /** Previous device must drop auth — another device claimed this phone's session. */
  SESSION_REPLACED: "session:replaced",
  CALL_USER: "call-user",
  INCOMING_CALL: "incoming-call",
  ACCEPT_CALL: "accept-call",
  REJECT_CALL: "reject-call",
  END_CALL: "end-call",
  CALL_OFFER: "call-offer",
  CALL_ANSWER: "call-answer",
  CALL_ICE: "call-ice",
  CALL_UNAVAILABLE: "call-unavailable",
  CALL_BUSY: "call-busy",
  CALL_PEER_JOINED: "call-peer-joined",
  CALL_PEER_LEFT: "call-peer-left",
  /** Missed calls that arrived while this phone had no socket. Sent once on reconnect. */
  CALL_MISSED_SYNC: "call-missed-sync",
} as const;

export type CallPerson = {
  id: string;
  name: string;
  /** E.164 number shown as the system caller id. */
  phone?: string;
  avatarUrl?: string | null;
  gender?: "male" | "female" | "child";
};

export type IncomingCallPayload = {
  callId: string;
  callerName: string;
  callerPhone: string;
  caller: CallPerson;
};

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
  /** What STT heard in the speaker's language. Shown to the sender. */
  sttText?: string;
  /** Translation that was delivered to the listener. */
  translatedText?: string;
  /** Receipt for the sender. The phone shows it and does not speak it. */
  forSpeaker?: boolean;
  /** BCP-47 tag for the listener TTS, such as ru-RU. */
  targetLanguage?: string;
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
  /** Original clip bytes when the socket already has them — play without a second download. */
  audioB64?: string;
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
  kind?: "walkie" | "voice" | "text" | "image" | "video";
  viewOnce?: boolean;
  releasedAt?: number;
  readyAt?: number;
  /** Listener language differs: do not play the original recording. */
  suppressOriginal?: boolean;
  replyToId?: string | null;
  replyToName?: string | null;
  replyToText?: string | null;
  receipt?: "sent" | "delivered" | "read";
  expiresAt?: string | null;
  /** Sender phone local-* id so READY replaces the matching bubble only. */
  clientLocalId?: string | null;
  /** True when this clip belongs on a GROUP/BROADCAST thread, not a 1:1. */
  group?: boolean;
  /** Group title when the listener may not have that channel cached yet. */
  groupName?: string | null;
};

export type ChatReceiptPayload = {
  transmissionId: string;
  peerId: string;
  receipt: "delivered" | "read";
};
