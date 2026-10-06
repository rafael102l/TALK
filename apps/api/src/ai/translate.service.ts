import { Injectable, Logger } from "@nestjs/common";
import { LANGUAGE_BY_CODE, isLanguageCode } from "@talk/shared";
import { faithfulnessReason, wrongScript } from "./gate";
import { collapseRepeats, isStutterGarbage } from "./stt.service";

const GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
];

function langName(code: string) {
  return isLanguageCode(code) ? LANGUAGE_BY_CODE[code].nameEn : code;
}

function understandPrompt(source: string, target: string, names: string[], written = false) {
  return [
    written
      ? `Someone typed this message. The likely language is ${langName(source)}.`
      : `Someone just spoke this walkie-talkie message. The likely language is ${langName(source)}.`,
    `Translate it into ${langName(target)} for the listener's device.`,
    "CRITICAL: Translate ONLY what was said. Do not add any sentence, clause, greeting, goodbye, question, or explanation that is not in the source.",
    "Do not pad, expand, or 'help' the speaker. If the source is short, the translation must stay short.",
    "Never stretch filler sounds (uh, ah, oh, hmm, אהה, אממ) into long moans or repeated syllables. One short filler is enough, then the real words.",
    "If the source is mostly nonsense stutter or the same syllable repeated, return a single short filler or empty — do not invent a dramatic line.",
    "If the words are clearly a different language than the hint, translate from the actual language.",
    "Write in the target language's usual script. Do not transliterate into Latin letters unless that language is normally written in Latin.",
    "Word lock: every source word keeps its own meaning. The intent stays the same. Do not change a word into a different word.",
    "Do not swap a word for a synonym, a cleaner phrase, or a more natural sentence.",
    "Example of the required match: מה שלומך אחי stays that same check-in to a brother. It must not become a different greeting.",
    "Example of the required match: תבוא לבית הזה פה למעלה keeps come, this house, here, and up. It must not become a smoother invitation.",
    "Same words, same intent, same tone, same number of ideas — nothing extra and nothing missing.",
    "A question stays a question. Slang stays that slang, with the same sense, not a formal replacement.",
    "Every number stays that exact number. If they said 6, write 6 — never 4.",
    "Do not summarize. Do not casualize. Do not guess a cleaner or longer sentence.",
    "Do not turn a name or a title into something else. Copy personal names in the original spelling.",
    names.length ? `Names that may appear: ${names.join(", ")}.` : "",
    "Return only the translation — no quotes, no labels, no commentary.",
  ]
    .filter(Boolean)
    .join(" ");
}

function acceptedTranslation(source: string, raw: string, target: string, written = false) {
  const out = collapseRepeats((raw || "").replace(/\s+/g, " ").trim());
  if (!out) return { text: "", reason: "empty" };
  if (isStutterGarbage(out)) return { text: "", reason: "speech" };
  // Typed chat: deliver a good target-script translation even if sentence-count is imperfect.
  if (written) {
    if (target && wrongScript(out, target)) return { text: "", reason: "script" };
    return { text: out, reason: "" };
  }
  const reason = faithfulnessReason(source, out, target);
  if (reason) return { text: "", reason };
  return { text: out, reason: "" };
}

@Injectable()
export class TranslateService {
  private readonly logger = new Logger(TranslateService.name);
  private readonly dead = new Set<string>();
  private preferred: string | null = null;

  async translate(
    text: string,
    source: string,
    target: string,
    names: string[] = [],
    written = false,
  ): Promise<{ text: string; reason: string }> {
    if (!text || source === target) return { text, reason: "" };
    const started = Date.now();
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    let engine = "none";
    let out = "";
    let reason = "";
    if (geminiKey) {
      const raw = await this.viaGemini(text, source, target, geminiKey, names, written).catch(() => "");
      const held = raw ? await this.holdToWords(text, raw, source, target, geminiKey).catch(() => raw) : "";
      const checked = acceptedTranslation(text, held || raw, target, written);
      if (checked.text) {
        out = checked.text;
        engine = "gemini";
      } else {
        reason = checked.reason;
      }
    }
    if (!out && openaiKey) {
      const strict = await this.viaOpenAi(
        text,
        source,
        target,
        openaiKey,
        names,
        written,
        "gpt-4o",
        written ? 6000 : 4500,
      ).catch(() => "");
      const held = strict ? await this.holdToWords(text, strict, source, target, geminiKey || "").catch(() => strict) : "";
      const checked = acceptedTranslation(text, held || strict, target, written);
      if (checked.text) {
        out = checked.text;
        engine = "openai";
        reason = "";
      } else if (checked.reason) {
        reason = checked.reason;
      }
    }
    this.logger.log(`Translate ${engine} ${source}->${target} ${Date.now() - started}ms "${clip(out)}"`);
    return { text: out, reason: out ? "" : reason || "empty" };
  }

  private async viaGemini(
    text: string,
    source: string,
    target: string,
    key: string,
    names: string[],
    written = false,
  ) {
    const known = names.filter(Boolean).slice(0, 12);
    const prompt = understandPrompt(source, target, known, written);
    const timeoutMs = written ? 5000 : 3500;
    const models = [
      this.preferred && !this.dead.has(this.preferred) ? this.preferred : "",
      ...GEMINI_MODELS,
    ].filter((model, index, all) => model && !this.dead.has(model) && all.indexOf(model) === index);

    for (const model of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: `${prompt}\n\n${text}` }] }],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: written ? 500 : 220,
              },
            }),
          },
        );
        if (!res.ok) {
          this.logger.warn(`Gemini ${model} failed: ${res.status}`);
          if (res.status === 404 || res.status === 400) this.dead.add(model);
          continue;
        }
        const data = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const raw =
          data.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("")
            .trim() ?? "";
        const clean = raw.replace(/^["']|["']$/g, "").trim();
        if (clean) {
          this.preferred = model;
          return clean;
        }
      } catch (error) {
        this.logger.warn(`Gemini ${model} error: ${(error as Error).message}`);
      }
    }
    return "";
  }

  private async holdToWords(source: string, draft: string, from: string, to: string, key: string) {
    if (!key || !draft) return draft;
    const model =
      this.preferred && !this.dead.has(this.preferred)
        ? this.preferred
        : GEMINI_MODELS.find((item) => !this.dead.has(item)) || "";
    if (!model) return draft;
    const prompt = [
      "You are the word-lock gate.",
      `Source language: ${langName(from)}. Target language: ${langName(to)}.`,
      "Compare the draft with the source.",
      "Every source word keeps its own meaning. The intent stays the same.",
      "If the draft drops, adds, or replaces any word or intent, rewrite it word for word.",
      "מה שלומך אחי stays that same check-in to a brother.",
      "תבוא לבית הזה פה למעלה keeps come, this house, here, and up.",
      "If the draft already matches every word and the intent, return the draft unchanged.",
      "Return only the translation.",
      `Source: ${source}`,
      `Draft: ${draft}`,
    ].join("\n");
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(2500),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 220 },
          }),
        },
      );
      if (!res.ok) return draft;
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const clean =
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim() ?? "";
      if (clean && clean !== draft) this.logger.log(`Gate literal ${from}->${to}`);
      return clean || draft;
    } catch (error) {
      this.logger.warn(`Gate literal error: ${(error as Error).message}`);
      return draft;
    }
  }

  private async viaOpenAi(
    text: string,
    source: string,
    target: string,
    key: string,
    names: string[],
    written = false,
    model = "gpt-4o",
    timeoutMs = 5000,
  ) {
    const known = names.filter(Boolean).slice(0, 12);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: understandPrompt(source, target, known, written) },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: written ? 500 : 220,
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "") ?? "";
  }
}

function clip(text: string) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean || "empty";
}
