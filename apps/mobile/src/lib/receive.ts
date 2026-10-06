import { HistoryItem, TransmissionReadyPayload, VoiceGender } from "@talk/shared";
import { playUri, setPlaybackMode, stopPlayback } from "./audio";
import { clockLog } from "./clock";
import { speakRobot, stopRobot } from "./onDeviceAi";

type Playable = {
  transmissionId?: string;
  mode?: "free" | "plus";
  audioUrl?: string | null;
  originalText?: string | null;
  translatedText?: string | null;
  speakLang?: string;
  language: string;
  voiceGender?: VoiceGender;
  usedOriginalVoice?: boolean;
  kind?: "walkie" | "voice" | "text";
  durationMs?: number | null;
  viewOnce?: boolean;
  releasedAt?: number;
  readyAt?: number;
};

const played = new Set<string>();
let speaking = false;

function collapseRepeats(text: string) {
  let t = text.replace(/\s+/g, " ").trim();
  if (!t) return t;
  t = t.replace(/(\S+)(?:\s+\1){1,}/g, "$1");
  const m = t.match(/^(.{4,}?)(?:[\s.,!?]+)\1(?:[\s.,!?]+\1)*$/);
  if (m) return m[1].trim();
  return t;
}

export async function playReceived(
  payload: Playable,
  listenLang: string,
  _token?: string | null,
): Promise<{ translatedText: string | null }> {
  const id = payload.transmissionId;
  if (id) {
    if (played.has(id)) return { translatedText: null };
    played.add(id);
    if (played.size > 80) {
      played.clear();
      played.add(id);
    }
  }
  if (speaking) {
    await stopRobot();
    await stopPlayback();
  }
  speaking = true;
  clockLog("play", { kind: payload.kind || "walkie" });
  try {
    await setPlaybackMode();
    const sourceLang = payload.speakLang || payload.language;
    // Server already stamped the listener language on the payload — prefer it.
    const hearAs = payload.language || listenLang;
    const original = collapseRepeats(payload.originalText?.trim() ?? "");
    const translated = collapseRepeats(payload.translatedText?.trim() ?? "");
    const gender = payload.voiceGender ?? "male";
    const sameLang = hearAs === sourceLang;
    const caption =
      (translated || original) && !isFakeSpeech(translated || original) ? translated || original : null;

    if (
      payload.viewOnce ||
      payload.kind === "text"
    ) {
      return { translatedText: caption };
    }

    const translatedFile = Boolean(payload.audioUrl) && !payload.usedOriginalVoice;
    // Prefer server-prepared audio for the listener language; never force original when languages differ.
    if (payload.audioUrl && (translatedFile || sameLang)) {
      await stopRobot();
      await stopPlayback();
      try {
        await playUri(payload.audioUrl);
        return { translatedText: caption };
      } catch {
        /* fall through to spoken text */
      }
    }

    const spoken = sameLang ? original || translated : translated || original;
    if (spoken && !isFakeSpeech(spoken)) {
      await speakRobot(spoken, hearAs, gender === "female" || gender === "child" ? gender : "male");
    }
    return { translatedText: caption };
  } finally {
    speaking = false;
  }
}

function isFakeSpeech(text: string) {
  const t = text
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,"']+$/g, "");
  if (!t) return true;
  if (
    /^(thank you( very much)?|thanks( for (watching|listening))?|thank you for watching|bye|goodbye|the end|you|subtitles?|captions?|תודה( רבה)?( לך)?|כתוביות( כתוביות)?|شكرا( جزيلا)?)$/i.test(
      t,
    )
  ) {
    return true;
  }
  return /^(\S+)(?:\s+\1){1,3}$/u.test(t) && t.length <= 40;
}

export function incomingCaption(payload: TransmissionReadyPayload, translatedText: string | null) {
  return {
    ...payload,
    translatedText,
  };
}

export async function playHistoryItem(item: HistoryItem, listenLang: string, token?: string | null) {
  played.delete(item.id.split(":")[0]);
  return playReceived(
    {
      transmissionId: `${item.id}-tap`,
      mode: item.mode,
      audioUrl: item.audioUrl,
      originalText: item.originalText,
      translatedText: item.translatedText,
      speakLang: item.speakLang,
      language: item.language,
      kind: item.kind,
      durationMs: item.durationMs,
    },
    listenLang,
    token,
  );
}
