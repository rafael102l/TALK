import { PublicUser } from "@talk/shared";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../../src/i18n";
import { startRecording, stopRecording } from "../../src/lib/audio";
import { api } from "../../src/lib/api";
import { useAuth } from "../../src/lib/auth";
import { colors } from "../../src/lib/theme";

export default function VoiceOnboarding() {
  const router = useRouter();
  const { token, setUser } = useAuth();
  const { t, align } = useI18n();
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState("");
  const started = useRef(0);

  async function toggle() {
    if (!recording) {
      await startRecording();
      started.current = Date.now();
      setRecording(true);
      setStatus(t("recording"));
      return;
    }
    const result = await stopRecording();
    setRecording(false);
    if (!result?.uri || !token) return;
    const form = new FormData();
    form.append("audio", {
      uri: result.uri,
      name: "sample.m4a",
      type: "audio/m4a",
    } as unknown as Blob);
    setStatus(t("cloning"));
    try {
      const user = await api<PublicUser>("/users/me/voice-sample", {
        method: "POST",
        token,
        body: form,
      });
      setUser(user);
      setStatus(user.voiceCloneStatus === "READY" ? t("voiceSaved") : t("cloneSavedTemp"));
      router.replace("/home");
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  return (
    <View style={styles.page}>
      <Text style={[styles.title, { textAlign: align }]}>{t("cloneTitle")}</Text>
      <Text style={[styles.body, { textAlign: align }]}>{t("cloneBody")}</Text>
      <Text style={[styles.status, { textAlign: align }]}>{status || t("clonePrompt")}</Text>
      <Pressable style={[styles.btn, recording && styles.rec]} onPress={toggle}>
        <Text style={styles.btnText}>{recording ? t("stopSave") : t("startRec")}</Text>
      </Pressable>
      <Pressable onPress={() => router.replace("/home")}>
        <Text style={styles.skip}>{t("skip")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 24, paddingTop: 72, gap: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  body: { color: colors.muted, fontSize: 16, lineHeight: 24 },
  status: { color: colors.amber },
  btn: { backgroundColor: colors.amber, borderRadius: 12, padding: 16, alignItems: "center" },
  rec: { backgroundColor: colors.red },
  btnText: { color: "#1A1406", fontWeight: "800", fontSize: 18 },
  skip: { color: colors.muted, textAlign: "center", marginTop: 12, fontSize: 16 },
});
