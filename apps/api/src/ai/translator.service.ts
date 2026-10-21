import { Injectable, Logger } from "@nestjs/common";
import type { VoiceGender } from "@talk/shared";
import { speechTag } from "./stt.service";
import { elevenVoicePlan } from "./tts.service";

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

type Turn = {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
};

@Injectable()
export class TranslatorService {
  private readonly logger = new Logger(TranslatorService.name);

  async run(input: {
    audio?: Buffer;
    mime?: string;
    ext?: string;
    text?: string;
    langA: string;
    langB: string;
    gender?: VoiceGender;
  }) {
    const langA = input.langA || "he";
    const langB = input.langB || "en";
    const gender = input.gender || "male";
    const empty = {
      sourceText: "",
      translatedText: "",
      sourceLang: langA,
      targetLang: langB,
      audioBase64: "",
      mime: "audio/mpeg" as const,
    };

    const started = Date.now();
    let turn: Turn | null = null;
    if (input.audio?.length) {
      turn = await this.hearAndTranslate(input.audio, input.mime || "audio/mp4", input.ext || "m4a", langA, langB);
    } else {
      const sourceText = (input.text || "").replace(/\s+/g, " ").trim();
      if (!sourceText) return empty;
      const sourceLang = clampLang(sourceText, langA, langB);
      const targetLang = sourceLang === langA ? langB : langA;
      const translatedText =
        sourceLang === targetLang ? sourceText : (await this.translateFast(sourceText, sourceLang, targetLang)) || sourceText;
      turn = { sourceText, translatedText, sourceLang, targetLang };
    }
    if (!turn?.sourceText) return empty;

    const audio = turn.translatedText ? await this.speakMp3(turn.translatedText, turn.targetLang, gender) : null;
    this.logger.log(
      `translator ${turn.sourceLang}->${turn.targetLang} ${Date.now() - started}ms chars=${turn.sourceText.length} audio=${audio ? audio.length : 0}`,
    );
    return {
      ...turn,
      audioBase64: audio ? audio.toString("base64") : "",
      mime: "audio/mpeg" as const,
    };
  }

  private async hearAndTranslate(
    audio: Buffer,
    mime: string,
    ext: string,
    langA: string,
    langB: string,
  ): Promise<Turn | null> {
    const tagA = speechTag(langA) || langA;
    const tagB = speechTag(langB) || langB;
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const prompt = [
      `Two-language interpreter. ALLOWED LANGUAGES ONLY: ${tagA} (${langA}) and ${tagB} (${langB}).`,
      "The speaker used exactly one of those two. Never detect, guess, or transcribe any other language.",
      "Write the transcript in that language's native script. Never transliterate Hebrew/Arabic into Latin letters.",
      "Then translate into the OTHER allowed language only.",
      `Return JSON: {"sourceLang":"${langA}"|"${langB}","sourceText":"...","translatedText":"...","confidence":{"${langA}":0,"${langB}":0}}`,
      `sourceLang MUST be ${langA} or ${langB}. confidence is 0-1 for those two languages only.`,
    ].join(" ");
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(7000),
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: geminiAudioMime(mime, ext), data: audio.toString("base64") } },
                ],
              },
            ],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 640,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      );
      if (!res.ok) {
        this.logger.warn(`translator gemini ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw =
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim() ?? "";
      const parsed = parseTurn(raw, langA, langB);
      if (!parsed?.sourceText) return null;
      if (!parsed.translatedText && parsed.sourceLang !== parsed.targetLang) {
        parsed.translatedText = (await this.translateFast(parsed.sourceText, parsed.sourceLang, parsed.targetLang)) || "";
      }
      this.logger.log(
        `translator-stt ${parsed.sourceLang} conf=${clip(JSON.stringify(parsed.sourceText))} -> ${clip(parsed.translatedText)}`,
      );
      return parsed;
    } catch (error) {
      this.logger.warn(`translator gemini ${(error as Error).message}`);
      return null;
    }
  }

  private async translateFast(text: string, source: string, target: string) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) return "";
    const prompt = `Translate from ${source} to ${target}. Reply with only the translation. No quotes, notes, or transliteration.\n\n${text}`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(geminiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(3500),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 512,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    );
    if (!res.ok) return "";
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .replace(/^["']|["']$/g, "")
        .trim() ?? ""
    );
  }

  private async speakMp3(text: string, lang: string, gender: VoiceGender) {
    const jobs = [this.viaOpenAiMp3(text, gender), this.viaElevenMp3(text, lang, gender)];
    try {
      return await Promise.any(
        jobs.map(async (job) => {
          const buffer = await job;
          if (!buffer?.length) throw new Error("empty");
          return buffer;
        }),
      );
    } catch {
      return null;
    }
  }

  private async viaOpenAiMp3(text: string, gender: VoiceGender) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(3500),
      body: JSON.stringify({
        model: "tts-1",
        input: text.slice(0, 4000),
        voice: OPENAI_VOICE[gender] || "onyx",
        response_format: "mp3",
        speed: 1.05,
      }),
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length ? buffer : null;
  }

  private async viaElevenMp3(text: string, lang: string, gender: VoiceGender) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return null;
    const plan = elevenVoicePlan(lang);
    const id = ELEVEN_VOICE[gender] || ELEVEN_VOICE.male;
    const body: Record<string, unknown> = {
      text: text.slice(0, 4000),
      model_id: plan.model,
      voice_settings: { stability: 0.45, similarity_boost: 0.7 },
    };
    if (plan.code) body.language_code = plan.code;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_22050_32`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      signal: AbortSignal.timeout(3500),
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length ? buffer : null;
  }
}

function parseTurn(raw: string, langA: string, langB: string): Turn | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(trimmed.slice(start, end + 1)) as {
      sourceLang?: string;
      language?: string;
      sourceText?: string;
      text?: string;
      translatedText?: string;
      confidence?: Record<string, number>;
    };
    const sourceText = String(data.sourceText || data.text || "").replace(/\s+/g, " ").trim();
    if (!sourceText) return null;
    const sourceLang = clampLang(sourceText, langA, langB, data.sourceLang || data.language);
    const targetLang = sourceLang === langA ? langB : langA;
    const translatedText = String(data.translatedText || "").replace(/\s+/g, " ").trim();
    void data.confidence;
    return { sourceText, translatedText, sourceLang, targetLang };
  } catch {
    return null;
  }
}

function clampLang(text: string, langA: string, langB: string, claimed?: string) {
  const claim = String(claimed || "").slice(0, 2).toLowerCase();
  if (distinctiveScript(text, langA) && !distinctiveScript(text, langB)) return langA;
  if (distinctiveScript(text, langB) && !distinctiveScript(text, langA)) return langB;
  if (claim === langA || claim === langB) return claim;
  return langA;
}

function scriptFamily(lang: string) {
  if (lang === "he") return "he";
  if (lang === "ar" || lang === "fa" || lang === "ur") return "ar";
  if (lang === "ru" || lang === "uk" || lang === "bg") return "cy";
  if (lang === "hi" || lang === "bn" || lang === "ta") return "in";
  if (lang === "zh" || lang === "ja" || lang === "ko") return "cjk";
  if (lang === "am") return "am";
  if (lang === "ka") return "ka";
  return "latin";
}

function distinctiveScript(text: string, lang: string) {
  const family = scriptFamily(lang);
  const match =
    family === "he"
      ? /[\u0590-\u05FF]/.test(text)
      : family === "ar"
        ? /[\u0600-\u06FF]/.test(text)
        : family === "cy"
          ? /[\u0400-\u04FF]/.test(text)
          : family === "in"
            ? /[\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF]/.test(text)
            : family === "cjk"
              ? /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text)
              : family === "am"
                ? /[\u1200-\u137F]/.test(text)
                : family === "ka"
                  ? /[\u10A0-\u10FF]/.test(text)
                  : /[A-Za-zÀ-ÿ]/.test(text) && !/[\u0590-\u05FF\u0600-\u06FF]/.test(text);
  return match;
}

function geminiAudioMime(mime: string, ext: string) {
  const kind = (mime || "").toLowerCase();
  const suffix = (ext || "").toLowerCase();
  if (kind.includes("webm") || suffix === "webm") return "audio/webm";
  if (kind.includes("wav") || suffix === "wav") return "audio/wav";
  if (kind.includes("mpeg") || kind.includes("mp3") || suffix === "mp3") return "audio/mp3";
  if (kind.includes("ogg") || suffix === "ogg" || suffix === "oga") return "audio/ogg";
  return "audio/mp4";
}

function clip(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}
