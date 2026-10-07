import { Injectable, Logger } from "@nestjs/common";
import { LANGUAGES, isLanguageCode } from "@talk/shared";
import { extname } from "path";
import { readFile } from "fs/promises";

// Prefer non-thinking / lite first. 2.5-flash thinks by default and used to eat the
// tiny maxOutputTokens budget → truncated mid-word transcripts.
const GEMINI_HEAR_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const LANG_LIST = LANGUAGES.map((language) => language.code).join(", ");

const HEBREW = /[\u0590-\u05FF]/;
const ARABIC = /[\u0600-\u06FF]/;
const CYRILLIC = /[\u0400-\u04FF]/;
const CJK = /[\u3040-\u30FF\u4E00-\u9FFF]/;
const HANGUL = /[\uAC00-\uD7AF]/;
const DEVANAGARI = /[\u0900-\u097F]/;
const THAI = /[\u0E00-\u0E7F]/;
const GREEK = /[\u0370-\u03FF]/;
const GEORGIAN = /[\u10A0-\u10FF]/;
const ETHIOPIC = /[\u1200-\u137F]/;
const BENGALI = /[\u0980-\u09FF]/;
const TAMIL = /[\u0B80-\u0BFF]/;
const JUNK =
  /thank you for watching|thanks for watching|thanks for listening|subscribe|subtitle by|www\.|https?:\/\/|transcribe the complete|spoken sentence|walkie-talkie|תעתיק את המשפט|החזיקו את המיקרופון|hold the mic/i;
const HALLUCINATION =
  /^(thank you( very much)?|thanks|bye|goodbye|the end|you|subtitles?|captions?|תודה( רבה)?( לך)?|כתוביות( כתוביות)?|شكرا( جزيلا)?)$/i;

export type SttResult = { text: string; lang: string };

@Injectable()
export class SttService {
  private readonly logger = new Logger(SttService.name);
  private readonly deadGemini = new Set<string>();

  async transcribe(filePath: string, language = ""): Promise<string> {
    const audio = await readFile(filePath);
    const result = await this.transcribeBytes(
      audio,
      language,
      mimeOf(filePath),
      extname(filePath).replace(".", "") || "m4a",
    );
    return result.text;
  }

  async transcribeBytes(
    audio: Buffer,
    hintLang = "",
    mime: string,
    ext = "m4a",
    names: string[] = [],
  ): Promise<SttResult> {
    const started = Date.now();
    const hint = normLang(hintLang);
    // Gemini hears the recording first and names the spoken language. OpenAI only if that fails.
    let raw = await this.viaGemini(audio, mime, ext);
    let engine = raw.text ? "gemini" : "";
    let text = usableSpeech(raw.text);
    if (!text) {
      raw = await this.viaOpenAi(audio, ext, mime, 20000, "");
      engine = raw.text ? "openai" : "none";
      text = usableSpeech(raw.text);
    }
    let lang = text ? spokenLang(text, raw.lang || hint, hint) : "";

    if (engine !== "gemini" && text && hint && !matchesLang(text, hint)) {
      const retry = await this.viaOpenAi(audio, ext, mime, 20000, "");
      const retryText = usableSpeech(retry.text);
      if (
        retryText &&
        (matchesLang(retryText, hint) || (hint === "en" && looksLikeEnglish(retryText)))
      ) {
        text = retryText;
        lang = spokenLang(retryText, retry.lang || hint, hint);
      }
    }

    this.logger.log(
      `STT ${engine || "none"} ${Date.now() - started}ms lang=${lang || "?"} hint=${hint || "-"} "${clip(text)}"`,
    );
    void names;
    return { text, lang };
  }

  private async viaGemini(audio: Buffer, mime: string, ext: string): Promise<SttResult> {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !audio.length) return { text: "", lang: "" };
    const audioMime = geminiAudioMime(mime, ext);
    const prompt = [
      "You are the hearing step of a walkie-talkie.",
      "Listen to the recording and write only the words that were spoken.",
      "Transcribe the COMPLETE utterance — do not cut words or stop mid-sentence.",
      "Keep the original language and its usual script. Do not translate.",
      "Do not add greetings, explanations, or words that were not said.",
      `language must be exactly one of: ${LANG_LIST}.`,
      'Return only JSON: {"text":"...","language":"xx"}',
    ].join(" ");
    const models = GEMINI_HEAR_MODELS.filter((model) => !this.deadGemini.has(model));
    for (const model of models) {
      try {
        const generationConfig: Record<string, unknown> = {
          temperature: 0,
          // Enough room for a full walkie sentence (Hebrew/Arabic tokens are dense).
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        };
        // Gemini 2.5 thinking tokens share the output budget — disable or transcripts truncate.
        if (model.includes("2.5")) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: prompt },
                    { inline_data: { mime_type: audioMime, data: audio.toString("base64") } },
                  ],
                },
              ],
              generationConfig,
            }),
          },
        );
        if (!res.ok) {
          this.logger.warn(`Gemini hear ${model} failed: ${res.status}`);
          if (res.status === 404) this.deadGemini.add(model);
          continue;
        }
        const data = (await res.json()) as {
          candidates?: {
            finishReason?: string;
            content?: { parts?: { text?: string }[] };
          }[];
        };
        const candidate = data.candidates?.[0];
        const finish = String(candidate?.finishReason || "").toUpperCase();
        const raw =
          candidate?.content?.parts
            ?.map((part) => part.text || "")
            .join("")
            .trim() ?? "";
        // Token-budget cuts produce mid-word / mid-sentence transcripts — skip them.
        if (finish === "MAX_TOKENS") {
          this.logger.warn(`Gemini hear ${model} truncated (MAX_TOKENS) — retry next`);
          continue;
        }
        const heard = parseHeard(raw);
        if (heard.text) return heard;
      } catch (error) {
        this.logger.warn(`Gemini hear ${model} error: ${(error as Error).message}`);
      }
    }
    return { text: "", lang: "" };
  }

  private async viaOpenAi(
    audio: Buffer,
    ext: string,
    mime: string,
    timeoutMs = 6000,
    language = "",
  ): Promise<SttResult> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { text: "", lang: "" };
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext || "m4a"}`);
      form.append("model", "whisper-1");
      form.append("temperature", "0");
      form.append("response_format", "verbose_json");
      if (language) form.append("language", language);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        this.logger.warn(`OpenAI STT failed: ${res.status}`);
        return { text: "", lang: "" };
      }
      const data = (await res.json()) as { text?: string; language?: string };
      return { text: data.text?.trim() ?? "", lang: normLang(data.language || "") };
    } catch (error) {
      this.logger.warn(`OpenAI STT error: ${(error as Error).message}`);
      return { text: "", lang: "" };
    }
  }
}

export function collapseRepeats(text: string) {
  let t = text.replace(/\s+/g, " ").trim();
  if (!t) return t;
  // ooooo / אההההה → oo / אהה (keep a short natural filler, drop runaway stretch)
  t = t.replace(/(\p{L})\1{3,}/gu, "$1$1");
  // "ah ah ah ah" / "אהה אהה אהה"
  t = t.replace(/(\p{L}{1,12})(?:[,\s]+\1){2,}/gu, "$1");
  // "word-word-word"
  t = t.replace(/(\p{L}+)(?:[-\s]+\1){2,}/gu, "$1");
  t = t.replace(/(\S+)(?:\s+\1){2,}/g, "$1");

  let words = t.split(/\s+/).filter(Boolean);
  // Whole utterance is the same 1–4 word phrase repeated (oh la la × N)
  for (let size = 1; size <= Math.min(4, Math.floor(words.length / 2)); size++) {
    const unit = words.slice(0, size).join(" ");
    if (unit.length < 2) continue;
    let repeats = 1;
    let pos = size;
    while (
      pos + size <= words.length &&
      words.slice(pos, pos + size).join(" ").toLowerCase() === unit.toLowerCase()
    ) {
      repeats += 1;
      pos += size;
    }
    if (repeats >= 3 && pos >= words.length - (words.length % size)) {
      const rest = words.slice(pos);
      words = [...unit.split(/\s+/), ...rest];
      t = words.join(" ");
      break;
    }
  }

  for (let n = 3; n <= 4; n++) {
    if (words.length < n * 2 || words.length % n !== 0) continue;
    const size = words.length / n;
    const unit = words.slice(0, size).join(" ");
    if (unit.length < 3) continue;
    const copies = Array.from({ length: n }, (_, i) => words.slice(i * size, (i + 1) * size).join(" "));
    if (copies.every((piece) => piece.toLowerCase() === unit.toLowerCase())) return unit;
  }
  return t;
}

const FILLER_TOKEN =
  /^(uh+|um+|ah+|oh+|er+|hm+|hmm+|mm+|mhm+|ooh+|ahh+|אה+|אמ+|או+|המ+|אהה+|אממ+|הו+|la+|huh+|eh+)$/i;

export function isHallucination(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (JUNK.test(t)) return true;
  const bare = t
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[.!?,"'\u05F3]+/g, "")
    .trim();
  if (HALLUCINATION.test(bare)) return true;
  if (/^(.)\1{7,}$/u.test(bare.replace(/\s+/g, ""))) return true;
  return /^(\S+)(?:\s+\1){2,}$/u.test(bare) && bare.length <= 24;
}

export function isStutterGarbage(text: string) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  const compact = t.replace(/[\s,.-]+/g, "");
  // Long vowel/letter run with almost no real words: oooooo, אהההההה
  if (compact.length >= 6 && /^(.)\1+$/u.test(compact)) return true;
  if (/^(\S{1,8})(?:[-\s]+\1){3,}$/iu.test(t)) return true;
  if (/^(\S{1,12}\s+\S{1,12})(?:[,\s]+\1){2,}$/iu.test(t)) return true;
  if (/^(\S{1,10}\s+\S{1,10}\s+\S{1,10})(?:[,\s]+\1){2,}$/iu.test(t)) return true;
  const tokens = t.split(/[-\s,]+/).filter(Boolean);
  if (tokens.length >= 5) {
    const first = tokens[0].toLowerCase();
    const same = tokens.filter((token) => token.toLowerCase() === first).length;
    if (same / tokens.length >= 0.7) return true;
  }
  if (tokens.length >= 4) {
    const fillers = tokens.filter((token) => FILLER_TOKEN.test(token)).length;
    if (fillers / tokens.length >= 0.85) return true;
  }
  // "oh la la" / "la la la" loops
  if (tokens.length >= 6) {
    const norm = tokens.map((token) => token.toLowerCase());
    const unitSize = norm.length % 3 === 0 ? 3 : norm.length % 2 === 0 ? 2 : 0;
    if (unitSize) {
      const unit = norm.slice(0, unitSize).join(" ");
      let ok = true;
      for (let i = 0; i < norm.length; i += unitSize) {
        if (norm.slice(i, i + unitSize).join(" ") !== unit) {
          ok = false;
          break;
        }
      }
      if (ok && FILLER_TOKEN.test(norm[0])) return true;
      if (ok && /^(oh|la|da|na|ha|אה|הו|לא)$/i.test(norm[0])) return true;
    }
  }
  return false;
}

function isGibberishLatin(text: string) {
  const t = (text || "").trim();
  if (!t || HEBREW.test(t) || ARABIC.test(t) || CYRILLIC.test(t)) return false;
  if (!/[A-Za-zÀ-ÿ]/u.test(t)) return false;
  if (isStutterGarbage(t)) return true;
  if (/([A-Za-z]{2,8}[-\s][A-Za-z]{2,8})(?:[,\s]+\1){1,}/i.test(t)) return true;
  return false;
}

export function usableSpeech(text: string) {
  const raw = (text || "").trim();
  if (!raw || isStutterGarbage(raw)) return "";
  const clean = collapseRepeats(raw);
  if (!clean || isHallucination(clean) || isStutterGarbage(clean)) return "";
  // After collapse, if only fillers remain — drop (don't TTS ahh-ahh forever)
  const tokens = clean.split(/[\s,.-]+/).filter(Boolean);
  if (tokens.length && tokens.every((token) => FILLER_TOKEN.test(token))) return "";
  if (tokens.length === 1 && /^([aeiouyאהו])\1+$/iu.test(tokens[0])) return "";
  return clean;
}

const LATIN_LANG = new Set([
  "en",
  "es",
  "fr",
  "pt",
  "de",
  "it",
  "nl",
  "pl",
  "tr",
  "sv",
  "da",
  "no",
  "fi",
  "ro",
  "hu",
  "cs",
  "id",
  "vi",
  "ms",
  "tl",
  "hr",
  "sk",
  "sw",
]);

export function spokenLang(text: string, whisperLang = "", fallback = "") {
  const heard = isLanguageCode(normLang(whisperLang)) ? normLang(whisperLang) : "";
  const profile = isLanguageCode(normLang(fallback)) ? normLang(fallback) : "";
  if (isStutterGarbage(text) || isGibberishLatin(text)) return profile || heard;

  const he = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const ar = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const kana = (text.match(/[\u3040-\u30FF]/g) || []).length;
  const han = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
  const hangul = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
  const deva = (text.match(/[\u0900-\u097F]/g) || []).length;
  const bengali = (text.match(/[\u0980-\u09FF]/g) || []).length;
  const tamil = (text.match(/[\u0B80-\u0BFF]/g) || []).length;
  const thai = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  const georgian = (text.match(/[\u10A0-\u10FF]/g) || []).length;
  const amharic = (text.match(/[\u1200-\u137F]/g) || []).length;
  const greek = (text.match(/[\u0370-\u03FF]/g) || []).length;
  const latin = (text.match(/[A-Za-zÀ-ÿ]/g) || []).length;

  if (georgian > 0) return "ka";
  if (amharic > 0) return "am";
  if (thai > 0) return "th";
  if (bengali > 0) return "bn";
  if (tamil > 0) return "ta";
  if (deva > 0) return "hi";
  if (greek > 0 && latin < 6) return "el";
  if (hangul > 0) return "ko";

  // Mixed Hebrew + English is common in walkie — don't let 2 Hebrew words
  // mark a whole English sentence as "he" (that skipped translation to Hebrew listeners).
  if (he > 0 && latin >= 6) {
    if (looksLikeEnglish(text) || heard === "en" || (profile === "en" && latin >= he)) {
      return "en";
    }
    if (heard === "he" && he > latin) return "he";
    if (profile === "he" && he > latin) return "he";
    return latin >= he ? "en" : "he";
  }

  if (he > 0 && latin < 6) return "he";
  if (ar > 0 && latin < 6) {
    if (heard === "ar" || heard === "fa" || heard === "ur") return heard;
    return "ar";
  }
  if (cyr > latin && cyr > 0) {
    if (heard === "ru" || heard === "uk" || heard === "bg") return heard;
    return "ru";
  }
  if (kana > 0) return "ja";
  if (han > 0) {
    if (heard === "ja" || heard === "zh") return heard;
    return "zh";
  }

  if (heard && LATIN_LANG.has(heard)) return heard;
  if (latin > 0 && profile && LATIN_LANG.has(profile)) return profile;
  if (heard) return heard;
  if (latin > 0) return "en";
  return detectLang(text) || profile || heard;
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

function parseHeard(raw: string): SttResult {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const looksJson = trimmed.startsWith("{") || /"text"\s*:/.test(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (looksJson) {
    if (start < 0 || end <= start) return { text: "", lang: "" };
    try {
      const data = JSON.parse(trimmed.slice(start, end + 1)) as { text?: string; language?: string };
      return { text: String(data.text || "").trim(), lang: normLang(String(data.language || "")) };
    } catch {
      return { text: "", lang: "" };
    }
  }
  return { text: trimmed, lang: "" };
}

function looksLikeEnglish(text: string) {
  return /\b(the|and|you|are|is|what|how|hey|hello|yes|no|okay|ok|bro|six|seven|four|five|three|two|one|please|thanks|good|now)\b/i.test(
    text,
  );
}

export function detectLang(text: string): string {
  if (!text) return "";
  if (HEBREW.test(text)) return "he";
  if (ARABIC.test(text)) return "ar";
  if (CYRILLIC.test(text)) return "ru";
  if (CJK.test(text)) return "zh";
  if (HANGUL.test(text)) return "ko";
  if (DEVANAGARI.test(text)) return "hi";
  if (THAI.test(text)) return "th";
  if (GREEK.test(text)) return "el";
  if (GEORGIAN.test(text)) return "ka";
  if (ETHIOPIC.test(text)) return "am";
  if (BENGALI.test(text)) return "bn";
  if (TAMIL.test(text)) return "ta";
  if (/[A-Za-zÀ-ÿĀ-ž]/u.test(text)) return "en";
  return "";
}

export function matchesLang(text: string, language: string) {
  if (!text || isHallucination(text)) return false;
  if (language === "he") return HEBREW.test(text);
  if (language === "ar" || language === "fa" || language === "ur") return ARABIC.test(text);
  if (language === "ru" || language === "uk" || language === "bg") return CYRILLIC.test(text);
  if (language === "ja" || language === "zh") return CJK.test(text);
  if (language === "ko") return HANGUL.test(text);
  if (language === "hi") return DEVANAGARI.test(text);
  if (language === "th") return THAI.test(text);
  if (language === "el") return GREEK.test(text);
  if (language === "ka") return GEORGIAN.test(text);
  if (language === "am") return ETHIOPIC.test(text);
  if (language === "bn") return BENGALI.test(text);
  if (language === "ta") return TAMIL.test(text);
  if (HEBREW.test(text) || ARABIC.test(text) || CJK.test(text) || HANGUL.test(text)) return false;
  return /[A-Za-zÀ-ÿĀ-ž]/u.test(text);
}

export function normLang(code: string) {
  const raw = (code || "").toLowerCase().trim();
  if (!raw) return "";
  if (raw === "iw" || raw === "heb" || raw === "hebrew") return "he";
  if (raw === "ara" || raw === "arabic") return "ar";
  if (raw === "urd" || raw === "urdu") return "ur";
  if (raw === "fas" || raw === "per" || raw === "persian" || raw === "farsi") return "fa";
  if (raw === "chi" || raw === "chinese" || raw === "cmn") return "zh";
  if (raw === "fil" || raw === "tl") return "tl";
  if (raw === "nb" || raw === "nn" || raw === "nor") return "no";
  if (raw === "jpn" || raw === "japanese") return "ja";
  if (raw === "kor" || raw === "korean") return "ko";
  if (raw === "tur") return "tr";
  if (raw === "ukr") return "uk";
  if (raw === "pol" || raw === "po") return "pl";
  const two = raw.slice(0, 2);
  return isLanguageCode(two) ? two : "";
}

function clip(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

function mimeOf(filePath: string) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg" || ext === ".oga") return "audio/ogg";
  if (ext === ".webm") return "audio/webm";
  return "audio/mp4";
}
