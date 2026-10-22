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
  "You are an absolute word-for-word TRANSLATOR, NOT a conversational assistant. Your ONLY job is to translate the input sentence into the target language, exactly as written. Do not shorten, summarize, paraphrase, or replace the sentence with a different one. Do not transliterate. Translate meaning (Hebrew גוף → English body, not guf). If the user asks a question (e.g., 'How do I say X in Hebrew?'), DO NOT answer the question. Translate the question itself directly (e.g., 'איך אומרים X בעברית?'). NEVER output just the answer. Do NOT add pleasantries, notes, context, corrections, or explanations. Return ONLY the direct translation of the input.";

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
    const sourceLang = pickSpoken(null, "", sourceText, langA, langB);
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
      translatedText && translatedText !== sourceText && canSpeakTranslation(translatedText, sourceLang, targetLang)
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

  async speakTurn(text: string, lang: string, gender: VoiceGender = "male") {
    const spoken = sanitizeTranscript(text);
    if (!spoken) return { audioBase64: "", mime: "audio/mpeg" as const };
    let audio: Buffer | null = null;
    try {
      audio = await this.speakTranslation(spoken, lang, gender);
    } catch {
      audio = null;
    }
    return {
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
    const [detected, auto] = await Promise.all([
      this.detectSpokenLang(audio, mime, ext, langA, langB),
      this.whisperAuto(audio, mime, ext),
    ]);
    const aOnly =
      uniqueScript(langA) && hasScript(auto.text, langA) && !(uniqueScript(langB) && hasScript(auto.text, langB));
    const bOnly =
      uniqueScript(langB) && hasScript(auto.text, langB) && !(uniqueScript(langA) && hasScript(auto.text, langA));
    const sourceLang = aOnly ? langA : bOnly ? langB : pickSpoken(detected, auto.language, auto.text, langA, langB);
    const targetLang = sourceLang === langA ? langB : langA;
    let text = auto.text;
    if (uniqueScript(sourceLang) && !hasScript(text, sourceLang)) {
      const locked = await this.whisperFor(audio, sourceLang, mime, ext);
      if (hasScript(locked.text, sourceLang)) text = locked.text;
    }
    if (!text) return null;
    this.logger.log(`translator-detect ${detected || auto.language || "?"} => ${sourceLang}->${targetLang} ${clip(text)}`);
    return this.finishTurn(text, sourceLang, targetLang);
  }

  private async detectSpokenLang(audio: Buffer, mime: string, ext: string, langA: string, langB: string) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !audio.length) return null;
    const tagA = speechTag(langA) || langA;
    const tagB = speechTag(langB) || langB;
    const prompt = [
      `The speaker used either ${langA} (${tagA}) or ${langB} (${tagB}). Never any other language.`,
      `Which of these two languages was spoken?`,
      `Return JSON: {"lang":"${langA}"} or {"lang":"${langB}"}.`,
      "Do not transcribe. Do not translate.",
    ].join(" ");
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
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
              maxOutputTokens: 32,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      );
      if (!res.ok) {
        this.logger.warn(`translator detect ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw =
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim() ?? "";
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { lang?: string };
      const lang = whisperLangCode(String(parsed.lang || ""));
      if (lang === langB) return langB;
      if (lang === langA) return langA;
      return null;
    } catch (error) {
      this.logger.warn(`translator detect ${(error as Error).message}`);
      return null;
    }
  }

  private async whisperAuto(audio: Buffer, mime: string, ext: string) {
    const empty = { text: "", language: "" };
    const key = process.env.OPENAI_API_KEY;
    if (!key || !audio.length) return empty;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext || "m4a"}`);
      form.append("model", "whisper-1");
      form.append("temperature", "0");
      form.append("response_format", "verbose_json");
      form.append(
        "prompt",
        "Transcribe every spoken word exactly in the original language. Do not translate. Do not paraphrase. Do not shorten.",
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
      const data = (await res.json()) as { text?: string; language?: string };
      return {
        text: sanitizeTranscript((data.text || "").replace(/\s+/g, " ").trim()),
        language: (data.language || "").trim().toLowerCase(),
      };
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
      form.append(
        "prompt",
        `${speechTag(lang) || lang} only. Transcribe every spoken word exactly. Do not translate. Do not paraphrase. Do not shorten.`,
      );
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
    if (!translatedText || translatedText === sourceText || !canSpeakTranslation(translatedText, sourceLang, targetLang)) {
      translatedText = await this.translateFast(sourceText, sourceLang, targetLang, true).catch((error) => {
        logTranslateFail(`translator-translate retry ${sourceLang}->${targetLang} ${(error as Error).message}`);
        return "";
      });
    }
    if (translatedText === sourceText || !canSpeakTranslation(translatedText, sourceLang, targetLang)) {
      translatedText = "";
    }
    this.logger.log(`translator ${sourceLang}->${targetLang} ${clip(sourceText)} => ${clip(translatedText)}`);
    return { sourceText, translatedText, sourceLang, targetLang };
  }

  private async translateFast(text: string, source: string, target: string, retry = false) {
    const prompt = [
      STRICT_TRANSLATE,
      `Input language: ${source}. Output language: ${target}.`,
      `Translate this exact sentence into ${target} only. Do not shorten it. Do not transliterate. Do not write ${source}.`,
      "Do not answer questions. If the input is a question, translate the question itself.",
      retry ? `The previous output was still in ${source} or was not a full translation. Translate the original sentence into ${target} only. Do not answer it.` : "",
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

function sanitizeTranscript(text: string) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function logTranslateFail(message: string) {
  console.error(message);
}

function pickSpoken(detected: string | null, autoLang: string, text: string, langA: string, langB: string) {
  if (detected === langB) return langB;
  if (detected === langA) return langA;
  const code = whisperLangCode(autoLang);
  if (code === langB) return langB;
  if (code === langA) return langA;
  const aScript = uniqueScript(langA) && hasScript(text, langA);
  const bScript = uniqueScript(langB) && hasScript(text, langB);
  if (bScript && !aScript) return langB;
  if (aScript && !bScript) return langA;
  if (hasScript(text, langB) && !hasScript(text, langA)) return langB;
  if (hasScript(text, langA) && !hasScript(text, langB)) return langA;
  return langA;
}

function canSpeakTranslation(text: string, sourceLang: string, targetLang: string) {
  if (!text || sourceLang === targetLang) return false;
  if (uniqueScript(targetLang) && !hasScript(text, targetLang)) return false;
  if (uniqueScript(sourceLang) && hasScript(text, sourceLang) && !hasScript(text, targetLang)) return false;
  return true;
}

function uniqueScript(lang: string) {
  return ["he", "ar", "fa", "ur", "ru", "uk", "bg", "hi", "bn", "ta", "zh", "ja", "ko", "am", "ka", "th", "el"].includes(
    lang,
  );
}

function hasScript(text: string, lang: string) {
  if (lang === "he") return /[\u0590-\u05FF]/.test(text);
  if (lang === "ar" || lang === "fa" || lang === "ur") return /[\u0600-\u06FF]/.test(text);
  if (lang === "ru" || lang === "uk" || lang === "bg") return /[\u0400-\u04FF]/.test(text);
  if (lang === "hi" || lang === "bn" || lang === "ta") return /[\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF]/.test(text);
  if (lang === "zh" || lang === "ja" || lang === "ko") return /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
  if (lang === "am") return /[\u1200-\u137F]/.test(text);
  if (lang === "ka") return /[\u10A0-\u10FF]/.test(text);
  if (lang === "th") return /[\u0E00-\u0E7F]/.test(text);
  if (lang === "el") return /[\u0370-\u03FF]/.test(text);
  return /[A-Za-zÀ-ÿ]/.test(text) && !/[\u0590-\u05FF\u0600-\u06FF]/.test(text);
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
    dutch: "nl",
    polish: "pl",
    romanian: "ro",
    thai: "th",
    greek: "el",
  };
  return names[value] || value.slice(0, 2);
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
