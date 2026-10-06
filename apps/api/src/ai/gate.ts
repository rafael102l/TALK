import { extractNumbers } from "./faithfulness";
import { isStutterGarbage } from "./stt.service";

function sentences(text: string) {
  const parts = (text || "")
    .split(/[.!?…؟。！？]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length || ((text || "").trim() ? 1 : 0);
}

const SCRIPT: Record<string, RegExp> = {
  he: /[\u0590-\u05FF]/,
  ar: /[\u0600-\u06FF]/,
  fa: /[\u0600-\u06FF]/,
  ur: /[\u0600-\u06FF]/,
  ru: /[\u0400-\u04FF]/,
  uk: /[\u0400-\u04FF]/,
  bg: /[\u0400-\u04FF]/,
  el: /[\u0370-\u03FF]/,
  hi: /[\u0900-\u097F]/,
  bn: /[\u0980-\u09FF]/,
  ta: /[\u0B80-\u0BFF]/,
  th: /[\u0E00-\u0E7F]/,
  ka: /[\u10A0-\u10FF]/,
  am: /[\u1200-\u137F]/,
  ko: /[\uAC00-\uD7AF]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  zh: /[\u4E00-\u9FFF]/,
};

const LATIN = new Set([
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

export function wrongScript(text: string, language: string) {
  const lang = (language || "").slice(0, 2).toLowerCase();
  const script = SCRIPT[lang];
  if (script) return !script.test(text || "");
  if (LATIN.has(lang)) {
    const foreign = /[\u0590-\u05FF\u0600-\u06FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
    if (foreign.test(text) && !/[A-Za-zÀ-ÿ]/.test(text)) return true;
  }
  return false;
}

export function numberChanged(source: string, out: string) {
  const a = extractNumbers(source);
  const b = extractNumbers(out);
  if (!a.length || !b.length) return false;
  if (a.length !== b.length) return true;
  return a.some((value, index) => value !== b[index]);
}

/** Empty string means the translation may be sent. */
export function faithfulnessReason(source: string, out: string, target = "") {
  const clean = (out || "").replace(/\s+/g, " ").trim();
  if (!clean) return "empty";
  if (isStutterGarbage(clean)) return "speech";
  const sourceSentences = sentences(source);
  const outSentences = sentences(clean);
  if (sourceSentences > 0 && outSentences > sourceSentences) return "sentence";
  if (numberChanged(source, out)) return "number";
  if (target && wrongScript(clean, target)) return "script";
  return "";
}
