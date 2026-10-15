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
  speechMs: number;
  silenceMs: number;
  seq: number;
  flushing: Promise<void>;
  closed: boolean;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly stt: SttService,
    private readonly translate: TranslateService,
    private readonly tts: TtsService,
    private readonly storage: StorageService,
  ) {}

  attach(emit: (userId: string, payload: PttCaptionPayload) => void) {
    this.emit = emit;
  }

  /** null = languages not loaded yet, so the caller keeps the raw relay. */
  relayIds(socketId: string, targets: string[]): string[] | null {
    const press = this.presses.get(socketId);
    if (!press) return null;
    return targets.filter((id) => press.relay.has(id) || !press.dub.some((ear) => ear.userId === id));
  }

  dubCount(socketId: string, targets: string[]) {
    const press = this.presses.get(socketId);
    if (!press) return 0;
    return targets.filter((id) => press.dub.some((ear) => ear.userId === id)).length;
  }

  open(socketId: string, speakerId: string, targetIds: string[]) {
    const ids = [...new Set(targetIds.filter((id) => id && id !== speakerId))];
    void this.load(socketId, speakerId, ids).catch((error: Error) => {
      this.logger.warn(`live dub open failed: ${error.message}`);
    });
  }

  push(socketId: string, pcm: Buffer) {
    const press = this.presses.get(socketId);
    if (!press?.dub.length || pcm.length < 2) return;
    press.chunks.push(pcm);
    if (rms(pcm) >= LOUD) {
      press.speechMs += FRAME_MS;
      press.silenceMs = 0;
    } else {
      press.silenceMs += FRAME_MS;
    }
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

  private async load(socketId: string, speakerId: string, targetIds: string[]) {
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
    const previous = this.presses.get(socketId);
    this.presses.set(socketId, {
      socketId,
      speakerId,
      speakLang,
      speakerGender,
      relay,
      dub,
      chunks: previous?.chunks ?? [],
      speechMs: previous?.speechMs ?? 0,
      silenceMs: previous?.silenceMs ?? 0,
      seq: previous?.seq ?? 0,
      flushing: previous?.flushing ?? Promise.resolve(),
      closed: false,
    });
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
