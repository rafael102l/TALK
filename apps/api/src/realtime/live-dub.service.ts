import { Injectable, Logger } from "@nestjs/common";
import { PttCaptionPayload, VoiceGender } from "@talk/shared";
import { SttService } from "../ai/stt.service";
import { TranslateService } from "../ai/translate.service";
import { TtsService } from "../ai/tts.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

type Ear = {
  userId: string;
  listenLang: string;
  mode: "free" | "plus";
  voiceId: string | null;
  gender: VoiceGender;
};

type Press = {
  socketId: string;
  speakerId: string;
  speakLang: string;
  speakerGender: VoiceGender;
  relay: Set<string>;
  dub: Ear[];
  chunks: Buffer[];
  /** PCM held until languages are known. Same-language ears get it; translated ears never do. */
  relayBacklog: Buffer[];
  speechMs: number;
  silenceMs: number;
  seq: number;
  flushing: Promise<void>;
  closed: boolean;
  ready: boolean;
  loading: boolean;
  targetIds: string[];
};

const FRAME_MS = 20;
const LOUD = 600;
const MIN_SPEECH_MS = 700;
const SILENCE_MS = 380;
const MAX_SPEECH_MS = 3200;
const RELEASE_MIN_MS = 280;

/**
 * Live PTT stays raw PCM when both people share a language.
 * A different listen language is buffered to a pause (or a short cap) and then
 * translated. FREE sends text. PLUS also speaks it in the sender's cloned voice.
 * The plan flag is read once per press, not on every 20ms frame.
 */
@Injectable()
export class LiveDubService {
  private readonly logger = new Logger(LiveDubService.name);
  private readonly presses = new Map<string, Press>();
  private emit: (userId: string, payload: PttCaptionPayload) => void = () => undefined;
  private lockOriginal: (userId: string, speakerId: string, translate: boolean) => void = () => undefined;
  private emitPcm: (userId: string, speakerId: string, pcm: string, seq: number) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stt: SttService,
    private readonly translate: TranslateService,
    private readonly tts: TtsService,
    private readonly storage: StorageService,
  ) {}

  attach(handlers: {
    caption: (userId: string, payload: PttCaptionPayload) => void;
    lock: (userId: string, speakerId: string, translate: boolean) => void;
    pcm: (userId: string, speakerId: string, pcm: string, seq: number) => void;
  }) {
    this.emit = handlers.caption;
    this.lockOriginal = handlers.lock;
    this.emitPcm = handlers.pcm;
  }

  /**
   * Raw PCM targets.
   * pending: languages not loaded — emit nothing.
   * Otherwise only same-language listeners. Translated listeners are omitted.
   */
  route(socketId: string, targets: string[]): { pending: boolean; relay: string[]; dub: number } {
    const press = this.presses.get(socketId);
    if (!press) return { pending: false, relay: targets, dub: 0 };
    if (!press.ready) return { pending: true, relay: [], dub: targets.length };
    const relay = targets.filter((id) => press.relay.has(id));
    const dub = targets.filter((id) => press.dub.some((ear) => ear.userId === id)).length;
    return { pending: false, relay, dub };
  }

  open(socketId: string, speakerId: string, targetIds: string[]) {
    const ids = [...new Set(targetIds.filter((id) => id && id !== speakerId))];
    let press = this.presses.get(socketId);
    if (!press) {
      press = {
        socketId,
        speakerId,
        speakLang: "",
        speakerGender: "male",
        relay: new Set(),
        dub: [],
        chunks: [],
        relayBacklog: [],
        speechMs: 0,
        silenceMs: 0,
        seq: 0,
        flushing: Promise.resolve(),
        closed: false,
        ready: false,
        loading: false,
        targetIds: ids,
      };
      this.presses.set(socketId, press);
    } else if (ids.length) {
      press.targetIds = [...new Set([...press.targetIds, ...ids])];
    }
    if (press.ready || press.loading) return;
    press.loading = true;
    void this.load(press, press.targetIds)
      .catch((error: Error) => {
        this.logger.warn(`live dub open failed: ${error.message}`);
        press.ready = true;
        press.relay = new Set(press.targetIds);
        press.dub = [];
        this.releaseBacklog(press);
      })
      .finally(() => {
        press.loading = false;
      });
  }

  push(socketId: string, pcm: Buffer) {
    const press = this.presses.get(socketId);
    if (!press || pcm.length < 2) return;
    press.chunks.push(pcm);
    if (!press.ready) press.relayBacklog.push(pcm);
    if (rms(pcm) >= LOUD) {
      press.speechMs += FRAME_MS;
      press.silenceMs = 0;
    } else {
      press.silenceMs += FRAME_MS;
    }
    if (!press.ready || !press.dub.length) return;
    const phrase = press.speechMs >= MIN_SPEECH_MS && press.silenceMs >= SILENCE_MS;
    const cap = press.speechMs >= MAX_SPEECH_MS;
    if (phrase || cap) void this.enqueue(press, phrase ? "silence" : "cap");
  }

  finish(socketId: string) {
    const press = this.presses.get(socketId);
    if (!press) return;
    press.closed = true;
    void this.enqueue(press, "release").finally(() => {
      if (this.presses.get(socketId) === press) this.presses.delete(socketId);
    });
  }

  private releaseBacklog(press: Press) {
    const frames = press.relayBacklog;
    press.relayBacklog = [];
    let seq = 0;
    for (const frame of frames) {
      const pcm = frame.toString("base64");
      for (const userId of press.relay) this.emitPcm(userId, press.speakerId, pcm, seq);
      seq += 1;
    }
  }

  private async load(press: Press, targetIds: string[]) {
    const speakerId = press.speakerId;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [speakerId, ...targetIds] } },
      select: {
        id: true,
        speakLang: true,
        listenLang: true,
        plan: true,
        elevenVoiceId: true,
        voiceCloneStatus: true,
        voiceGender: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const speaker = byId.get(speakerId);
    const speakLang = langOf(speaker?.speakLang || speaker?.listenLang);
    const speakerGender = genderOf(speaker?.voiceGender);
    const relay = new Set<string>();
    const dub: Ear[] = [];
    for (const id of targetIds) {
      const row = byId.get(id);
      const listenLang = langOf(row?.listenLang || row?.speakLang);
      if (!listenLang || listenLang === speakLang) {
        relay.add(id);
        continue;
      }
      const plus = row?.plan === "PLUS";
      const voiceId =
        plus && row?.voiceCloneStatus === "READY" && row.elevenVoiceId && !row.elevenVoiceId.startsWith("mock-")
          ? row.elevenVoiceId
          : null;
      dub.push({
        userId: id,
        listenLang,
        mode: plus ? "plus" : "free",
        voiceId,
        gender: speakerGender,
      });
    }
    press.speakLang = speakLang;
    press.speakerGender = speakerGender;
    press.relay = relay;
    press.dub = dub;
    press.ready = true;
    for (const ear of dub) this.lockOriginal(ear.userId, speakerId, true);
    for (const id of relay) this.lockOriginal(id, speakerId, false);
    this.releaseBacklog(press);
    if (!dub.length) {
      press.chunks = [];
      press.speechMs = 0;
      press.silenceMs = 0;
    } else if (press.closed) {
      void this.enqueue(press, "release");
    } else if (
      (press.speechMs >= MIN_SPEECH_MS && press.silenceMs >= SILENCE_MS) ||
      press.speechMs >= MAX_SPEECH_MS
    ) {
      void this.enqueue(press, press.silenceMs >= SILENCE_MS ? "silence" : "cap");
    }
    this.logger.log(
      `live dub open speaker=${speakerId} lang=${speakLang} relay=${[...relay].join(",") || "-"} dub=${dub.map((ear) => `${ear.userId}:${ear.listenLang}:${ear.mode}`).join(",") || "-"}`,
    );
  }

  private enqueue(press: Press, reason: "silence" | "cap" | "release") {
    const run = press.flushing.then(() => this.speakPhrase(press, reason));
    press.flushing = run.catch((error: Error) => {
      this.logger.warn(`live dub phrase failed: ${error.message}`);
    });
    return press.flushing;
  }

  private async speakPhrase(press: Press, reason: "silence" | "cap" | "release") {
    if (!press.ready) return;
    const min = reason === "release" ? RELEASE_MIN_MS : MIN_SPEECH_MS;
    if (!press.dub.length || press.speechMs < min || !press.chunks.length) {
      if (reason === "release") {
        press.chunks = [];
        press.speechMs = 0;
        press.silenceMs = 0;
      }
      return;
    }
    const chunks = press.chunks;
    const speechMs = press.speechMs;
    press.chunks = [];
    press.speechMs = 0;
    press.silenceMs = 0;
    const wav = wavBytes(Buffer.concat(chunks));
    const heard = await this.stt.transcribeBytes(wav, press.speakLang, "audio/wav", "wav");
    const text = (heard.text || "").trim();
    this.logger.log(`live dub phrase reason=${reason} ms=${speechMs} lang=${heard.lang || press.speakLang} "${text.slice(0, 80)}"`);
    if (!text) return;
    const source = heard.lang || press.speakLang;
    const byLang = new Map<string, Ear[]>();
    for (const ear of press.dub) {
      const list = byLang.get(ear.listenLang) ?? [];
      list.push(ear);
      byLang.set(ear.listenLang, list);
    }
    press.seq += 1;
    const seq = press.seq;
    for (const [listenLang, ears] of byLang) {
      const translated = await this.translate.translate(text, source, listenLang);
      const line = (translated.text || "").trim();
      if (!line) continue;
      await Promise.all(
        ears.map(async (ear) => {
          let audioUrl: string | null = null;
          if (ear.mode === "plus") {
            const saved = await this.tts.speak(line, listenLang, ear.voiceId, ear.gender, {
              allowEleven: true,
              preferEleven: true,
              timeoutMs: 8000,
            });
            audioUrl = saved ? this.storage.publicUrl(saved) : null;
          }
          this.emit(ear.userId, {
            speakerId: press.speakerId,
            seq,
            text: line,
            lang: listenLang,
            mode: audioUrl ? "plus" : "free",
            audioUrl,
            voiceGender: ear.gender,
          });
          this.logger.log(
            `live dub out user=${ear.userId} mode=${audioUrl ? "plus" : "free"} lang=${listenLang} seq=${seq}`,
          );
        }),
      );
    }
  }
}

function langOf(value?: string | null) {
  return (value || "").slice(0, 2).toLowerCase();
}

function genderOf(value?: string | null): VoiceGender {
  return value === "female" || value === "child" ? value : "male";
}

function rms(pcm: Buffer) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

function wavBytes(pcm: Buffer, sampleRate = 16000) {
  const dataLen = pcm.length - (pcm.length % 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm.subarray(0, dataLen)]);
}
