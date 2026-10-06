import type { LanguageCode } from "./languages";

export type VoiceCloneStatus = "NONE" | "PENDING" | "READY" | "FAILED";
export type AccountPlan = "FREE" | "PLUS";
export type ChannelType = "DIRECT" | "GROUP" | "BROADCAST";
export type TransmissionStatus = "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
export type ReceiveMode = "free" | "plus";
export type VoiceGender = "male" | "female" | "child";

export type PublicUser = {
  id: string;
  phoneE164: string;
  displayName: string;
  avatarUrl: string | null;
  speakLang: LanguageCode;
  listenLang: LanguageCode;
  voiceGender: VoiceGender;
  voiceCloneStatus: VoiceCloneStatus;
  plan: AccountPlan;
  createdAt: string;
};

export type ContactStatus = "PENDING" | "ACCEPTED" | "BLOCKED";

export type MatchedContact = {
  id: string;
  displayName: string;
  phoneE164: string | null;
  matchedUser: PublicUser | null;
  status: ContactStatus;
  incoming: boolean;
};

export type PhoneLookupResult = {
  phoneE164: string | null;
  self: boolean;
  user: PublicUser | null;
};

export type ChannelMember = {
  userId: string;
  displayName: string;
  listenLang: LanguageCode;
  online: boolean;
};

export type ChannelSummary = {
  id: string;
  type: ChannelType;
  name: string | null;
  members: ChannelMember[];
};

export type HistoryItem = {
  id: string;
  senderName: string;
  senderId: string;
  originalText: string | null;
  translatedText: string | null;
  audioUrl: string | null;
  language: string;
  speakLang?: string;
  mode?: ReceiveMode;
  createdAt: string;
  durationMs: number | null;
  mine?: boolean;
  peerId?: string;
  peerName?: string;
  peerAvatar?: string | null;
  peerGender?: VoiceGender;
  kind?: "walkie" | "voice" | "text";
  viewOnce?: boolean;
};
