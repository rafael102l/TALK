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

function translateSystem(source: string, target: string, retry = false) {
  const src = langTitle(source);
  const dst = langTitle(target);
  return [
    STRICT_TRANSLATE,
    `Input language: ${src}. Output language: ${dst}.`,
    `Translate the user's sentence into ${dst} only, using that language's own words and usual script.`,
    "Never transliterate. Never romanize. Never copy the source in Latin letters.",
    "Example: Hebrew לילה טוב becomes Romanian Noapte bună. Never write Laila Tov.",
    "Do not answer questions. If the input is a question, translate the question itself.",
    "Never output instructions or refusals such as 'do not translate' or 'אל תתרגם'.",
    retry
      ? `The previous output was a transliteration, still in ${src}, or not a real ${dst} sentence. Write a natural ${dst} translation only.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type Turn = {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
};
const recentTurns = new Map<string, { at: number; turn: Turn }>();
const inflightTurns = new Map<string, Promise<Turn>>();

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
      let hash = input.audio.length;
      const step = Math.max(1, Math.floor(input.audio.length / 80));
      for (let i = 0; i < input.audio.length; i += step) hash = (Math.imul(hash, 31) + input.audio[i]) | 0;
      const pair = langA < langB ? `${langA}:${langB}` : `${langB}:${langA}`;
      const key = `${input.audio.length}:${hash}:${pair}`;
      const hit = recentTurns.get(key);
      if (hit && Date.now() - hit.at < 45_000) return hit.turn;
      const pending = inflightTurns.get(key);
      if (pending) return pending;
      const job = (async () =>
        (await this.hearAndTranslate(input.audio!, input.mime || "audio/mp4", input.ext || "m4a", langA, langB)) || empty)();
      inflightTurns.set(key, job);
      try {
        const turn = await job;
        if (turn.sourceText) recentTurns.set(key, { at: Date.now(), turn });
        return turn;
      } finally {
        inflightTurns.delete(key);
      }
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
    // Gender from clip runs in parallel with STT/translate — free local pitch, no TTS cost.
    const genderPromise = this.detectSpeakerGender(input.audio, input.ext).catch(() => undefined);
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
        speakerGender: (await genderPromise) || undefined,
      };
    }
    const sourceText = (turn.sourceText || "").replace(/\s+/g, " ").trim();
    const translatedText = (turn.translatedText || "").replace(/\s+/g, " ").trim();
    const speakerGender = (await genderPromise) || undefined;
    // Translator page: return text immediately. Speech is played on-device via
    // /ai/translator/speak (or local TTS) after the panes update — do not block on TTS here.
    return {
      sourceText,
      translatedText,
      sourceLang,
      targetLang,
      audioBase64: "",
      mime: "audio/mpeg" as const,
      speakerGender,
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
    // Hear the clip once (the transcript is needed either way), then try the free,
    // local script detector first. The two paid Gemini audio-detect calls only run
    // when the script cannot decide — e.g. both languages share one script (en+es, ru+uk).
    const auto = await this.whisperAuto(audio, mime, ext, langA, langB);
    const autoLang = matchChoice(whisperLangCode(auto.language), langA, langB);
    const textAuto = keepPairTranscript(auto.text, langA, langB);
    const scriptLang = pickByScript(textAuto || auto.text, langA, langB);
    // A unique-script hit (Hebrew, Arabic, Cyrillic, …) already wins in choosePairSource,
    // so Gemini-detect would not change the result — skip it in that common case.
    const scriptDecides = Boolean(matchChoice(scriptLang, langA, langB) && uniqueScript(scriptLang));
    let geminiLang = "";
    if (!scriptDecides) {
      const [detectedAB, detectedBA] = await Promise.all([
        this.detectSpokenLang(audio, mime, ext, langA, langB),
        this.detectSpokenLang(audio, mime, ext, langB, langA),
      ]);
      geminiLang = detectedAB && detectedBA && detectedAB === detectedBA ? matchChoice(detectedAB, langA, langB) : "";
    }
    const sourceLang = choosePairSource(scriptLang, geminiLang, autoLang, langA, langB);
    if (!sourceLang) return null;
    let text = textAuto;
    if (!transcriptFitsLang(text, sourceLang, langA, langB)) {
      const locked = await this.whisperFor(audio, sourceLang, mime, ext);
      const lockedText = sanitizeTranscript(locked.text);
      text = transcriptFitsLang(lockedText, sourceLang, langA, langB) ? lockedText : "";
    }
    if (!text) return null;
    const targetLang = otherLang(sourceLang, langA, langB);
    if (!targetLang) return null;
    this.logger.log(`translator-detect ${geminiLang || autoLang || scriptLang || "?"} => ${sourceLang}->${targetLang} ${clip(text)}`);
    return this.finishTurn(text, sourceLang, targetLang);
  }

  private async detectSpokenLang(audio: Buffer, mime: string, ext: string, langA: string, langB: string) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !audio.length) return null;
    const constraint = [
      "Classify which of TWO allowed languages was spoken.",
      `The spoken language MUST be exactly "${langA}" (${langTitle(langA)}) or exactly "${langB}" (${langTitle(langB)}).`,
      "It is forbidden to choose English or any other language unless that language is one of those two codes.",
      "If the speaker used a unique-script language in the pair (for example Hebrew), return that code even if the words could be written in Latin letters.",
      `Return JSON {"lang":"${langA}"} or {"lang":"${langB}"} or {"lang":"unknown"} only when there is no speech.`,
      "Do not transcribe. Do not translate. Do not romanize.",
    ].join(" ");
    for (const model of GEMINI_DETECT_MODELS) {
      try {
        const generationConfig: Record<string, unknown> = {
          temperature: 0.0,
          maxOutputTokens: 256,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { lang: { type: "STRING", enum: [langA, langB, "unknown"] } },
            required: ["lang"],
          },
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
                  parts: [{ inlineData: { mimeType: geminiAudioMime(mime, ext), data: audio.toString("base64") } }],
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
          ? `Allowed languages only: ${langTitle(langB)} and ${langTitle(langA)}. Transcribe in the native script of whichever of those two was spoken. Never write English unless English is one of those two. Never romanize. Never transliterate Hebrew or other unique-script speech into Latin letters.`
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
    if (!isTargetTranslation(sourceText, translatedText, sourceLang, targetLang)) {
      translatedText = await this.translateFast(sourceText, sourceLang, targetLang, true).catch((error) => {
        logTranslateFail(`translator-translate retry ${sourceLang}->${targetLang} ${(error as Error).message}`);
        return "";
      });
    }
    if (!isTargetTranslation(sourceText, translatedText, sourceLang, targetLang)) translatedText = "";
    this.logger.log(`translator ${sourceLang}->${targetLang} ${clip(sourceText)} => ${clip(translatedText)}`);
    return { sourceText, translatedText, sourceLang, targetLang };
  }

  private async translateFast(text: string, source: string, target: string, retry = false) {
    const system = translateSystem(source, target, retry);
    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (geminiKey) {
      for (const model of GEMINI_TRANSLATE_MODELS) {
        const out = await this.viaGeminiTranslate(model, system, text, geminiKey);
        if (isTargetTranslation(text, out, source, target)) return out;
      }
    } else {
      logTranslateFail("translator-translate missing GEMINI_API_KEY");
    }
    const openaiKey = process.env.OPENAI_API_KEY || "";
    if (openaiKey) {
      const out = await this.viaOpenAiTranslate(text, source, target, openaiKey, retry);
      if (isTargetTranslation(text, out, source, target)) return out;
    } else {
      logTranslateFail("translator-translate missing OPENAI_API_KEY");
    }
    logTranslateFail(`translator-translate all engines failed ${source}->${target}`);
    return "";
  }

  private async viaGeminiTranslate(model: string, system: string, text: string, key: string) {
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
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text }] }],
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

  private async viaOpenAiTranslate(text: string, source: string, target: string, key: string, retry = false) {
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
              content: translateSystem(source, target, retry),
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

  /** Free local pitch guess from the uploaded clip. Never bills a TTS/STT API. */
  private async detectSpeakerGender(audio?: Buffer, ext?: string): Promise<VoiceGender | undefined> {
    if (!audio?.length) return undefined;
    const fs = await import("fs/promises");
    const os = await import("os");
    const path = await import("path");
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const exec = promisify(execFile);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "talk-gender-"));
    const inFile = path.join(dir, `in.${(ext || "m4a").replace(/[^a-z0-9]/gi, "") || "m4a"}`);
    const outFile = path.join(dir, "out.s16le");
    try {
      await fs.writeFile(inFile, audio);
      await exec(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-y", "-i", inFile, "-ac", "1", "-ar", "16000", "-f", "s16le", outFile],
        { timeout: 2500 },
      );
      const pcm = await fs.readFile(outFile);
      if (pcm.length < 3200) return undefined;
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
      const rate = 16000;
      const minF = 70;
      const maxF = 400;
      const minPeriod = Math.floor(rate / maxF);
      const maxPeriod = Math.floor(rate / minF);
      const win = Math.min(samples.length, Math.floor(rate * 0.65));
      const start = Math.max(0, Math.floor((samples.length - win) / 2));
      let mean = 0;
      for (let i = 0; i < win; i++) mean += samples[start + i];
      mean /= win;
      const vals = new Float64Array(win);
      let energy = 0;
      for (let i = 0; i < win; i++) {
        const v = (samples[start + i] - mean) / 32768;
        vals[i] = v;
        energy += v * v;
      }
      if (energy / win < 1e-5) return undefined;
      let bestPeriod = -1;
      let bestCorr = 0;
      for (let period = minPeriod; period <= maxPeriod; period++) {
        const n = win - period;
        if (n < period) continue;
        let corr = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < n; i++) {
          const a = vals[i];
          const b = vals[i + period];
          corr += a * b;
          normA += a * a;
          normB += b * b;
        }
        const denom = Math.sqrt(normA * normB);
        if (denom < 1e-9) continue;
        const r = corr / denom;
        if (r > bestCorr) {
          bestCorr = r;
          bestPeriod = period;
        }
      }
      if (bestPeriod < 0 || bestCorr < 0.35) return undefined;
      const hz = rate / bestPeriod;
      if (hz >= 255) return "child";
      if (hz >= 175) return "female";
      return "male";
    } catch {
      return undefined;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
  /^(?:sorry|i'?m sorry|i am sorry|i cannot|i can't|as an ai|i'?m unable|unable to translate|i do not understand|please provide|could you clarify|do not translate|don't translate|do not transliterate)/i;
const REFUSAL_HE =
  /^(?:מצטער|אני מצטער|אני לא יכול|לא ניתן|לא הבנתי|אנא ספק|לא מצליח לתרגם|אל תתרגם|לא לתרגם)/;

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
  // Unique-script side wins when its letters are present.
  if (onlyB && uniqueScript(langB)) return langB;
  if (onlyA && uniqueScript(langA)) return langA;
  // Latin-only text in a unique+Latin pair: accept the Latin language unless it looks like
  // romanized dump of the unique-script side (e.g. Whisper "LA ILA TOV" for Hebrew).
  if (onlyB && !uniqueScript(langB) && uniqueScript(langA) && !looksLikePhoneticDump(text)) return langB;
  if (onlyA && !uniqueScript(langA) && uniqueScript(langB) && !looksLikePhoneticDump(text)) return langA;
  if (onlyB && !uniqueScript(langA) && !uniqueScript(langB)) return langB;
  if (onlyA && !uniqueScript(langA) && !uniqueScript(langB)) return langA;
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
  if (isJunkSpeech(value) || isEnglishLeak(value, langA, langB)) return "";
  if (pickByScript(value, langA, langB)) return value;
  const unique = uniquePairSide(langA, langB);
  if (unique && hasScript(value, unique)) return value;
  // Unique + Latin pair: keep Latin transcript for the Latin side (do not drop real French/etc.).
  // Only reject clear romanized dumps of the unique-script language.
  const latin = unique ? otherLang(unique, langA, langB) : "";
  if (unique && latin && hasScript(value, latin) && !hasScript(value, unique)) {
    if (looksLikePhoneticDump(value)) return "";
    return value;
  }
  if (hasScript(value, langA) || hasScript(value, langB)) return value;
  if (!uniqueScript(langA) && !uniqueScript(langB)) return value;
  return "";
}

function pickSpoken(detected: string | null, autoLang: string, text: string, langA: string, langB: string) {
  return choosePairSource(
    pickByScript(text, langA, langB),
    matchChoice(detected || "", langA, langB),
    matchChoice(autoLang || whisperLangCode(autoLang), langA, langB),
    langA,
    langB,
  );
}

function uniquePairSide(langA: string, langB: string) {
  const a = uniqueScript(langA);
  const b = uniqueScript(langB);
  if (a && !b) return langA;
  if (b && !a) return langB;
  return "";
}

function choosePairSource(scriptLang: string, geminiLang: string, autoLang: string, langA: string, langB: string) {
  const script = matchChoice(scriptLang, langA, langB);
  const gemini = matchChoice(geminiLang, langA, langB);
  const auto = matchChoice(autoLang, langA, langB);
  if (script && uniqueScript(script)) return script;
  if (gemini) return gemini;
  if (auto && uniqueScript(auto)) return auto;
  // Accept Whisper/auto for either side of the pair (including Latin when the other is Hebrew/etc.).
  if (auto) return auto;
  if (script) return script;
  return "";
}

function transcriptFitsLang(text: string, lang: string, langA: string, langB: string) {
  const value = sanitizeTranscript(text);
  if (!value || isJunkSpeech(value) || isEnglishLeak(value, langA, langB)) return false;
  if (!matchChoice(lang, langA, langB)) return false;
  if (uniqueScript(lang)) return hasScript(value, lang);
  const other = otherLang(lang, langA, langB);
  if (other && uniqueScript(other) && looksLikePhoneticDump(value)) return false;
  return hasScript(value, lang);
}

function looksLikePhoneticDump(text: string) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase() && /[A-Z]/.test(letters);
}

function isEnglishLeak(text: string, langA: string, langB: string) {
  if (sameChoice(langA, "en") || sameChoice(langB, "en")) return false;
  const value = sanitizeTranscript(text);
  if (!/^[A-Za-z0-9\s'",.!?-]+$/.test(value)) return false;
  return /\b(the|and|you|your|good|night|please|hello|thanks|what|this|that|with|from|have|don't|do not|translate|thank you)\b/i.test(
    value,
  );
}

function canSpeakTranslation(text: string, sourceLang: string, targetLang: string) {
  if (!text || sourceLang === targetLang) return false;
  if (uniqueScript(targetLang) && !hasScript(text, targetLang)) return false;
  if (uniqueScript(sourceLang) && hasScript(text, sourceLang) && !hasScript(text, targetLang)) return false;
  return true;
}

function isTargetTranslation(source: string, output: string, sourceLang: string, targetLang: string) {
  const original = sanitizeTranscript(source);
  const out = sanitizeTranscript(output);
  if (!original || !out || out === original) return false;
  if (isMetaTranslation(out)) return false;
  if (!canSpeakTranslation(out, sourceLang, targetLang)) return false;
  if (looksLikeTransliteration(original, out, sourceLang, targetLang)) return false;
  if (isEnglishLeak(out, sourceLang, targetLang)) return false;
  return true;
}

function isMetaTranslation(text: string) {
  return /do not translate|don't translate|do not transliterate|אל תתרגם|לא לתרגם/i.test(text);
}

function looksLikeTransliteration(source: string, output: string, sourceLang: string, targetLang: string) {
  if (!uniqueScript(sourceLang) || uniqueScript(targetLang)) return false;
  const roman = romanizeSource(source) || (!hasScript(source, sourceLang) ? source : "");
  if (!roman) return false;
  const left = foldLatin(roman);
  const right = foldLatin(output);
  if (!left || !right) return false;
  if (left === right) return true;
  if (textSimilarity(left, right) >= 0.72) return true;
  return textSimilarity(consonantKey(left), consonantKey(right)) >= 0.8;
}

function romanizeSource(text: string) {
  if (/[\u0590-\u05FF]/.test(text)) return romanizeHebrew(text);
  if (/[\u0600-\u06FF]/.test(text)) return romanizeArabic(text);
  if (/[\u0400-\u04FF]/.test(text)) return romanizeCyrillic(text);
  return "";
}

const HE_LATIN: Record<string, string> = {
  א: "a",
  ב: "b",
  ג: "g",
  ד: "d",
  ה: "a",
  ו: "o",
  ז: "z",
  ח: "h",
  ט: "t",
  י: "i",
  כ: "k",
  ך: "k",
  ל: "l",
  מ: "m",
  ם: "m",
  נ: "n",
  ן: "n",
  ס: "s",
  ע: "a",
  פ: "p",
  ף: "f",
  צ: "z",
  ץ: "z",
  ק: "k",
  ר: "r",
  ש: "sh",
  ת: "t",
};

function romanizeHebrew(text: string) {
  return [...text].map((ch) => (ch === " " ? " " : HE_LATIN[ch] || "")).join("");
}

const AR_LATIN: Record<string, string> = {
  ا: "a",
  ب: "b",
  ت: "t",
  ث: "th",
  ج: "j",
  ح: "h",
  خ: "kh",
  د: "d",
  ذ: "dh",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "q",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  و: "w",
  ي: "y",
  ة: "a",
  ى: "a",
  ء: "a",
  أ: "a",
  إ: "i",
  آ: "a",
};

function romanizeArabic(text: string) {
  return [...text].map((ch) => (ch === " " ? " " : AR_LATIN[ch] || "")).join("");
}

const CY_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ы: "i",
  э: "e",
  ю: "u",
  я: "ya",
  і: "i",
  ї: "i",
  є: "e",
  ґ: "g",
};

function romanizeCyrillic(text: string) {
  return [...text].map((ch) => {
    if (ch === " ") return " ";
    return CY_LATIN[ch.toLowerCase()] || "";
  }).join("");
}

function foldLatin(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function consonantKey(text: string) {
  return foldLatin(text).replace(/[aeiouy]+/g, "");
}

function textSimilarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  const row = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= m; j++) {
      const cur = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = cur;
    }
  }
  return 1 - row[m] / Math.max(n, m);
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
