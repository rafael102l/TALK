import { Injectable, Logger } from "@nestjs/common";
import { VoiceGender } from "@talk/shared";
import { StorageService } from "../storage/storage.service";

const OPENAI_VOICE: Record<VoiceGender, string> = {
  male: "onyx",
  female: "nova",
  child: "fable",
};

const ELEVEN_VOICE: Record<VoiceGender, string> = {
  male: "JBFqnCBsd6RMkjVDRZzb",
  female: "EXAVITQu4vr4xnSDxMaL",
  child: "FGY2WhTYpPnrIDTdsKH5",
};

/** Prefer Eleven+language_code for these — OpenAI Hebrew often sounds American-accented. */
const PREFER_ELEVEN_NATIVE = new Set(["he", "ar", "fa", "ur", "hi", "th", "am", "ka", "bn", "ta", "ru", "uk"]);

/** Flash v2.5 accepts these language_code values. Filipino is `fil`, not `tl`. */
const FLASH_CODES = new Set([
  "ar",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fil",
  "fr",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sv",
  "ta",
  "tr",
  "uk",
  "vi",
  "zh",
]);

/** eleven_v3 covers the rest of the walkie list, except Amharic. */
const WIDE_CODES = new Set([
  ...FLASH_CODES,
  "he",
  "fa",
  "ur",
  "bn",
  "ka",
  "th",
  "sw",
]);

export function elevenVoicePlan(language: string) {
  const two = (language || "").slice(0, 2).toLowerCase();
  const code = two === "tl" ? "fil" : two;
  const flash = process.env.ELEVENLABS_TTS_MODEL_MULTI || process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
  const wide = process.env.ELEVENLABS_TTS_MODEL_WIDE || "eleven_v3";
  if (!code || code === "en") return { model: process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5", code: "" };
  if (FLASH_CODES.has(code)) return { model: flash, code };
  if (WIDE_CODES.has(code)) return { model: wide, code };
  return { model: wide, code: "" };
}

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  constructor(private readonly storage: StorageService) {}

  async speak(
    text: string,
    language: string,
    voiceId?: string | null,
    gender: VoiceGender = "male",
    opts: { allowEleven?: boolean; timeoutMs?: number; preferEleven?: boolean } = {},
  ): Promise<string | null> {
    const clean = normalizeSpeechText(text);
    if (!clean) return null;
    const started = Date.now();
    const timeoutMs = Math.max(opts.timeoutMs ?? 2500, 2500);
    const lang = (language || "").slice(0, 2).toLowerCase();
    const allowEleven = opts.allowEleven !== false;
    const native = PREFER_ELEVEN_NATIVE.has(lang);
    const preferEleven =
      allowEleven && (native || opts.preferEleven !== false || Boolean(voiceId && !voiceId.startsWith("mock-")));

    if (preferEleven) {
      const eleven = await this.viaEleven(clean, voiceId, gender, Math.max(timeoutMs, 7000), lang).catch(
        (error) => {
          this.logger.warn(`ElevenLabs TTS ${(error as Error).message}`);
          return null as string | null;
        },
      );
      if (eleven) {
        this.logger.log(`TTS eleven ${lang} ${Date.now() - started}ms chars=${clean.length}`);
        return eleven;
      }
    }

    const openai = await this.viaOpenAi(clean, gender, Math.max(timeoutMs, 8000)).catch((error) => {
      this.logger.warn(`OpenAI TTS ${(error as Error).message}`);
      return null as string | null;
    });
    if (openai) {
      this.logger.log(`TTS openai ${lang} ${Date.now() - started}ms chars=${clean.length}`);
      return openai;
    }

    if (allowEleven && !preferEleven) {
      const eleven = await this.viaEleven(clean, voiceId, gender, timeoutMs, lang).catch((error) => {
        this.logger.warn(`ElevenLabs TTS ${(error as Error).message}`);
        return null as string | null;
      });
      if (eleven) {
        this.logger.log(`TTS eleven ${lang} ${Date.now() - started}ms chars=${clean.length}`);
        return eleven;
      }
    }
    return null;
  }

  private async viaOpenAi(text: string, gender: VoiceGender, timeoutMs = 6000) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1-hd",
        input: text.slice(0, 4000),
        voice: OPENAI_VOICE[gender] || "onyx",
        response_format: "mp3",
        speed: 1.0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      this.logger.warn(`OpenAI TTS failed: ${res.status}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return null;
    return this.storage.save(buffer, "mp3", "renders");
  }

  private async viaEleven(
    text: string,
    voiceId: string | null | undefined,
    gender: VoiceGender,
    timeoutMs = 6000,
    language = "",
  ) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return null;
    const plan = elevenVoicePlan(language);
    const model = plan.model;
    const id =
      voiceId && !voiceId.startsWith("mock-") ? voiceId : ELEVEN_VOICE[gender] || ELEVEN_VOICE.male;
    const body: Record<string, unknown> = {
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    };
    if (plan.code) body.language_code = plan.code;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.logger.warn(`ElevenLabs TTS ${model} failed: ${res.status}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return null;
    return this.storage.save(buffer, "mp3", "renders");
  }
}

function normalizeSpeechText(text: string) {
  return (text || "")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
