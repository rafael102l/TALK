import { useEffect, useState } from "react";
import { api } from "./api";

const cache = new Map<string, string>();

function sourceOf(name: string) {
  if (/[\u0590-\u05FF]/.test(name)) return "he";
  if (/[\u0600-\u06FF]/.test(name)) return "ar";
  if (/[\u0400-\u04FF]/.test(name)) return "ru";
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(name)) return "ja";
  return "en";
}

export function useTranslatedNames(names: string[], lang: string, token?: string | null) {
  const [map, setMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const unique = [...new Set(names.filter(Boolean))];
    void (async () => {
      const next: Record<string, string> = {};
      for (const name of unique) {
        const source = sourceOf(name);
        if (source === lang) {
          next[name] = name;
          continue;
        }
        const key = `${lang}:${name}`;
        const hit = cache.get(key);
        if (hit) {
          next[name] = hit;
          continue;
        }
        if (!token) {
          next[name] = name;
          continue;
        }
        try {
          const res = await api<{ text: string }>("/ai/translate", {
            method: "POST",
            token,
            timeoutMs: 4000,
            body: JSON.stringify({ text: name, source, target: lang }),
          });
          const translated = res.text?.trim() || name;
          cache.set(key, translated);
          next[name] = translated;
        } catch {
          next[name] = name;
        }
      }
      if (!cancelled) setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [names.join("|"), lang, token]);

  return (name: string) => map[name] || name;
}
