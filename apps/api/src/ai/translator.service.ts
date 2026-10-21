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

const GEMINI_TRANSLATE_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
];

const STRICT_TRANSLATE =
  "You are a strict word-for-word translator. Translate ONLY the user's spoken input into the target language. Do NOT add any pleasantries, notes, context, corrections, or explanations. Return ONLY the direct translation.";

type Turn = {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
};

@Injectable()
export class TranslatorService {
  private readonly logger = new Logger(TranslatorService.name);

  async transcribe(input: {
    audio?: Buffer;
    mime?: string;
    ext?: string;
    text?: string;
    langA: string;
    langB: string;
  }): Promise<Turn> {
    const langA = input.langA || "he";
    const langB = input.langB || "en";
    const empty = { sourceText: "", translatedText: "", sourceLang: langA, targetLang: langB };
    if (input.audio?.length) {
      return (await this.hearAndTranslate(input.audio, input.mime || "audio/mp4", input.ext || "m4a", langA, langB)) || empty;
    }
    const sourceText = (input.text || "").replace(/\s+/g, " ").trim();
    if (!sourceText) return empty;
    const sourceLang = pairLang("", sourceText, langA, langB);
    const targetLang = sourceLang === langA ? langB : langA;
    return this.finishTurn(sourceText, sourceLang, targetLang);
  }

  async runTurn(input: {
    audio?: Buffer;
    mime?: string;
    ext?: string;
    langA: string;
    langB: string;
    gender?: VoiceGender;
  }) {
    const langA = input.langA || "he";
    const langB = input.langB || "en";
    const turn = await this.transcribe({
      audio: input.audio,
      mime: input.mime,
      ext: input.ext,
      langA,
      langB,
    });
    const sourceLang = turn.sourceLang === langB ? langB : langA;
    const targetLang = sourceLang === langA ? langB : langA;
    const sourceText = (turn.sourceText || "").replace(/\s+/g, " ").trim();
    const translatedText = (turn.translatedText || "").replace(/\s+/g, " ").trim();
    const spoken =
      translatedText && translatedText !== sourceText && !isSourceLanguageText(translatedText, sourceLang, targetLang)
        ? translatedText
        : "";
    let audio: Buffer | null = null;
    if (spoken) {
      try {
        audio = await this.speakTranslation(spoken, targetLang, input.gender || "male");
      } catch {
        audio = null;
      }
    }
    return {
      sourceText,
      translatedText,
      sourceLang,
      targetLang,
      audioBase64: audio?.length ? audio.toString("base64") : "",
      mime: "audio/mpeg" as const,
    };
  }

  private speakTranslation(translatedText: string, targetLang: string, gender: VoiceGender) {
    return this.speakMp3(translatedText, targetLang, gender);
  }

  private async hearAndTranslate(
    audio: Buffer,
    mime: string,
    ext: string,
    langA: string,
    langB: string,
  ): Promise<Turn | null> {
    const [heard, gemini] = await Promise.all([
      this.whisperAuto(audio, mime, ext, langA, langB),
      this.geminiHear(audio, mime, ext, langA, langB),
    ]);
    let text = "";
    let detected = "";
    if (gemini?.text) {
      text = gemini.text;
      detected = gemini.sourceLang;
    } else if (heard.text) {
      text = heard.text;
      detected = heard.language;
    }
    if (!text) return null;
    const audioLang = whisperLangCode(detected);
    const audioInPair = audioLang === langB ? langB : audioLang === langA ? langA : "";
    if (audioInPair && uniqueScript(audioInPair) && !hasScript(text, audioInPair)) {
      const locked = await this.whisperFor(audio, audioInPair, mime, ext);
      if (hasScript(locked.text, audioInPair)) {
        text = locked.text;
        detected = audioInPair;
      }
    }
    const sourceLang = pairLang(detected, text, langA, langB);
    const targetLang = sourceLang === langA ? langB : langA;
    this.logger.log(`translator-detect ${detected || "?"} => ${sourceLang}->${targetLang} ${clip(text)}`);
    return this.finishTurn(text, sourceLang, targetLang);
  }

  private async whisperAuto(audio: Buffer, mime: string, ext: string, langA: string, langB: string) {
    const empty = { text: "", language: "" };
    const key = process.env.OPENAI_API_KEY;
    if (!key || !audio.length) return empty;
    try {
      const tagA = speechTag(langA) || langA;
      const tagB = speechTag(langB) || langB;
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext || "m4a"}`);
      form.append("model", "whisper-1");
      form.append("temperature", "0");
      form.append("response_format", "verbose_json");
      form.append(
        "prompt",
        `The speaker uses ${tagA} or ${tagB}. Transcribe exactly in the original language. Do not translate.`,
      );
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`translator whisper auto failed: ${res.status}`);
        return empty;
      }
      const data = (await res.json()) as {
        text?: string;
        language?: string;
      };
      const text = sanitizeTranscript((data.text || "").replace(/\s+/g, " ").trim());
      return { text, language: (data.language || "").trim().toLowerCase() };
    } catch (error) {
      this.logger.warn(`translator whisper auto ${(error as Error).message}`);
      return empty;
    }
  }

  private async whisperFor(audio: Buffer, lang: string, mime: string, ext: string) {
    const empty = { text: "" };
    const key = process.env.OPENAI_API_KEY;
    if (!key || !audio.length) return empty;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext || "m4a"}`);
      form.append("model", "whisper-1");
      form.append("language", lang);
      form.append("temperature", "0");
      form.append("response_format", "verbose_json");
      form.append("prompt", `${speechTag(lang) || lang} only. Transcribe exactly. Do not translate.`);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return empty;
      const data = (await res.json()) as { text?: string };
      return { text: sanitizeTranscript((data.text || "").replace(/\s+/g, " ").trim()) };
    } catch (error) {
      this.logger.warn(`translator whisper ${lang} ${(error as Error).message}`);
      return empty;
    }
  }

  private async geminiHear(audio: Buffer, mime: string, ext: string, langA: string, langB: string) {
    const tagA = speechTag(langA) || langA;
    const tagB = speechTag(langB) || langB;
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const prompt = [
      "STATELESS standalone request. Brand-new isolated utterance.",
      `Detect which of these two languages was spoken: ${langA} (${tagA}) or ${langB} (${tagB}). Never any other language.`,
      `Transcribe exactly in the spoken language's native script. If they spoke ${tagA}, write ${tagA}. If they spoke ${tagB}, write ${tagB}.`,
      "Do not translate. Do not transliterate. Do not invent names. Do not complete cut-off words.",
      `Return JSON: {"sourceText":"...","sourceLang":"${langA}"|"${langB}"}`,
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
              temperature: 0.0,
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
      return { text: parsed.sourceText, sourceLang: parsed.sourceLang };
    } catch (error) {
      this.logger.warn(`translator gemini ${(error as Error).message}`);
      return null;
    }
  }

  private async finishTurn(sourceText: string, sourceLang: string, targetLang: string) {
    sourceText = sanitizeTranscript(sourceText);
    if (!sourceText) return { sourceText: "", translatedText: "", sourceLang, targetLang };
    if (sourceLang === targetLang) {
      return { sourceText, translatedText: "", sourceLang, targetLang };
    }
    let translatedText = await this.translateFast(sourceText, sourceLang, targetLang).catch((error) => {
      logTranslateFail(`translator-translate ${sourceLang}->${targetLang} ${(error as Error).message}`);
      return "";
    });
    if (!translatedText || translatedText === sourceText) {
      translatedText = await this.translateFast(sourceText, sourceLang, targetLang, true).catch((error) => {
        logTranslateFail(`translator-translate retry ${sourceLang}->${targetLang} ${(error as Error).message}`);
        return "";
      });
    }
    if (translatedText === sourceText) translatedText = "";
    this.logger.log(`translator ${sourceLang}->${targetLang} ${clip(sourceText)} => ${clip(translatedText)}`);
    return { sourceText, translatedText, sourceLang, targetLang };
  }

  private async translateFast(text: string, source: string, target: string, retry = false) {
    const prompt = [
      STRICT_TRANSLATE,
      `Input language: ${source}. Output language: ${target}.`,
      `Translate into ${target} only. Do not write ${source}. Do not repeat the input.`,
      retry ? `The previous output was still in ${source}. Return ${target} only.` : "",
      text,
    ]
      .filter(Boolean)
      .join("\n");
    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (geminiKey) {
      for (const model of GEMINI_TRANSLATE_MODELS) {
        const out = await this.viaGeminiTranslate(model, prompt, geminiKey);
        if (out) return out;
      }
    } else {
      logTranslateFail("translator-translate missing GEMINI_API_KEY");
    }
    const openaiKey = process.env.OPENAI_API_KEY || "";
    if (openaiKey) {
      const out = await this.viaOpenAiTranslate(text, source, target, openaiKey);
      if (out) return out;
    } else {
      logTranslateFail("translator-translate missing OPENAI_API_KEY");
    }
    logTranslateFail(`translator-translate all engines failed ${source}->${target}`);
    return "";
  }

  private async viaGeminiTranslate(model: string, prompt: string, key: string) {
    try {
      const generationConfig: Record<string, unknown> = {
        temperature: 0.0,
        maxOutputTokens: 512,
      };
      if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(4000),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig,
          }),
        },
      );
      const body = await res.text();
      if (!res.ok) {
        logTranslateFail(`translator-translate ${model} HTTP ${res.status} ${body.slice(0, 500)}`);
        return "";
      }
      const data = JSON.parse(body || "{}") as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return (
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .replace(/^["']|["']$/g, "")
          .trim() ?? ""
      );
    } catch (error) {
      logTranslateFail(`translator-translate ${model} ${(error as Error).message}`);
      return "";
    }
  }

  private async viaOpenAiTranslate(text: string, source: string, target: string, key: string) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.0,
          max_tokens: 512,
          messages: [
            {
              role: "system",
              content: `${STRICT_TRANSLATE} Input language: ${source}. Output language: ${target}.`,
            },
            { role: "user", content: text },
          ],
        }),
      });
      const body = await res.text();
      if (!res.ok) {
        logTranslateFail(`translator-translate openai HTTP ${res.status} ${body.slice(0, 500)}`);
        return "";
      }
      const data = JSON.parse(body || "{}") as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "") ?? "";
    } catch (error) {
      logTranslateFail(`translator-translate openai ${(error as Error).message}`);
      return "";
    }
  }

  private async speakMp3(text: string, lang: string, gender: VoiceGender) {
    const plan = elevenVoicePlan(lang);
    if (plan.code) {
      const native = await this.viaElevenMp3(text, lang, gender);
      if (native?.length) return native;
      return this.viaOpenAiMp3(text, gender);
    }
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
    const translatedText = String(data.translatedText || "").replace(/\s+/g, " ").trim();
    const claimed = String(data.sourceLang || data.language || "").trim();
    const sourceLang = claimed === langB ? langB : claimed === langA ? langA : guessPairLang(sourceText, langA, langB);
    const targetLang = sourceLang === langA ? langB : langA;
    void data.confidence;
    return { sourceText, translatedText, sourceLang, targetLang };
  } catch {
    return null;
  }
}

function sanitizeTranscript(text: string) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function logTranslateFail(message: string) {
  console.error(message);
}

function pairLang(detected: string, text: string, langA: string, langB: string) {
  const aUnique = uniqueScript(langA) && hasScript(text, langA);
  const bUnique = uniqueScript(langB) && hasScript(text, langB);
  if (aUnique && !bUnique) return langA;
  if (bUnique && !aUnique) return langB;
  const code = whisperLangCode(detected);
  if (code === langA && uniqueScript(langA) && !hasScript(text, langA)) return langB;
  if (code === langB && uniqueScript(langB) && !hasScript(text, langB)) return langA;
  if (code === langB) return langB;
  if (code === langA) return langA;
  if (hasScript(text, langB) && !hasScript(text, langA)) return langB;
  if (hasScript(text, langA) && !hasScript(text, langB)) return langA;
  return langA;
}

function whisperLangCode(raw: string) {
  const value = (raw || "").trim().toLowerCase();
  if (value.length === 2) return value;
  const names: Record<string, string> = {
    hebrew: "he",
    english: "en",
    arabic: "ar",
    russian: "ru",
    french: "fr",
    spanish: "es",
    german: "de",
    italian: "it",
    portuguese: "pt",
    turkish: "tr",
    persian: "fa",
    hindi: "hi",
    chinese: "zh",
    japanese: "ja",
    korean: "ko",
    ukrainian: "uk",
    amharic: "am",
    georgian: "ka",
  };
  return names[value] || value.slice(0, 2);
}

function uniqueScript(lang: string) {
  return ["he", "ar", "fa", "ur", "ru", "uk", "bg", "hi", "bn", "ta", "zh", "ja", "ko", "am", "ka"].includes(lang);
}

function isSourceLanguageText(text: string, sourceLang: string, targetLang: string) {
  if (!text || sourceLang === targetLang || !uniqueScript(sourceLang)) return false;
  return hasScript(text, sourceLang) && !hasScript(text, targetLang);
}

function guessPairLang(text: string, langA: string, langB: string) {
  const a = hasScript(text, langA);
  const b = hasScript(text, langB);
  if (b && !a) return langB;
  return langA;
}

function hasScript(text: string, lang: string) {
  if (lang === "he") return /[\u0590-\u05FF]/.test(text);
  if (lang === "ar" || lang === "fa" || lang === "ur") return /[\u0600-\u06FF]/.test(text);
  if (lang === "ru" || lang === "uk" || lang === "bg") return /[\u0400-\u04FF]/.test(text);
  if (lang === "hi" || lang === "bn" || lang === "ta") return /[\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF]/.test(text);
  if (lang === "zh" || lang === "ja" || lang === "ko") return /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
  if (lang === "am") return /[\u1200-\u137F]/.test(text);
  if (lang === "ka") return /[\u10A0-\u10FF]/.test(text);
  return /[A-Za-zÀ-ÿ]/.test(text) && !/[\u0590-\u05FF\u0600-\u06FF]/.test(text);
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
