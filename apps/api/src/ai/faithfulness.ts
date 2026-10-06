export type AnchorSpec = {
  keep: string[];
  negation?: boolean;
  target: string;
};

const NEGATION: Record<string, string[]> = {
  he: ["לא", "אין", "אל", "בלי"],
  ru: ["не", "нет", "ни", "без"],
  en: ["not", "no", "don't", "never"],
};

export function normalizeAnchor(text: string) {
  return text
    .toLowerCase()
    .replace(/[.,!?:"'«»״׳]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function missingAnchors(translated: string, spec: AnchorSpec): string[] {
  const hay = normalizeAnchor(translated);
  const missing: string[] = [];
  for (const token of spec.keep) {
    const needle = normalizeAnchor(token);
    if (needle && !hay.includes(needle)) missing.push(token);
  }
  if (spec.negation) {
    const marks = NEGATION[spec.target] || NEGATION.en;
    if (!marks.some((mark) => hay.includes(normalizeAnchor(mark)))) missing.push("NEGATION");
  }
  return missing;
}

export function extractNumbers(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}
