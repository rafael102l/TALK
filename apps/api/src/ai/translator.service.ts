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
    return this.finishTurn(sourceText, langA, langB);
  }

  speak(text: string, lang: string, gender: VoiceGender = "male") {
    const spoken = (text || "").replace(/\s+/g, " ").trim();
    const targetLang = (lang || "").trim();
    if (!spoken || !targetLang) return Promise.resolve(null);
    return this.speakMp3(spoken, targetLang, gender);
  }

  private async hearAndTranslate(
    audio: Buffer,
    mime: string,
    ext: string,
    langA: string,
    langB: string,
  ): Promise<Turn | null> {
    const [hearA, hearB] = await Promise.all([
      this.whisperFor(audio, langA, mime, ext),
      this.whisperFor(audio, langB, mime, ext),
    ]);
    const picked = pickHeard(hearA, hearB, langA, langB);
    if (picked?.text) {
      this.logger.log(`translator-pick ${picked.source}->${picked.target} ${clip(picked.text)}`);
      return this.finishTurn(picked.text, picked.source, picked.target);
    }
    const gemini = await this.geminiHear(audio, mime, ext, langA, langB);
    if (!gemini?.text) return null;
    const source = gemini.sourceLang === langB ? langB : langA;
    const target = source === langA ? langB : langA;
    return this.finishTurn(gemini.text, source, target);
  }

  private async whisperFor(audio: Buffer, lang: string, mime: string, ext: string) {
    const empty = { text: "", avgLogprob: -2 };
    const key = process.env.OPENAI_API_KEY;
    if (!key || !audio.length) return empty;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext || "m4a"}`);
      form.append("model", "whisper-1");
      form.append("language", lang);
      form.append("temperature", "0");
      form.append("response_format", "verbose_json");
      form.append("prompt", `${speechTag(lang) || lang} only. Transcribe exactly.`);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`translator whisper ${lang} failed: ${res.status}`);
        return empty;
      }
      const data = (await res.json()) as {
        text?: string;
        segments?: { text?: string; no_speech_prob?: number; compression_ratio?: number; avg_logprob?: number }[];
      };
      const segments = data.segments || [];
      const kept = segments.filter((seg) => (seg.no_speech_prob ?? 0) < 0.95);
      const joined = kept
        .map((seg) => (seg.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      const text = sanitizeTranscript((data.text || "").replace(/\s+/g, " ").trim() || joined);
      const probs = (kept.length ? kept : segments)
        .map((seg) => seg.avg_logprob)
        .filter((value): value is number => typeof value === "number");
      const avgLogprob = probs.length ? probs.reduce((sum, value) => sum + value, 0) / probs.length : -1;
      return { text, avgLogprob };
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
      `Detect the spoken language using ONLY ${langA} (${tagA}) or ${langB} (${tagB}). Never any other language.`,
      "Transcribe exactly in that language's native script. Do not transliterate. Do not invent names. Do not complete cut-off words.",
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

  private async finishTurn(sourceText: string, langA: string, langB: string, draft = "") {
    const sourceLang = langA;
    const targetLang = langB;
    sourceText = sanitizeTranscript(sourceText);
    if (!sourceText) return { sourceText: "", translatedText: "", sourceLang, targetLang };
    if (sourceLang === targetLang) {
      return { sourceText, translatedText: sourceText, sourceLang, targetLang };
    }
    let translatedText = copiedSourceSentence(draft, sourceText) ? "" : draft;
    if (!translatedText) {
      translatedText = await this.translateFast(sourceText, sourceLang, targetLang).catch((error) => {
        logTranslateFail(`translator-translate ${sourceLang}->${targetLang} ${(error as Error).message}`);
        return "";
      });
    }
    if (copiedSourceSentence(translatedText, sourceText)) {
      translatedText = await this.translateFast(sourceText, sourceLang, targetLang, true).catch((error) => {
        logTranslateFail(`translator-translate retry ${sourceLang}->${targetLang} ${(error as Error).message}`);
        return "";
      });
    }
    if (copiedSourceSentence(translatedText, sourceText)) translatedText = "";
    this.logger.log(`translator-stt ${sourceLang}->${targetLang} ${clip(sourceText)} -> ${clip(translatedText)}`);
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

function copiedSourceSentence(text: string, sourceText: string) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  const source = (sourceText || "").replace(/\s+/g, " ").trim();
  if (!clean) return true;
  if (!source) return false;
  if (clean !== source) return false;
  return source.split(/\s+/).filter(Boolean).length >= 3;
}

function logTranslateFail(message: string) {
  console.error(message);
}

function pickHeard(
  hearA: { text: string; avgLogprob: number },
  hearB: { text: string; avgLogprob: number },
  langA: string,
  langB: string,
) {
  const textA = hearA.text;
  const textB = hearB.text;
  if (!textA && !textB) return null;
  if (!textA) return { text: textB, source: langB, target: langA };
  if (!textB) return { text: textA, source: langA, target: langB };
  const scoreA = scoreHeard(textA, hearA.avgLogprob);
  const scoreB = scoreHeard(textB, hearB.avgLogprob);
  if (scoreB > scoreA) return { text: textB, source: langB, target: langA };
  return { text: textA, source: langA, target: langB };
}

function scoreHeard(text: string, avgLogprob: number) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words * 4 + text.length / 8 + avgLogprob;
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
