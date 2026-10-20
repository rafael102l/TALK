const MARK = "\u0001TALKREPLY\u0001";

export type ReplyQuote = {
  id: string;
  name: string;
  text: string;
};

export function decodeReply(raw: string | null | undefined): { text: string; reply?: ReplyQuote } {
  const value = raw || "";
  if (!value.startsWith(MARK)) return { text: value };
  const end = value.indexOf(MARK, MARK.length);
  if (end < 0) return { text: value };
  try {
    const parsed = JSON.parse(value.slice(MARK.length, end)) as ReplyQuote;
    if (!parsed || typeof parsed !== "object") return { text: value.slice(end + MARK.length) };
    return {
      text: value.slice(end + MARK.length),
      reply: {
        id: String(parsed.id || ""),
        name: String(parsed.name || ""),
        text: String(parsed.text || ""),
      },
    };
  } catch {
    return { text: value };
  }
}

export function encodeReply(text: string, reply?: ReplyQuote | null) {
  if (!reply?.id) return text;
  return `${MARK}${JSON.stringify({
    id: reply.id,
    name: (reply.name || "").slice(0, 80),
    text: (reply.text || "").slice(0, 240),
  })}${MARK}${text}`;
}

export function packReply(
  originalText?: string | null,
  reply?: { id?: string; name?: string; text?: string } | null,
) {
  const decoded = decodeReply(originalText || "");
  const next = reply?.id
    ? { id: reply.id, name: reply.name || "", text: reply.text || "" }
    : decoded.reply;
  return encodeReply(decoded.text, next);
}
