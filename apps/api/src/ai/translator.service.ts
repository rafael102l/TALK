import { Injectable, Logger } from "@nestjs/common";
import type { VoiceGender } from "@talk/shared";
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

@Injectable()
export class TranslatorService {
  private readonly logger = new Logger(TranslatorService.name);

  async run(text: string, langA: string, langB: string, gender: VoiceGender = "male") {
    const sourceText = (text || "").replace(/\s+/g, " ").trim();
    if (!sourceText) {
      return {
        sourceText: "",
        translatedText: "",
        sourceLang: langA,
        targetLang: langB,
        audioBase64: "",
        mime: "audio/mpeg",
      };
    }

    const started = Date.now();
    const sourceLang = pickSpokenLang(sourceText, langA, langB);
    const targetLang = sourceLang === langA ? langB : langA;
    const translatedText =
      sourceLang === targetLang ? sourceText : (await this.translateFast(sourceText, sourceLang, targetLang)) || sourceText;
    const audio = translatedText ? await this.speakMp3(translatedText, targetLang, gender) : null;

    this.logger.log(
      `translator ${sourceLang}->${targetLang} ${Date.now() - started}ms chars=${sourceText.length} audio=${audio ? audio.length : 0}`,
    );
    return {
      sourceText,
      translatedText,
      sourceLang,
      targetLang,
      audioBase64: audio ? audio.toString("base64") : "",
      mime: "audio/mpeg" as const,
    };
  }

  private async translateFast(text: string, source: string, target: string) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const gemini = await this.viaGemini(text, source, target, geminiKey).catch((error) => {
        this.logger.warn(`translator gemini ${(error as Error).message}`);
        return "";
      });
      if (gemini) return gemini;
    }
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return "";
    return this.viaOpenAiTranslate(text, source, target, openaiKey).catch((error) => {
      this.logger.warn(`translator openai-translate ${(error as Error).message}`);
      return "";
    });
  }

  private async viaGemini(text: string, source: string, target: string, key: string) {
    const prompt = `Translate from ${source} to ${target}. Reply with only the translation. No quotes, notes, or transliteration.\n\n${text}`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(4000),
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
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .replace(/^["']|["']$/g, "")
        .trim() ?? ""
    );
  }

  private async viaOpenAiTranslate(text: string, source: string, target: string, key: string) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: `Translate from ${source} to ${target}. Reply with only the translation.`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content || "").replace(/^["']|["']$/g, "").trim();
  }

  private async speakMp3(text: string, lang: string, gender: VoiceGender) {
    const openai = this.viaOpenAiMp3(text, gender);
    const eleven = this.viaElevenMp3(text, lang, gender);
    try {
      return await Promise.any(
        [openai, eleven].map(async (job) => {
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
      signal: AbortSignal.timeout(4500),
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
      signal: AbortSignal.timeout(4500),
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length ? buffer : null;
  }
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

function scriptHits(text: string, lang: string) {
  const family = scriptFamily(lang);
  const match =
    family === "he"
      ? text.match(/[\u0590-\u05FF]/g)
      : family === "ar"
        ? text.match(/[\u0600-\u06FF]/g)
        : family === "cy"
          ? text.match(/[\u0400-\u04FF]/g)
          : family === "in"
            ? text.match(/[\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF]/g)
            : family === "cjk"
              ? text.match(/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g)
              : family === "am"
                ? text.match(/[\u1200-\u137F]/g)
                : family === "ka"
                  ? text.match(/[\u10A0-\u10FF]/g)
                  : text.match(/[A-Za-zÀ-ÿ]/g);
  return match?.length ?? 0;
}

function scoreTranscript(text: string, lang: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return -1;
  const hits = scriptHits(clean, lang);
  const foreign =
    scriptFamily(lang) === "latin"
      ? (clean.match(/[\u0590-\u05FF\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF]/g) || []).length
      : (clean.match(/[A-Za-z]/g) || []).length;
  return hits * 4 + Math.min(clean.length, 80) - foreign * 3;
}

function pickSpokenLang(text: string, langA: string, langB: string) {
  if (langA === langB) return langA;
  const scoreA = scoreTranscript(text, langA);
  const scoreB = scoreTranscript(text, langB);
  if (scoreB > scoreA) return langB;
  return langA;
}
