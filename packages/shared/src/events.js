"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SOCKET_EVENTS = void 0;
exports.SOCKET_EVENTS = {
    PTT_START: "ptt:start",
    PTT_AUDIO: "ptt:audio",
    PTT_CLIP: "ptt:clip",
    PTT_CAPTION: "ptt:caption",
    PTT_SPEAKING: "ptt:speaking",
    PTT_FLOOR_BUSY: "ptt:floor-busy",
    PTT_RELEASED: "ptt:released",
    WALKIE_SEND: "walkie:send",
    VOICE_SEND: "voice:send",
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
    USER_UPDATED: "user:updated",
    CHANNEL_UPDATE: "channel:update",
    SESSION_REPLACED: "session:replaced",
};
//# sourceMappingURL=events.js.map