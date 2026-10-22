import { LANGUAGE_BY_CODE, isLanguageCode, type LanguageCode } from "@talk/shared";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BottomNav } from "../../src/components/BottomNav";
import { LanguagePicker } from "../../src/components/LanguagePicker";
import { MicIcon } from "../../src/components/MirsIcons";
import { useI18n } from "../../src/i18n";
import { useAuth } from "../../src/lib/auth";
import { ensureMicForRecord } from "../../src/lib/permissions";
import { colors } from "../../src/lib/theme";
import {
  resetTranslatorCapture,
  runTranslatorTurn,
  startTranslatorCapture,
  stopTranslatorCapture,
} from "../../src/lib/translator";

const FROM_KEY = "talk.translator.from";
const TO_KEY = "talk.translator.to";

function asLang(value: string | null | undefined, fallback: LanguageCode): LanguageCode {
  return value && isLanguageCode(value) ? value : fallback;
}

function langName(code: LanguageCode) {
  return LANGUAGE_BY_CODE[code]?.nativeName || code;
}

export default function TranslatorScreen() {
  const { t } = useI18n();
  const { token, user } = useAuth();
  const heldRef = useRef(false);
  const startingRef = useRef(false);
  const recordingRef = useRef(false);
  const turnRef = useRef(0);
  const [sourceLang, setSourceLang] = useState<LanguageCode>(() => asLang(user?.speakLang, "he"));
  const [targetLang, setTargetLang] = useState<LanguageCode>(() => {
    const hear = asLang(user?.listenLang, "en");
    const speak = asLang(user?.speakLang, "he");
    return hear === speak ? (speak === "he" ? "en" : "he") : hear;
  });
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [spoken, setSpoken] = useState("");
  const [translated, setTranslated] = useState("");
  const [heardLang, setHeardLang] = useState<LanguageCode | null>(null);
  const [saidLang, setSaidLang] = useState<LanguageCode | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rawFrom = await SecureStore.getItemAsync(FROM_KEY).catch(() => null);
      const rawTo = await SecureStore.getItemAsync(TO_KEY).catch(() => null);
      if (!alive) return;
      const nextFrom = rawFrom && isLanguageCode(rawFrom) ? rawFrom : null;
      const nextTo = rawTo && isLanguageCode(rawTo) ? rawTo : null;
      if (nextFrom) setSourceLang(nextFrom);
      if (nextTo) setTargetLang(nextFrom && nextTo === nextFrom ? (nextFrom === "he" ? "en" : "he") : nextTo);
    })();
    return () => {
      alive = false;
      turnRef.current += 1;
      void resetTranslatorCapture();
    };
  }, []);

  const persist = useCallback((from: LanguageCode, to: LanguageCode) => {
    void SecureStore.setItemAsync(FROM_KEY, from).catch(() => undefined);
    void SecureStore.setItemAsync(TO_KEY, to).catch(() => undefined);
  }, []);

  function changeSource(code: LanguageCode) {
    setSourceLang(code);
    const nextTo = code === targetLang ? (code === "he" ? "en" : "he") : targetLang;
    if (nextTo !== targetLang) setTargetLang(nextTo);
    persist(code, nextTo);
    setSpoken("");
    setTranslated("");
    setHeardLang(null);
    setSaidLang(null);
  }

  function changeTarget(code: LanguageCode) {
    setTargetLang(code);
    const nextFrom = code === sourceLang ? (code === "he" ? "en" : "he") : sourceLang;
    if (nextFrom !== sourceLang) setSourceLang(nextFrom);
    persist(nextFrom, code);
    setSpoken("");
    setTranslated("");
    setHeardLang(null);
    setSaidLang(null);
  }

  async function beginHold() {
    if (startingRef.current || recordingRef.current) return;
    heldRef.current = true;
    startingRef.current = true;
    turnRef.current += 1;
    try {
      const micOk = await ensureMicForRecord?.();
      if (!micOk) {
        heldRef.current = false;
        setNote(t("error"));
        return;
      }
      await startTranslatorCapture?.();
      if (!heldRef.current) {
        await stopTranslatorCapture?.();
        return;
      }
      recordingRef.current = true;
      setRecording(true);
      setSpoken("");
      setTranslated("");
      setHeardLang(null);
      setSaidLang(null);
      setNote("");
    } catch (error) {
      heldRef.current = false;
      setNote((error as Error).message || t("error"));
    } finally {
      startingRef.current = false;
    }
  }

  async function endHold() {
    heldRef.current = false;
    if (startingRef.current || !recordingRef.current) return;
    setRecording(false);
    const turn = ++turnRef.current;
    setWorking(true);
    setNote(t("translatorWorking"));
    try {
      const uri = await stopTranslatorCapture?.({ tail: true });
      recordingRef.current = false;
      if (!uri) {
        if (turn === turnRef.current) setNote(t("translatorNoSpeech"));
        return;
      }
      const paint = (result: {
        sourceText?: string;
        translatedText?: string;
        sourceLang?: string;
        targetLang?: string;
      }) => {
        if (turn !== turnRef.current || !result.sourceText) return;
        setSpoken(result.sourceText);
        setTranslated(result.translatedText || "");
        const heard = asLang(result.sourceLang, sourceLang);
        setHeardLang(heard);
        setSaidLang(asLang(result.targetLang, heard === sourceLang ? targetLang : sourceLang));
        setNote("");
        setWorking(false);
      };
      const result = await runTranslatorTurn?.(
        uri,
        sourceLang,
        targetLang,
        user?.voiceGender || "male",
        token,
        paint,
      );
      if (turn !== turnRef.current) return;
      if (!result?.sourceText) {
        setNote(t("translatorNoSpeech"));
        return;
      }
      paint(result);
    } catch (error) {
      if (turn === turnRef.current) setNote((error as Error).message || t("error"));
    } finally {
      recordingRef.current = false;
      if (turn === turnRef.current) setWorking(false);
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <Text style={styles.title}>{t("translator")}</Text>
      <View style={styles.langs}>
        <View style={styles.langCol}>
          <Text style={styles.langLabel}>{t("translatorSource")}</Text>
          <LanguagePicker value={sourceLang} onChange={changeSource} />
        </View>
        <View style={styles.langCol}>
          <Text style={styles.langLabel}>{t("translatorTarget")}</Text>
          <LanguagePicker value={targetLang} onChange={changeTarget} />
        </View>
      </View>
      <View style={styles.panes}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{langName(heardLang || sourceLang)}</Text>
          <Text style={styles.cardText}>{spoken || " "}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{langName(saidLang || targetLang)}</Text>
          <Text style={styles.cardText}>{translated || " "}</Text>
        </View>
      </View>
      <View style={styles.micWrap}>
        <View
          onStartShouldSetResponder={() => !recording}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={() => {
            void beginHold();
          }}
          onResponderRelease={() => {
            void endHold();
          }}
          style={[styles.mic, recording && styles.micOn, working && styles.micPressed]}
        >
          {working ? <ActivityIndicator color="#FFFFFF" size="large" /> : <MicIcon size={54} />}
        </View>
        <Text style={styles.hint}>
          {working ? t("translatorWorking") : recording ? t("translatorRecording") : t("translatorRecord")}
        </Text>
        {note && note !== t("translatorWorking") ? <Text style={styles.note}>{note}</Text> : null}
      </View>
      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 26, fontWeight: "800", marginTop: 8, marginBottom: 12, textAlign: "center" },
  langs: { flexDirection: "row", alignItems: "flex-end", gap: 10, zIndex: 40 },
  langCol: { flex: 1, zIndex: 41 },
  langLabel: { color: colors.muted, fontWeight: "700", fontSize: 13, marginBottom: 6 },
  panes: { flex: 1, marginTop: 12, gap: 10 },
  card: {
    flex: 1,
    backgroundColor: colors.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardLabel: { color: colors.amber, fontWeight: "800", fontSize: 13, marginBottom: 6 },
  cardText: { color: colors.text, fontSize: 20, fontWeight: "700", lineHeight: 28 },
  micWrap: { alignItems: "center", paddingTop: 8, paddingBottom: 6 },
  mic: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.ptt,
    borderWidth: 4,
    borderColor: colors.ring,
    alignItems: "center",
    justifyContent: "center",
  },
  micOn: { backgroundColor: colors.red, borderColor: "#FFFFFF" },
  micPressed: { opacity: 0.84 },
  hint: { color: colors.text, fontWeight: "800", marginTop: 10, textAlign: "center" },
  note: { color: colors.amber, marginTop: 6, textAlign: "center", fontWeight: "700" },
});
