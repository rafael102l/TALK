export declare const SOCKET_EVENTS: {
    readonly PTT_START: "ptt:start";
    readonly PTT_SPEAKING: "ptt:speaking";
    readonly PTT_FLOOR_BUSY: "ptt:floor-busy";
    readonly PTT_RELEASED: "ptt:released";
    readonly TRANSMISSION_PROCESSING: "transmission:processing";
    readonly TRANSMISSION_READY: "transmission:ready";
    readonly TRANSMISSION_FAILED: "transmission:failed";
    readonly PRESENCE: "presence:update";
    readonly INCOMING: "incoming:transmission";
};
export type PttStartPayload = {
    channelId: string;
};
export type PttSpeakingPayload = {
    channelId: string;
    speakerId: string;
    speakerName: string;
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
    audioUrl: string;
    originalText?: string | null;
    translatedText?: string | null;
    durationMs?: number | null;
    usedOriginalVoice: boolean;
};
