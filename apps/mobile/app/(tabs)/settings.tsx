import { AccountPlan, LanguageCode, VoiceGender } from "@talk/shared";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "../../src/components/Avatar";
import { BackBar } from "../../src/components/BackBar";
import { LanguagePicker } from "../../src/components/LanguagePicker";
import { VoicePicker } from "../../src/components/VoicePicker";
import { useI18n } from "../../src/i18n";
import { api } from "../../src/lib/api";
import { useAuth } from "../../src/lib/auth";
import { pickLocalPhoto, uploadAvatar } from "../../src/lib/avatar";
import { colors } from "../../src/lib/theme";

export default function SettingsScreen() {
  const router = useRouter();
  const { user, token, setUser, logout } = useAuth();
  const { t, align } = useI18n();
  const [email, setEmail] = useState(user?.email ?? "");

  async function save(partial: {
    email?: string;
    speakLang?: LanguageCode;
    listenLang?: LanguageCode;
    voiceGender?: VoiceGender;
    plan?: AccountPlan;
  }) {
    if (!token || !user) return;
    const lang = partial.speakLang || partial.listenLang;
    const updated = await api<typeof user>("/users/me", {
      method: "PATCH",
      token,
      body: JSON.stringify(lang ? { ...partial, speakLang: lang, listenLang: lang } : partial),
    });
    if (updated) setUser(updated);
  }

  async function saveEmail() {
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      Alert.alert("TALK", "אימייל לא תקין");
      return;
    }
    await save({ email: trimmed });
    Alert.alert("TALK", "האימייל נשמר");
  }

  async function changePhoto() {
    if (!token) return;
    const uri = await pickLocalPhoto();
    if (!uri) {
      Alert.alert("TALK", t("noPhoto"));
      return;
    }
    const updated = await uploadAvatar(token, uri);
    setUser(updated);
  }

  function confirmDelete() {
    Alert.alert(t("deleteTitle"), t("deleteBody"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          void (async () => {
            if (!token) return;
            try {
              await api("/users/me", { method: "DELETE", token });
            } catch {
              // still sign out locally
            }
            await logout();
            router.replace("/login");
          })();
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.page}>
      <BackBar title={t("settings")} />
      <Pressable style={styles.profile} onPress={() => void changePhoto()}>
        <Avatar uri={user?.avatarUrl} name={user?.displayName || "?"} size={72} />
        <Text style={styles.photoText}>{t("changePhoto")}</Text>
      </Pressable>
      <Text style={[styles.name, { textAlign: align }]}>{user?.displayName}</Text>
      <Text style={[styles.meta, { textAlign: align }]}>{user?.phoneE164}</Text>
      <Text style={[styles.label, { textAlign: align }]}>אימייל לשחזור</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="name@email.com"
        placeholderTextColor={colors.muted}
        textAlign={align}
        onEndEditing={() => void saveEmail()}
      />
      <Pressable onPress={() => void saveEmail()}>
        <Text style={[styles.saveEmail, { textAlign: align }]}>שמירת אימייל</Text>
      </Pressable>
      <Text style={[styles.label, { textAlign: align }]}>{t("myLanguage")}</Text>
      <LanguagePicker
        value={user?.speakLang ?? user?.listenLang ?? "he"}
        onChange={(lang) => void save({ speakLang: lang, listenLang: lang })}
      />
      <Text style={[styles.label, { textAlign: align }]}>{t("pickVoice")}</Text>
      <VoicePicker
        value={user?.voiceGender ?? "male"}
        onChange={(voiceGender) => void save({ voiceGender })}
      />
      <Pressable
        style={styles.logout}
        onPress={async () => {
          await logout();
          router.replace("/login");
        }}
      >
        <Text style={styles.logoutText}>{t("logout")}</Text>
      </Pressable>
      <Pressable style={styles.logout} onPress={confirmDelete}>
        <Text style={styles.deleteText}>{t("deleteAccount")}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 20, gap: 8 },
  profile: { alignItems: "center", gap: 8, marginBottom: 4 },
  photoText: { color: colors.amber, fontWeight: "700" },
  name: { color: colors.amber, fontSize: 20 },
  meta: { color: colors.muted },
  label: { color: colors.amber, marginTop: 10 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    padding: 12,
    fontSize: 16,
  },
  saveEmail: { color: colors.amber, fontWeight: "700", marginBottom: 4 },
  logout: { marginTop: 12, alignItems: "center" },
  logoutText: { color: colors.red, fontSize: 16, fontWeight: "700" },
  deleteText: { color: colors.muted, fontSize: 15, fontWeight: "700" },
});
