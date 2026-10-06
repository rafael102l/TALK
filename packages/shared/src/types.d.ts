import type { LanguageCode } from "./languages";
export type VoiceCloneStatus = "NONE" | "PENDING" | "READY" | "FAILED";
export type AccountPlan = "FREE" | "PLUS";
export type ChannelType = "DIRECT" | "GROUP" | "BROADCAST";
export type TransmissionStatus = "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
export type PublicUser = {
    id: string;
    phoneE164: string;
    displayName: string;
    avatarUrl: string | null;
    speakLang: LanguageCode;
    listenLang: LanguageCode;
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
    createdAt: string;
    durationMs: number | null;
};
