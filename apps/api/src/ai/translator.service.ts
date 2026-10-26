import { Injectable, Logger } from "@nestjs/common";
import type { VoiceGender } from "@talk/shared";
import { apiLangCode, canonicalSpeech, speechBase, speechPrompt, whisperLang } from "@talk/shared";
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
    const langA = apiLangCode(input.langA, "he");
    const langB = apiLangCode(input.langB, "en");
    const empty = { sourceText: "", translatedText: "", sourceLang: langA, targetLang: langB };
    const preset = (input.text || "").replace(/\s+/g, " ").trim();
    if (preset) return this.finishTurn(preset, langA, langB);
    if (input.audio?.length) {
      return (await this.hearAndTranslate(input.audio, input.mime || "audio/mp4", input.ext || "m4a", langA, langB)) || empty;
    }
    return empty;
  }

  async runTurn(input: {
    text?: string;
    audio?: Buffer;
    mime?: string;
    ext?: string;
    langA: string;
    langB: string;
    gender?: VoiceGender;
  }) {
    const langA = apiLangCode(input.langA, "he");
    const langB = apiLangCode(input.langB, "en");
    const turn = await this.transcribe({
      text: input.text,
      audio: input.audio,
      mime: input.mime,
      ext: input.ext,
      langA,
      langB,
    });
    const sourceLang = langA;
    const targetLang = langB;
    const sourceText = (turn.sourceText || "").replace(/\s+/g, " ").trim();
    const translatedText = (turn.translatedText || "").replace(/\s+/g, " ").trim();
    const spoken =
      translatedText && translatedText !== sourceText ? translatedText : "";
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
      audio = await this.speakTranslation(spoken, apiLangCode(lang, "en"), gender);
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
    const sourceLang = apiLangCode(langA, "he");
    const targetLang = apiLangCode(langB, "en");
    const locked = await this.whisperFor(audio, sourceLang, mime, ext);
    const text = locked.text;
    if (!text) return null;
    this.logger.log(`translator ${sourceLang}->${targetLang} ${clip(text)}`);
    return this.finishTurn(text, sourceLang, targetLang);
  }

  private async detectSpokenLang(audio: Buffer, mime: string, ext: string, langA: string, langB: string) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !audio.length) return null;
    const tagA = speechTag(langA) || langA;
    const tagB = speechTag(langB) || langB;
    const nameA = speechPrompt(langA) || langA;
    const nameB = speechPrompt(langB) || langB;
    const prompt = [
      `The speaker used either ${nameA} (code ${langA}, locale ${tagA}) or ${nameB} (code ${langB}, locale ${tagB}). Never any other language.`,
      `Which of these two languages or dialects was spoken?`,
      `Return JSON: {"lang":"${langA}"} or {"lang":"${langB}"} using that exact code.`,
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
      if (lang === langB || lang === langA) return lang;
      if (sameSpeech(lang, langB) && !sameSpeech(lang, langA)) return langB;
      if (sameSpeech(lang, langA) && !sameSpeech(lang, langB)) return langA;
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
      form.append("language", whisperLang(lang) || speechBase(lang) || lang);
      form.append("temperature", "0");
      form.append("response_format", "verbose_json");
      form.append(
        "prompt",
        `${speechPrompt(lang) || speechTag(lang) || lang} only. Transcribe every spoken word exactly in that dialect. Do not translate. Do not paraphrase. Do not shorten.`,
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
      `Input language: ${speechPrompt(source) || source} (code ${source}). Output language: ${speechPrompt(target) || target} (code ${target}).`,
      `Translate this exact sentence into ${speechPrompt(target) || target} only, using that dialect's natural wording. Do not shorten it. Do not transliterate. Do not write ${speechPrompt(source) || source}.`,
      "Do not answer questions. If the input is a question, translate the question itself.",
      retry
        ? `The previous output was still in ${speechPrompt(source) || source} or was not a full translation. Translate the original sentence into ${speechPrompt(target) || target} only. Do not answer it.`
        : "",
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
      const raw =
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim() ?? "";
      return cleanTranslationOnly(raw);
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
      const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
      return cleanTranslationOnly(raw);
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

const REFUSAL =
  /^(?:sorry|i'?m sorry|i am sorry|i cannot|i can't|as an ai|i'?m unable|unable to translate|i do not understand|please provide|could you clarify)/i;
const REFUSAL_HE =
  /^(?:מצטער|אני מצטער|אני לא יכול|לא ניתן|לא הבנתי|אנא ספק|לא מצליח לתרגם)/;

function cleanTranslationOnly(raw: string) {
  let out = (raw || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^(translation|translated text|output)\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) return "";
  if (REFUSAL.test(out) || REFUSAL_HE.test(out)) return "";
  if (/^(note|warning|error)\s*:/i.test(out)) return "";
  return out;
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
  if (sameSpeech(code, langB) && !sameSpeech(code, langA)) return langB;
  if (sameSpeech(code, langA) && !sameSpeech(code, langB)) return langA;
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
  const key = scriptKey(lang);
  return ["he", "ar", "fa", "ur", "ru", "uk", "bg", "hi", "mr", "bn", "ta", "pa", "gu", "te", "kn", "ml", "zh", "ja", "ko", "am", "ka", "th", "el"].includes(
    key,
  );
}

function hasScript(text: string, lang: string) {
  const key = scriptKey(lang);
  if (key === "he") return /[\u0590-\u05FF]/.test(text);
  if (key === "ar" || key === "fa" || key === "ur") return /[\u0600-\u06FF]/.test(text);
  if (key === "ru" || key === "uk" || key === "bg") return /[\u0400-\u04FF]/.test(text);
  if (key === "hi" || key === "mr") return /[\u0900-\u097F]/.test(text);
  if (key === "pa") return /[\u0A00-\u0A7F]/.test(text);
  if (key === "gu") return /[\u0A80-\u0AFF]/.test(text);
  if (key === "bn") return /[\u0980-\u09FF]/.test(text);
  if (key === "ta") return /[\u0B80-\u0BFF]/.test(text);
  if (key === "te") return /[\u0C00-\u0C7F]/.test(text);
  if (key === "kn") return /[\u0C80-\u0CFF]/.test(text);
  if (key === "ml") return /[\u0D00-\u0D7F]/.test(text);
  if (key === "zh" || key === "ja" || key === "ko") return /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
  if (key === "am") return /[\u1200-\u137F]/.test(text);
  if (key === "ka") return /[\u10A0-\u10FF]/.test(text);
  if (key === "th") return /[\u0E00-\u0E7F]/.test(text);
  if (key === "el") return /[\u0370-\u03FF]/.test(text);
  return /[A-Za-zÀ-ÿ]/.test(text) && !/[\u0590-\u05FF\u0600-\u06FF]/.test(text);
}

function scriptKey(lang: string) {
  const code = canonicalSpeech(lang) || (lang || "").trim();
  if (["pa", "gu", "te", "kn", "ml", "mr", "bn", "ta"].includes(code)) return code;
  return speechBase(lang) || code;
}

function sameSpeech(a: string, b: string) {
  const left = canonicalSpeech(a) || a;
  const right = canonicalSpeech(b) || b;
  if (left && right && left === right) return true;
  const baseA = speechBase(a);
  const baseB = speechBase(b);
  return Boolean(baseA && baseB && baseA === baseB);
}

function whisperLangCode(raw: string) {
  return canonicalSpeech(raw) || (raw || "").trim().toLowerCase();
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
