import { Injectable, Logger } from "@nestjs/common";
import { PttCaptionPayload, VoiceGender } from "@talk/shared";
import { SttService } from "../ai/stt.service";
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
  pressId: string;
};

const FRAME_MS = 20;
const LOUD = 600;
const RELEASE_MIN_MS = 280;

/**
 * Same language stays raw PCM, sent once when the button is released.
 * A different listen language keeps every frame of that press and is translated
 * once, on release, as one complete clip. Nothing is sent to Gemini while the
 * button is still down. FREE sends the full caption. PLUS attaches the voice file
 * to that same caption.
 */
@Injectable()
export class LiveDubService {
  private readonly logger = new Logger(LiveDubService.name);
  private readonly presses = new Map<string, Press>();
  private emit: (userId: string, payload: PttCaptionPayload) => void = () => undefined;
  private lockOriginal: (userId: string, speakerId: string, translate: boolean) => void = () => undefined;
  private emitPcm: (userId: string, speakerId: string, pcm: string, seq: number) => void = () => undefined;
  private staleLogAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stt: SttService,
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

  owns(socketId: string, pressId: string) {
    const press = this.presses.get(socketId);
    if (!press) return true;
    if (press.closed) return false;
    if (pressId && press.pressId && press.pressId !== pressId) return false;
    return true;
  }

  open(socketId: string, speakerId: string, targetIds: string[], pressId = "", fresh = false) {
    const ids = [...new Set(targetIds.filter((id) => id && id !== speakerId))];
    const id = pressId.trim();
    let press = this.presses.get(socketId);
    if (press && id && press.pressId !== id) {
      if (!fresh) return;
      const leftover = press.chunks.reduce((sum, frame) => sum + frame.length, 0);
      this.logger.log(`live dub replace old=${press.pressId} new=${id} leftoverBytes=${leftover}`);
      this.finish(socketId);
      press = undefined;
    }
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
        pressId: id,
      };
      this.presses.set(socketId, press);
      this.logger.log(`live dub new press=${id || "-"} speaker=${speakerId} bytes=0`);
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

  push(socketId: string, pcm: Buffer, pressId = "") {
    const press = this.presses.get(socketId);
    if (!press || pcm.length < 2 || press.closed || (pressId && press.pressId && press.pressId !== pressId)) {
      if (pcm.length >= 2 && press && (press.closed || (pressId && press.pressId !== pressId))) this.noteStale(pressId, press);
      return;
    }
    press.chunks.push(pcm);
    if (!press.ready) press.relayBacklog.push(pcm);
    if (rms(pcm) >= LOUD) press.speechMs += FRAME_MS;
  }

  finish(socketId: string, pressId = "") {
    const press = this.presses.get(socketId);
    if (!press) return;
    if (pressId && press.pressId && press.pressId !== pressId) {
      this.logger.warn(`live dub ignore release press=${pressId} current=${press.pressId}`);
      return;
    }
    press.closed = true;
    void this.enqueue(press).finally(() => {
      if (this.presses.get(socketId) === press) this.presses.delete(socketId);
    });
  }

  private noteStale(pressId: string, press: Press) {
    const now = Date.now();
    if (now - this.staleLogAt < 1000) return;
    this.staleLogAt = now;
    const bytes = press.chunks.reduce((sum, frame) => sum + frame.length, 0);
    this.logger.warn(
      `live dub drop stale press=${pressId || "-"} current=${press.pressId || "-"} closed=${press.closed} keptBytes=${bytes}`,
    );
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
      void this.enqueue(press);
    }
    this.logger.log(
      `live dub open speaker=${speakerId} lang=${speakLang} relay=${[...relay].join(",") || "-"} dub=${dub.map((ear) => `${ear.userId}:${ear.listenLang}:${ear.mode}`).join(",") || "-"}`,
    );
  }

  private enqueue(press: Press) {
    const run = press.flushing.then(() => this.speakPhrase(press));
    press.flushing = run.catch((error: Error) => {
      this.logger.warn(`live dub phrase failed: ${error.message}`);
    });
    return press.flushing;
  }

  private async speakPhrase(press: Press) {
    if (!press.ready) return;
    if (!press.dub.length || press.speechMs < RELEASE_MIN_MS || !press.chunks.length) {
      press.chunks = [];
      press.speechMs = 0;
      press.silenceMs = 0;
      return;
    }
    const chunks = press.chunks;
    const speechMs = press.speechMs;
    press.chunks = [];
    press.speechMs = 0;
    press.silenceMs = 0;
    const pcm = clipSpeech(Buffer.concat(chunks));
    const heard = pcmStats(pcm);
    this.logger.log(
      `live dub audio press=${press.pressId || "-"} format=audio/wav rate=16000 ch=1 pcm16 bytes=${pcm.length} sec=${(heard.durMs / 1000).toFixed(2)} rms=${Math.round(heard.rms)} peak=${Math.round(heard.peak)} loudMs=${speechMs} reason=release`,
    );
    const byLang = new Map<string, Ear[]>();
    for (const ear of press.dub) {
      const list = byLang.get(ear.listenLang) ?? [];
      list.push(ear);
      byLang.set(ear.listenLang, list);
    }
    press.seq += 1;
    const seq = press.seq;
    if (pcm.length < 3200 || heard.peak < LOUD || heard.durMs < 280) {
      this.logger.warn(`live dub skip noise bytes=${pcm.length} peak=${Math.round(heard.peak)} durMs=${heard.durMs}`);
      this.emitLine(press, byLang, seq, "[unclear]");
      return;
    }
    const wav = wavBytes(pcm);
    await Promise.all(
      [...byLang.entries()].map(async ([listenLang, ears]) => {
      const started = Date.now();
      const raw = (await this.stt.translateAudio(wav, listenLang, "audio/wav", "wav")).trim();
      const line = captionLine(raw);
      this.logger.log(
        `live dub phrase reason=release ms=${speechMs} gemini=${Date.now() - started}ms lang=${listenLang} "${line}"`,
      );
      await this.deliver(press, ears, seq, listenLang, line);
      }),
    );
  }

  private emitLine(press: Press, byLang: Map<string, Ear[]>, seq: number, text: string) {
    for (const [listenLang, ears] of byLang) void this.deliver(press, ears, seq, listenLang, text);
  }

  private async deliver(press: Press, ears: Ear[], seq: number, listenLang: string, line: string) {
    await Promise.all(
      ears.map(async (ear) => {
        const unclear = line === "[unclear]";
        let audioUrl: string | null = null;
        if (!unclear && ear.mode === "plus") {
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
          `live dub out user=${ear.userId} mode=${audioUrl ? "plus" : "free"} lang=${listenLang} seq=${seq} "${line}"`,
        );
      }),
    );
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

function pcmStats(pcm: Buffer) {
  const n = Math.floor(pcm.length / 2);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2));
    if (v > peak) peak = v;
    sum += v * v;
  }
  return { peak, rms: n ? Math.sqrt(sum / n) : 0, durMs: Math.round(n / 16) };
}

/** Drop leading and trailing silence, but keep a short tail so the last word is complete. */
function clipSpeech(pcm: Buffer) {
  const frame = 640;
  const frames: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += frame) frames.push(pcm.subarray(i, Math.min(i + frame, pcm.length)));
  let first = -1;
  let last = -1;
  for (let i = 0; i < frames.length; i++) {
    if (rms(frames[i]) >= LOUD) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return Buffer.alloc(0);
  const start = Math.max(0, first - 4);
  const end = Math.min(frames.length, last + 1 + 12);
  return Buffer.concat(frames.slice(start, end));
}

function captionLine(raw: string) {
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line || /^\[?\s*unclear\s*\]?$/i.test(line) || /^nothing\.?$/i.test(line)) return "[unclear]";
  return line;
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
