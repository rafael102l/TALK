import { Injectable, Logger } from "@nestjs/common";
import { LANGUAGE_BY_CODE, isLanguageCode, speechPrompt } from "@talk/shared";
import { faithfulnessReason, wrongScript } from "./gate";
import { collapseRepeats, geminiThinkingConfig, isStutterGarbage } from "./stt.service";

const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
];

function langName(code: string) {
  return speechPrompt(code) || (isLanguageCode(code) ? LANGUAGE_BY_CODE[code].nameEn : code);
}

export type TranslateContext = {
  speakerGender?: string;
  listenerGender?: string;
};

function genderWord(value?: string) {
  if (value === "female") return "female";
  if (value === "child") return "child";
  if (value === "male") return "male";
  return "";
}

function genderLines(ctx?: TranslateContext) {
  const speaker = genderWord(ctx?.speakerGender);
  const listener = genderWord(ctx?.listenerGender);
  return [
    speaker
      ? `Speaker (first person) profile gender: ${speaker}. Inflect first-person forms to match.`
      : "Speaker profile gender is unknown. Infer first-person gender from the source; do not default every verb to masculine.",
    listener
      ? `Listener / addressee (second person) profile gender: ${listener}. Inflect direct address, imperatives, vocatives, and 2nd-person adjectives to match this person only.`
      : "Listener / addressee profile gender is unknown. Infer 2nd-person gender from the source; do not default every verb to masculine.",
    "A sentence may contain several people. Keep them distinct: (1) the speaker, (2) the addressee being spoken to, (3) any third party.",
    "Example: «תגידי לי מה קורה עם הבחורה השנייה מתי היא באה או היא אמרה לי להגיד את זה» — «תגידי» is feminine 2nd-person to the listener; «הבחורה השנייה / היא» is a different female third party. Do not mix those two.",
    "Never apply the addressee's gender to a third person. Never collapse two subjects into one. Parse pronouns (הוא/היא/את/אתה/you/she/he) against the person they actually refer to.",
  ];
}

function writtenChatPrompt(source: string, target: string, names: string[], ctx?: TranslateContext) {
  return [
    "You translate personal chat messages: everyday, spontaneous, intimate 1:1 conversation — not documents, not news, not formal letters.",
    `Source is likely ${langName(source)}. Translate into ${langName(target)} for the other person's phone.`,
    "Tone: write the line a native speaker would actually send in chat. Recognize slang, nicknames, flirting, and intimate phrasing, and use the closest natural equivalent in the target — not a dry word-for-word gloss.",
    "Examples of the required feel: «מה המצב בובה שלי» is a warm/intimate check-in, not a robotic «what is the situation my doll»; «בא לי לשכב איתך» keeps the sexual/intimate intent in natural target slang, not a clinical or literal wording.",
    "Do not upgrade slang into formal speech. Do not invent extra intimacy, extra clauses, greetings, or explanations that are not in the source.",
    "CRITICAL: Translate ONLY what was written. If the source is short, stay short. A question stays a question.",
    "If the words are clearly a different language than the hint, translate from the actual language.",
    "Write in the target language's usual script. Do not transliterate into Latin letters unless that language is normally written in Latin.",
    "Every number stays that exact number. Copy personal names in the original spelling.",
    ...genderLines(ctx),
    names.length ? `Names that may appear: ${names.join(", ")}.` : "",
    "OUTPUT: return only the clean translated message.",
    "No preface, no labels, no quotes around the whole output, no explanations, no translator notes, no comments in parentheses or brackets, no alternative translations, no repeated copy of the same line.",
  ]
    .filter(Boolean)
    .join(" ");
}

function spokenWalkiePrompt(source: string, target: string, names: string[]) {
  return [
    `Someone just spoke this walkie-talkie message. The likely language is ${langName(source)}.`,
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

function understandPrompt(
  source: string,
  target: string,
  names: string[],
  written = false,
  ctx?: TranslateContext,
) {
  return written
    ? writtenChatPrompt(source, target, names, ctx)
    : spokenWalkiePrompt(source, target, names);
}

function cleanWrittenOutput(raw: string) {
  const stripped = (raw || "").replace(/^["'`]+|["'`]+$/g, "").trim();
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] === line) continue;
    if (deduped.join(" ") === line) continue;
    deduped.push(line);
  }
  return collapseRepeats(deduped.join("\n").replace(/[ \t]+/g, " ").trim());
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
    ctx?: TranslateContext,
  ): Promise<{ text: string; reason: string }> {
    if (!text || source === target) return { text, reason: "" };
    const started = Date.now();
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    let engine = "none";
    let out = "";
    let reason = "";
    if (geminiKey) {
      const raw = await this.viaGemini(text, source, target, geminiKey, names, written, ctx).catch(() => "");
      // Word-lock gate is a second paid Gemini call — run it only when the draft is
      // already flagged as off-rules (extra/missing sentence, changed number, wrong
      // script, garbled). A clean draft is trusted and skips the gate.
      const needsHold = Boolean(raw) && Boolean(acceptedTranslation(text, raw, target, written).reason);
      const held = needsHold
        ? await this.holdToWords(text, raw, source, target, geminiKey, written, ctx).catch(() => raw)
        : "";
      const checked = acceptedTranslation(text, held || raw, target, written);
      if (checked.text) {
        out = written ? cleanWrittenOutput(checked.text) : checked.text;
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
        written ? 10000 : 10000,
        ctx,
      ).catch(() => "");
      // Same word-lock gate, only when the OpenAI draft is itself flagged as off-rules.
      const needsHold = Boolean(strict) && Boolean(acceptedTranslation(text, strict, target, written).reason);
      const held = needsHold
        ? await this.holdToWords(text, strict, source, target, geminiKey || "", written, ctx).catch(() => strict)
        : "";
      const checked = acceptedTranslation(text, held || strict, target, written);
      if (checked.text) {
        out = written ? cleanWrittenOutput(checked.text) : checked.text;
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
    ctx?: TranslateContext,
  ) {
    const known = names.filter(Boolean).slice(0, 12);
    const prompt = understandPrompt(source, target, known, written, ctx);
    const timeoutMs = written ? 8000 : 8000;
    const models = [
      this.preferred && !this.dead.has(this.preferred) ? this.preferred : "",
      ...GEMINI_MODELS,
    ].filter((model, index, all) => model && !this.dead.has(model) && all.indexOf(model) === index);

    for (const model of models) {
      try {
        const generationConfig: Record<string, unknown> = {
          temperature: 0,
          maxOutputTokens: written ? 1024 : 1024,
        };
        const thinkingConfig = geminiThinkingConfig(model);
        if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: `${prompt}\n\n${text}` }] }],
              generationConfig,
            }),
          },
        );
        if (!res.ok) {
          this.logger.warn(`Gemini ${model} failed: ${res.status}`);
          if (res.status === 404) this.dead.add(model);
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
        if (finish === "MAX_TOKENS") {
          this.logger.warn(`Gemini translate ${model} truncated (MAX_TOKENS)`);
          continue;
        }
        const raw =
          candidate?.content?.parts
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

  private async holdToWords(
    source: string,
    draft: string,
    from: string,
    to: string,
    key: string,
    written = false,
    ctx?: TranslateContext,
  ) {
    if (!key || !draft) return draft;
    const model =
      this.preferred && !this.dead.has(this.preferred)
        ? this.preferred
        : GEMINI_MODELS.find((item) => !this.dead.has(item)) || "";
    if (!model) return draft;
    const prompt = written
      ? [
          "Fix this personal-chat translation so it is natural in the target language and script.",
          `Source language: ${langName(from)}. Target language: ${langName(to)}.`,
          "Keep the meaning, slang, and intimacy. Keep speaker / addressee / third-party genders distinct.",
          ...genderLines(ctx),
          "Return only the clean translated message — no notes, no parentheses comments, no duplicate lines.",
          `Source: ${source}`,
          `Draft: ${draft}`,
        ].join("\n")
      : [
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
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 1024,
              ...(geminiThinkingConfig(model) ? { thinkingConfig: geminiThinkingConfig(model) } : {}),
            },
          }),
        },
      );
      if (!res.ok) return draft;
      const data = (await res.json()) as {
        candidates?: {
          finishReason?: string;
          content?: { parts?: { text?: string }[] };
        }[];
      };
      const candidate = data.candidates?.[0];
      if (String(candidate?.finishReason || "").toUpperCase() === "MAX_TOKENS") return draft;
      const clean =
        candidate?.content?.parts
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
    ctx?: TranslateContext,
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
          { role: "system", content: understandPrompt(source, target, known, written, ctx) },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: written ? 1024 : 1024,
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      choices?: {
        finish_reason?: string;
        message?: { content?: string };
      }[];
    };
    const choice = data.choices?.[0];
    if (String(choice?.finish_reason || "").toLowerCase() === "length") {
      throw new Error("truncated");
    }
    return choice?.message?.content?.trim().replace(/^["']|["']$/g, "") ?? "";
  }
}

function clip(text: string) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean || "empty";
}
