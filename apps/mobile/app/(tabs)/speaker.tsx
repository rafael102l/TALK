import { isLanguageCode, languageDisplayName, matchLanguageName, type LanguageCode } from "@talk/shared";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BottomNav } from "../../src/components/BottomNav";
import { LanguagePicker } from "../../src/components/LanguagePicker";
import { MicIcon } from "../../src/components/MirsIcons";
import { useI18n } from "../../src/i18n";
import { deviceLanguage } from "../../src/i18n/catalog";
import { useAuth } from "../../src/lib/auth";
import { ensureMicForRecord } from "../../src/lib/permissions";
import { colors } from "../../src/lib/theme";
import {
  hearTranslatorText,
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

function otherLang(code: LanguageCode): LanguageCode {
  return code === "he" ? "en" : "he";
}

export default function TranslatorScreen() {
  const { t, lang: uiLang } = useI18n();
  const { token, user } = useAuth();
  const heldRef = useRef(false);
  const langHeldRef = useRef(false);
  const startingRef = useRef(false);
  const recordingRef = useRef(false);
  const pickModeRef = useRef(false);
  const turnRef = useRef(0);
  const myLang = asLang(user?.speakLang ?? user?.listenLang, asLang(uiLang, deviceLanguage()));
  const [sourceLang, setSourceLang] = useState<LanguageCode>(() => myLang);
  const [targetLang, setTargetLang] = useState<LanguageCode>(() => otherLang(myLang));
  const [recording, setRecording] = useState(false);
  const [pickingLang, setPickingLang] = useState(false);
  const [working, setWorking] = useState(false);
  const [spoken, setSpoken] = useState("");
  const [translated, setTranslated] = useState("");
  const [heardLang, setHeardLang] = useState<LanguageCode | null>(null);
  const [saidLang, setSaidLang] = useState<LanguageCode | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rawTo = await SecureStore.getItemAsync(TO_KEY).catch(() => null);
      if (!alive) return;
      const nextTo = rawTo && isLanguageCode(rawTo) ? rawTo : null;
      if (nextTo && nextTo !== myLang) setTargetLang(nextTo);
    })();
    return () => {
      alive = false;
      turnRef.current += 1;
      void resetTranslatorCapture();
    };
  }, []);

  useEffect(() => {
    setSourceLang((prev) => (prev === myLang ? prev : myLang));
    setTargetLang((to) => (to === myLang ? otherLang(myLang) : to));
  }, [myLang]);

  const persist = useCallback((from: LanguageCode, to: LanguageCode) => {
    void SecureStore.setItemAsync(FROM_KEY, from).catch(() => undefined);
    void SecureStore.setItemAsync(TO_KEY, to).catch(() => undefined);
  }, []);

  function changeSource(code: LanguageCode) {
    setSourceLang(code);
    const nextTo = code === targetLang ? otherLang(code) : targetLang;
    if (nextTo !== targetLang) setTargetLang(nextTo);
    persist(code, nextTo);
    setSpoken("");
    setTranslated("");
    setHeardLang(null);
    setSaidLang(null);
  }

  function changeTarget(code: LanguageCode) {
    setTargetLang(code);
    persist(sourceLang, code);
    setSpoken("");
    setTranslated("");
    setHeardLang(null);
    setSaidLang(null);
  }

  async function beginHold(pickLang: boolean) {
    if (startingRef.current || recordingRef.current) return;
    if (pickLang) langHeldRef.current = true;
    else heldRef.current = true;
    pickModeRef.current = pickLang;
    startingRef.current = true;
    turnRef.current += 1;
    try {
      const micOk = await ensureMicForRecord?.();
      if (!micOk) {
        heldRef.current = false;
        langHeldRef.current = false;
        setNote(t("error"));
        return;
      }
      await startTranslatorCapture?.();
      if (pickLang ? !langHeldRef.current : !heldRef.current) {
        await stopTranslatorCapture?.();
        return;
      }
      recordingRef.current = true;
      setRecording(!pickLang);
      setPickingLang(pickLang);
      if (!pickLang) {
        setSpoken("");
        setTranslated("");
        setHeardLang(null);
        setSaidLang(null);
      }
      setNote("");
    } catch (error) {
      heldRef.current = false;
      langHeldRef.current = false;
      setNote((error as Error).message || t("error"));
    } finally {
      startingRef.current = false;
    }
  }

  async function endHold(pickLang: boolean) {
    if (pickLang) langHeldRef.current = false;
    else heldRef.current = false;
    if (startingRef.current || !recordingRef.current) return;
    if (pickModeRef.current !== pickLang) return;
    setRecording(false);
    setPickingLang(false);
    const turn = ++turnRef.current;
    setWorking(true);
    setNote(pickLang ? t("translatorSayLangHint") : t("translatorWorking"));
    try {
      const uri = await stopTranslatorCapture?.({ tail: true });
      recordingRef.current = false;
      if (!uri) {
        if (turn === turnRef.current) setNote(t("translatorNoSpeech"));
        return;
      }
      if (pickLang) {
        const heard = await hearTranslatorText(uri, asLang(user?.listenLang, uiLang || "he"), token);
        if (turn !== turnRef.current) return;
        const found = heard ? matchLanguageName(heard) : "";
        if (!found) {
          setNote(t("translatorLangMiss"));
          return;
        }
        changeTarget(found);
        setNote(t("translatorLangFound", { name: languageDisplayName(found, uiLang) }));
        return;
      }
      const paint = (result: {
        sourceText?: string;
        translatedText?: string;
        sourceLang?: string;
        targetLang?: string;
        partial?: boolean;
      }) => {
        if (turn !== turnRef.current) return;
        if (result.sourceText) {
          setSpoken(result.sourceText);
          setHeardLang(sourceLang);
        }
        if (result.partial) {
          setTranslated("");
          setNote(t("translatorWorking"));
          return;
        }
        setTranslated(result.translatedText || "");
        setSaidLang(targetLang);
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

  const busy = working || recording || pickingLang;

  return (
    <SafeAreaView style={styles.page}>
      <Text style={styles.title}>{t("translator")}</Text>
      <View style={styles.langs}>
        <View style={styles.langCol}>
          <Text style={styles.langLabel}>{t("translatorSource")}</Text>
          <LanguagePicker value={sourceLang} onChange={changeSource} />
        </View>
        <View style={styles.langMid}>
          <View
            onStartShouldSetResponder={() => !busy}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderGrant={() => {
              void beginHold(true);
            }}
            onResponderRelease={() => {
              void endHold(true);
            }}
            style={[styles.langMic, pickingLang && styles.micOn]}
          >
            {pickingLang ? <ActivityIndicator color="#FFFFFF" size="small" /> : <MicIcon size={22} />}
          </View>
          <Text style={styles.langMicHint}>{t("translatorSayLang")}</Text>
        </View>
        <View style={styles.langCol}>
          <Text style={styles.langLabel}>{t("translatorTarget")}</Text>
          <LanguagePicker value={targetLang} onChange={changeTarget} />
        </View>
      </View>
      <View style={styles.panes}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{languageDisplayName(heardLang || sourceLang, uiLang)}</Text>
          <Text style={styles.cardText}>{spoken || " "}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{languageDisplayName(saidLang || targetLang, uiLang)}</Text>
          <Text style={styles.cardText}>{translated || " "}</Text>
        </View>
      </View>
      <View style={styles.micWrap}>
        <View
          onStartShouldSetResponder={() => !busy || recording}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={() => {
            void beginHold(false);
          }}
          onResponderRelease={() => {
            void endHold(false);
          }}
          style={[styles.mic, recording && styles.micOn, working && !pickingLang && styles.micPressed]}
        >
          {working && !pickingLang ? <ActivityIndicator color="#FFFFFF" size="large" /> : <MicIcon size={54} />}
        </View>
        <Text style={styles.hint}>
          {working && !pickingLang
            ? t("translatorWorking")
            : recording
              ? t("translatorRecording")
              : pickingLang
                ? t("translatorSayLangHint")
                : t("translatorRecord")}
        </Text>
        {note && note !== t("translatorWorking") && note !== t("translatorSayLangHint") ? (
          <Text style={styles.note}>{note}</Text>
        ) : null}
      </View>
      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 26, fontWeight: "800", marginTop: 8, marginBottom: 12, textAlign: "center" },
  langs: { flexDirection: "row", alignItems: "flex-end", gap: 8, zIndex: 40 },
  langCol: { flex: 1, zIndex: 41 },
  langMid: { alignItems: "center", justifyContent: "flex-end", paddingBottom: 2, zIndex: 42, width: 64 },
  langLabel: { color: colors.muted, fontWeight: "700", fontSize: 13, marginBottom: 6 },
  langMic: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.ptt,
    borderWidth: 3,
    borderColor: colors.ring,
    alignItems: "center",
    justifyContent: "center",
  },
  langMicHint: { color: colors.muted, fontWeight: "700", fontSize: 10, marginTop: 4, textAlign: "center" },
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
