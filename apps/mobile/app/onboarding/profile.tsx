import { LanguageCode, VoiceGender } from "@talk/shared";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "../../src/components/Avatar";
import { LanguagePicker } from "../../src/components/LanguagePicker";
import { VoicePicker } from "../../src/components/VoicePicker";
import { isRtlLang, translateMsg, type MsgKey } from "../../src/i18n/catalog";
import { api } from "../../src/lib/api";
import { useAuth } from "../../src/lib/auth";
import { pickLocalPhoto, uploadAvatar } from "../../src/lib/avatar";
import { colors } from "../../src/lib/theme";

export default function ProfileOnboarding() {
  const router = useRouter();
  const { token, user, setUser } = useAuth();
  const [name, setName] = useState(user?.displayName ?? "");
  const [photo, setPhoto] = useState(user?.avatarUrl ?? "");
  const [lang, setLang] = useState<LanguageCode>(user?.speakLang ?? user?.listenLang ?? "he");
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(user?.voiceGender ?? "male");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const align = isRtlLang(lang) ? "right" : "left";
  const t = useMemo(
    () => (key: MsgKey, vars?: Record<string, string>) => translateMsg(lang, key, vars),
    [lang],
  );

  async function pickPhoto() {
    const uri = await pickLocalPhoto();
    if (!uri) {
      setError(t("photoFail"));
      return;
    }
    setPhoto(uri);
    setError("");
  }

  async function save() {
    if (!token || !name.trim()) {
      setError(t("needName"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      let updated = await api<typeof user>("/users/me", {
        method: "PATCH",
        token,
        body: JSON.stringify({
          displayName: name.trim(),
          speakLang: lang,
          listenLang: lang,
          voiceGender,
        }),
      });
      if (photo && !photo.startsWith("http") && updated) {
        updated = await uploadAvatar(token, photo);
      }
      if (updated) setUser(updated);
      router.replace("/home");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <Text style={[styles.title, { textAlign: align }]}>{t("whoAreYou")}</Text>
      <Pressable style={styles.photoBtn} onPress={() => void pickPhoto()}>
        <Avatar uri={photo || null} name={name || "?"} size={96} />
        <Text style={styles.photoText}>{t("pickPhoto")}</Text>
      </Pressable>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder={t("namePlaceholder")}
        placeholderTextColor={colors.muted}
        textAlign={align}
      />
      <Text style={[styles.label, { textAlign: align }]}>{t("myLanguage")}</Text>
      <LanguagePicker value={lang} onChange={setLang} />
      <Text style={[styles.label, { textAlign: align }]}>{t("pickVoice")}</Text>
      <VoicePicker value={voiceGender} onChange={setVoiceGender} lang={lang} />
      {error ? <Text style={[styles.error, { textAlign: align }]}>{error}</Text> : null}
      <Pressable style={[styles.btn, busy && styles.busy]} disabled={busy} onPress={() => void save()}>
        <Text style={styles.btnText}>{busy ? t("saving") : t("enterTalk")}</Text>
      </Pressable>
      <Text style={styles.hint}>{t("profileHint")}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 24, gap: 10 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  photoBtn: { alignItems: "center", gap: 8, marginVertical: 8 },
  photoText: { color: colors.amber, fontWeight: "700" },
  label: { color: colors.amber, marginTop: 8 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    color: colors.text,
    borderRadius: 12,
    padding: 14,
    fontSize: 18,
  },
  btn: { backgroundColor: colors.amber, borderRadius: 12, padding: 14, alignItems: "center", marginTop: 16 },
  busy: { opacity: 0.7 },
  btnText: { color: "#1A1406", fontWeight: "800", fontSize: 16 },
  error: { color: colors.red },
  hint: { color: colors.muted, textAlign: "center", marginTop: 8 },
});
