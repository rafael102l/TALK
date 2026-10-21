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

type LockedHear = { lang: string; text: string; confidence: number };

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
    let sourceText = "";
    let sourceLang = langA;
    if (input.audio?.length) {
      const heard = await this.hearLocked(input.audio, input.mime || "audio/mp4", input.ext || "m4a", langA, langB);
      if (!heard?.text) return empty;
      sourceText = heard.text;
      sourceLang = heard.lang;
    } else {
      sourceText = (input.text || "").replace(/\s+/g, " ").trim();
      if (!sourceText) return empty;
      sourceLang = pickSpokenLang(sourceText, langA, langB);
    }

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

  private async hearLocked(audio: Buffer, mime: string, ext: string, langA: string, langB: string): Promise<LockedHear | null> {
    const tags = [speechTag(langA) || langA, speechTag(langB) || langB];
    const [hearA, hearB, gemini] = await Promise.all([
      this.whisperLocked(audio, langA, mime, ext),
      langA === langB ? Promise.resolve({ text: "", confidence: 0 }) : this.whisperLocked(audio, langB, mime, ext),
      this.geminiLocked(audio, mime, ext, langA, langB, tags),
    ]);
    const candidates: LockedHear[] = [
      { lang: langA, text: hearA.text, confidence: hearA.confidence },
      { lang: langB, text: hearB.text, confidence: hearB.confidence },
    ];
    if (gemini?.text && (gemini.lang === langA || gemini.lang === langB)) {
      candidates.push(gemini);
    }
    const picked = pickLocked(candidates, langA, langB);
    this.logger.log(
      `translator-stt a=${langA}:${clip(hearA.text)}/${hearA.confidence.toFixed(2)} b=${langB}:${clip(hearB.text)}/${hearB.confidence.toFixed(2)} gemini=${gemini?.lang || "-"}:${clip(gemini?.text || "")} pick=${picked?.lang || "-"}`,
    );
    return picked;
  }

  private async whisperLocked(audio: Buffer, lang: string, mime: string, ext: string) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || !audio.length) return { text: "", confidence: 0 };
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext || "m4a"}`);
      form.append("model", "whisper-1");
      form.append("language", lang);
      form.append("temperature", "0");
      form.append("response_format", "verbose_json");
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`translator whisper ${lang} failed: ${res.status}`);
        return { text: "", confidence: 0 };
      }
      const data = (await res.json()) as {
        text?: string;
        segments?: { avg_logprob?: number; no_speech_prob?: number }[];
      };
      const text = (data.text || "").replace(/\s+/g, " ").trim();
      const segs = data.segments || [];
      const speech = segs.length
        ? segs.reduce((sum, seg) => sum + (1 - (seg.no_speech_prob ?? 1)), 0) / segs.length
        : text
          ? 0.35
          : 0;
      const logp = segs.length ? segs.reduce((sum, seg) => sum + (seg.avg_logprob ?? -1), 0) / segs.length : -1;
      const confidence = Math.max(0, Math.min(1, speech * 0.7 + Math.exp(logp) * 0.3));
      return { text, confidence };
    } catch (error) {
      this.logger.warn(`translator whisper ${lang} ${(error as Error).message}`);
      return { text: "", confidence: 0 };
    }
  }

  private async geminiLocked(
    audio: Buffer,
    mime: string,
    ext: string,
    langA: string,
    langB: string,
    tags: string[],
  ): Promise<LockedHear | null> {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !audio.length) return null;
    const allowed = `${tags[0]} (${langA}), ${tags[1]} (${langB})`;
    const prompt = [
      `Transcribe the audio. ALLOWED LANGUAGES ONLY: ${allowed}.`,
      "The speaker used exactly one of those two languages. Do not detect or guess any other language in the world.",
      "Do not transliterate. If Hebrew was spoken, write Hebrew script. If Arabic was spoken, write Arabic script.",
      `Return JSON only: {"text":"...","language":"${langA}"|"${langB}","confidence":{"${langA}":0.0,"${langB}":0.0}}`,
      `language MUST be ${langA} or ${langB}. confidence values are 0-1 for those two languages only.`,
    ].join(" ");
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8000),
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
              maxOutputTokens: 512,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw =
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim() ?? "";
      const parsed = parseLocked(raw, langA, langB);
      if (!parsed?.text) return null;
      return parsed;
    } catch (error) {
      this.logger.warn(`translator gemini-stt ${(error as Error).message}`);
      return null;
    }
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

function pickLocked(hears: LockedHear[], langA: string, langB: string): LockedHear | null {
  const allowed = new Set([langA, langB]);
  const scored = hears
    .filter((item) => allowed.has(item.lang) && item.text && plausibleForLang(item.text, item.lang, langA, langB))
    .map((item) => ({ ...item, score: lockedScore(item, langA, langB) }));
  if (!scored.length) return null;

  const scripted = scored.filter((item) => scriptFamily(item.lang) !== "latin" && distinctiveScript(item.text, item.lang));
  if (scripted.length) {
    scripted.sort((left, right) => right.score - left.score);
    const bestScript = scripted[0];
    const latin = scored
      .filter((item) => scriptFamily(item.lang) === "latin" && looksLikeEnglish(item.text))
      .sort((left, right) => right.confidence - left.confidence)[0];
    if (latin && latin.confidence > bestScript.confidence + 0.35) return latin;
    return bestScript;
  }

  scored.sort((left, right) => right.score - left.score);
  return scored[0];
}

function plausibleForLang(text: string, lang: string, langA: string, langB: string) {
  if (scriptFamily(lang) !== "latin") return distinctiveScript(text, lang);
  const other = lang === langA ? langB : langA;
  if (scriptFamily(other) !== "latin" && distinctiveScript(text, other)) return false;
  if (scriptFamily(other) !== "latin" && lang === "en" && !looksLikeEnglish(text)) return false;
  return distinctiveScript(text, lang);
}

function looksLikeEnglish(text: string) {
  return /\b(the|and|you|are|is|what|how|hey|hello|yes|no|okay|ok|please|thanks|good|now|i|we|they|to|for|this|that|me|my|your|not|can|do|did|have|has|was|were|with|from|just|really|want|need|know|think|going|because)\b/i.test(
    text,
  );
}

function lockedScore(item: LockedHear, langA: string, langB: string) {
  const hits = scriptHits(item.text, item.lang);
  const other = item.lang === langA ? langB : langA;
  const otherHits = scriptHits(item.text, other);
  const mismatch = distinctiveScript(item.text, other) && !distinctiveScript(item.text, item.lang) ? -90 : 0;
  return hits * 6 - otherHits * 4 + item.confidence * 40 + Math.min(item.text.length, 50) + mismatch;
}

function pickSpokenLang(text: string, langA: string, langB: string) {
  if (langA === langB) return langA;
  const picked = pickLocked(
    [
      { lang: langA, text, confidence: 0.5 },
      { lang: langB, text, confidence: 0.5 },
    ],
    langA,
    langB,
  );
  return picked?.lang || langA;
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

function distinctiveScript(text: string, lang: string) {
  const family = scriptFamily(lang);
  if (family === "latin") return scriptHits(text, lang) > 0 && !/[\u0590-\u05FF\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF]/.test(text);
  return scriptHits(text, lang) > 0;
}

function parseLocked(raw: string, langA: string, langB: string): LockedHear | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(trimmed.slice(start, end + 1)) as {
      text?: string;
      language?: string;
      confidence?: Record<string, number>;
    };
    const text = String(data.text || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    let lang = String(data.language || "").slice(0, 2).toLowerCase();
    if (lang !== langA && lang !== langB) {
      lang = distinctiveScript(text, langA) ? langA : distinctiveScript(text, langB) ? langB : langA;
    }
    const confidence = Number(data.confidence?.[lang] ?? 0.6);
    return { text, lang, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6 };
  } catch {
    return null;
  }
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
