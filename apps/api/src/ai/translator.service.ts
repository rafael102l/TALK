import { Injectable, Logger } from "@nestjs/common";
import type { VoiceGender } from "@talk/shared";
import { canonicalSpeech, speechBase, speechPrompt, whisperLang } from "@talk/shared";
import { geminiThinkingConfig, speechTag } from "./stt.service";
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
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
];
const GEMINI_DETECT_MODELS = ["gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];

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
    const langA = keepLang(input.langA, "he");
    const langB = keepLang(input.langB, "en");
    const empty = { sourceText: "", translatedText: "", sourceLang: "", targetLang: "" };
    const preset = (input.text || "").replace(/\s+/g, " ").trim();
    if (preset) {
      const sourceLang = pickSpoken(null, "", preset, langA, langB);
      if (!sourceLang) return empty;
      const targetLang = otherLang(sourceLang, langA, langB);
      if (!targetLang) return empty;
      return this.finishTurn(preset, sourceLang, targetLang);
    }
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
    const langA = keepLang(input.langA, "he");
    const langB = keepLang(input.langB, "en");
    const turn = await this.transcribe({
      text: input.text,
      audio: input.audio,
      mime: input.mime,
      ext: input.ext,
      langA,
      langB,
    });
    const sourceLang = matchChoice(turn.sourceLang, langA, langB);
    const targetLang = otherLang(sourceLang, langA, langB);
    if (!sourceLang || !targetLang || !turn.sourceText) {
      return {
        sourceText: "",
        translatedText: "",
        sourceLang: "",
        targetLang: "",
        audioBase64: "",
        mime: "audio/mpeg" as const,
      };
    }
    const sourceText = (turn.sourceText || "").replace(/\s+/g, " ").trim();
    const translatedText = (turn.translatedText || "").replace(/\s+/g, " ").trim();
    let audio: Buffer | null = null;
    if (translatedText) {
      try {
        audio = await this.speakTranslation(translatedText, targetLang, input.gender || "male");
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
      audio = await this.speakTranslation(spoken, keepLang(lang, "en"), gender);
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
    const [detectedAB, detectedBA, auto] = await Promise.all([
      this.detectSpokenLang(audio, mime, ext, langA, langB),
      this.detectSpokenLang(audio, mime, ext, langB, langA),
      this.whisperAuto(audio, mime, ext, langA, langB),
    ]);
    const autoLang = matchChoice(whisperLangCode(auto.language), langA, langB);
    const textAuto = keepPairTranscript(auto.text, langA, langB);
    const scriptLang = pickByScript(textAuto, langA, langB);
    const geminiLang = detectedAB && detectedBA && detectedAB === detectedBA ? detectedAB : "";
    let sourceLang = scriptLang || autoLang || geminiLang;
    if (scriptLang) sourceLang = scriptLang;
    let text = textAuto;
    if (sourceLang && (!text || scriptContradicts(text, sourceLang, langA, langB))) {
      const locked = await this.whisperFor(audio, sourceLang, mime, ext);
      const lockedText = sanitizeTranscript(locked.text);
      if (lockedText && !isJunkSpeech(lockedText)) text = lockedText;
    }
    if (!sourceLang || !text) return null;
    if (scriptContradicts(textAuto, sourceLang, langA, langB) && scriptLang) {
      sourceLang = scriptLang;
      text = textAuto;
    }
    const targetLang = otherLang(sourceLang, langA, langB);
    if (!targetLang) return null;
    this.logger.log(`translator-detect ${geminiLang || autoLang || scriptLang || "?"} => ${sourceLang}->${targetLang} ${clip(text)}`);
    return this.finishTurn(text, sourceLang, targetLang);
  }

  private async detectSpokenLang(audio: Buffer, mime: string, ext: string, langA: string, langB: string) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !audio.length) return null;
    const constraint = [
      "The two languages below are equally likely. Do not prefer the first one listed.",
      `Valid codes only: "${langA}" (${langTitle(langA)}) and "${langB}" (${langTitle(langB)}).`,
      `Return JSON {"lang":"${langA}"} or {"lang":"${langB}"} or {"lang":"unknown"}.`,
      "If you are not sure which of the two was spoken, return unknown. Never guess.",
      "Do not transcribe. Do not translate.",
    ].join(" ");
    for (const model of GEMINI_DETECT_MODELS) {
      try {
        const generationConfig: Record<string, unknown> = {
          temperature: 0.0,
          maxOutputTokens: 256,
          responseMimeType: "application/json",
        };
        const thinkingConfig = geminiThinkingConfig(model);
        if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(6000),
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: constraint }] },
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: constraint },
                    { inlineData: { mimeType: geminiAudioMime(mime, ext), data: audio.toString("base64") } },
                  ],
                },
              ],
              generationConfig,
            }),
          },
        );
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          this.logger.warn(`translator detect ${model} ${res.status} ${errText.slice(0, 240)}`);
          continue;
        }
        const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const raw =
          data.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("")
            .trim() ?? "";
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start < 0 || end <= start) continue;
        const parsed = JSON.parse(raw.slice(start, end + 1)) as { lang?: string };
        const picked = String(parsed.lang || "").trim();
        if (!picked || picked.toLowerCase() === "unknown") continue;
        const lang = matchChoice(picked, langA, langB);
        if (lang) return lang;
      } catch (error) {
        this.logger.warn(`translator detect ${model} ${(error as Error).message}`);
      }
    }
    return null;
  }

  private async whisperAuto(audio: Buffer, mime: string, ext: string, langA?: string, langB?: string) {
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
        langA && langB
          ? `The recording is equally likely to be ${langTitle(langB)} or ${langTitle(langA)}. Transcribe in the original script of whichever of those two was spoken. Do not prefer the first named language. Do not translate. Do not write English unless English is one of those two languages.`
          : "Transcribe every spoken word exactly in the original language. Do not translate. Do not paraphrase. Do not shorten.",
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
    if (sameChoice(sourceLang, targetLang)) {
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
      const thinkingConfig = geminiThinkingConfig(model);
      if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
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
    const native = await this.viaElevenMp3(text, lang, gender);
    if (native?.length) return native;
    return this.viaOpenAiMp3(text, gender);
  }

  private async viaOpenAiMp3(text: string, gender: VoiceGender) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
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
      signal: AbortSignal.timeout(8000),
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

const JUNK_SPEECH =
  /^(thank you( for watching)?|thanks( for (watching|listening))?|please subscribe|bye|you|music|applause|thank you\.|thanks\.?|תודה( רבה)?|субтитры|продолжение следует)[\s.!?]*$/i;

function isJunkSpeech(text: string) {
  const value = sanitizeTranscript(text);
  if (value.length < 2) return true;
  if (/^[\s.,;:!?'"\-–—…]+$/.test(value)) return true;
  return JUNK_SPEECH.test(value);
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

function keepLang(code: string, fallback: string) {
  const raw = (code || "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return fallback;
  if (raw.includes("-")) return raw;
  return canonicalSpeech(raw) || raw;
}

function sameChoice(a?: string | null, b?: string | null) {
  const left = keepLang(a || "", "");
  const right = keepLang(b || "", "");
  if (!left || !right) return false;
  if (left === right) return true;
  return left.startsWith(`${right}-`) || right.startsWith(`${left}-`);
}

function matchChoice(raw: string, langA: string, langB: string) {
  const value = keepLang(raw, "");
  if (!value) return "";
  if (keepLang(langB, "") === value) return langB;
  if (keepLang(langA, "") === value) return langA;
  const hitB = sameChoice(value, langB);
  const hitA = sameChoice(value, langA);
  if (hitB && !hitA) return langB;
  if (hitA && !hitB) return langA;
  return "";
}

function otherLang(spoken: string, langA: string, langB: string) {
  if (sameChoice(spoken, langA) && !sameChoice(spoken, langB)) return langB;
  if (sameChoice(spoken, langB) && !sameChoice(spoken, langA)) return langA;
  return "";
}

function langTitle(code: string) {
  const name = speechPrompt(code) || speechTag(code) || code;
  return `${name} (${code})`;
}

function pickByScript(text: string, langA: string, langB: string) {
  if (!text) return "";
  const onlyB = hasScript(text, langB) && !hasScript(text, langA);
  const onlyA = hasScript(text, langA) && !hasScript(text, langB);
  if (onlyB) return langB;
  if (onlyA) return langA;
  return "";
}

function scriptContradicts(text: string, chosen: string, langA: string, langB: string) {
  if (!text || !chosen) return false;
  const other = otherLang(chosen, langA, langB);
  if (!other) return false;
  if (hasScript(text, other) && !hasScript(text, chosen)) return true;
  if (uniqueScript(chosen) && !hasScript(text, chosen) && hasScript(text, other)) return true;
  return false;
}

function keepPairTranscript(text: string, langA: string, langB: string) {
  const value = sanitizeTranscript(text);
  if (isJunkSpeech(value)) return "";
  if (pickByScript(value, langA, langB)) return value;
  if (hasScript(value, langA) || hasScript(value, langB)) return value;
  if (!uniqueScript(langA) && !uniqueScript(langB)) return value;
  return "";
}

function pickSpoken(detected: string | null, autoLang: string, text: string, langA: string, langB: string) {
  const script = pickByScript(text, langA, langB);
  if (script) return script;
  const gemini = matchChoice(detected || "", langA, langB);
  if (gemini && !scriptContradicts(text, gemini, langA, langB)) return gemini;
  const code = matchChoice(autoLang || whisperLangCode(autoLang), langA, langB);
  if (code && !scriptContradicts(text, code, langA, langB)) return code;
  return "";
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
