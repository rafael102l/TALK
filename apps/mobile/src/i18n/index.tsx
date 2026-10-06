import { LanguageCode, isLanguageCode } from "@talk/shared";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { CATALOG, deviceLanguage, isRtlLang, translateMsg, type MsgKey } from "./catalog";

type I18nValue = {
  lang: LanguageCode;
  rtl: boolean;
  align: "left" | "right";
  row: "row" | "row-reverse";
  t: (key: MsgKey, vars?: Record<string, string>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const lang: LanguageCode =
    (user?.speakLang && isLanguageCode(user.speakLang) && user.speakLang) ||
    (user?.listenLang && isLanguageCode(user.listenLang) ? user.listenLang : deviceLanguage());
  const value = useMemo<I18nValue>(() => {
    const rtl = isRtlLang(lang);
    return {
      lang,
      rtl,
      align: rtl ? "right" : "left",
      row: rtl ? "row-reverse" : "row",
      t: (key, vars) => translateMsg(lang, key, vars),
    };
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    const lang = deviceLanguage();
    const rtl = isRtlLang(lang);
    return {
      lang,
      rtl,
      align: rtl ? "right" : "left" as const,
      row: rtl ? "row-reverse" : "row" as const,
      t: (key: MsgKey, vars?: Record<string, string>) => translateMsg(lang, key, vars),
    };
  }
  return ctx;
}

export { CATALOG, type MsgKey };
