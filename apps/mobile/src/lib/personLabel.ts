export function looksLikePhone(value: string) {
  return /^\+?\d[\d\s-]{6,}$/.test(value.replace(/\s/g, ""));
}

export function personLabel(name?: string | null, phone?: string | null) {
  const n = (name || "").trim();
  const p = (phone || "").trim();
  const stripped = n.replace(/[\s,;|/·•-]*\+?\d[\d\s-]{6,}\s*$/g, "").trim();
  if (stripped && !looksLikePhone(stripped)) return stripped;
  return p || n;
}
