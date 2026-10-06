import { CountryCode, PublicUser, toE164 } from "@talk/shared";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { composedE164, DEFAULT_COUNTRY, PhoneCountryField } from "../src/components/PhoneCountryField";
import { useI18n } from "../src/i18n";
import { api } from "../src/lib/api";
import { useAuth } from "../src/lib/auth";
import { colors } from "../src/lib/theme";

export default function LoginScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const { t, align } = useI18n();
  const [country, setCountry] = useState<CountryCode>(DEFAULT_COUNTRY);
  const [national, setNational] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function mapError(err: unknown) {
    const raw = err instanceof Error ? err.message : "";
    if (/network|failed|fetch|timeout|אינטרנט|נטוורק|בקשה נכשלה|חיבור לשרת/i.test(raw)) {
      return t("network");
    }
    return raw || t("error");
  }

  function phoneValue() {
    return composedE164(country, national) ?? toE164(national, country);
  }

  async function requestCode() {
    Keyboard.dismiss();
    const phone = phoneValue();
    if (!phone) {
      setError(t("chooseCountry"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/auth/otp/request", {
        method: "POST",
        body: JSON.stringify({ phone }),
      });
      setSent(true);
    } catch (e) {
      setError(mapError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    Keyboard.dismiss();
    const phone = phoneValue();
    if (!phone) {
      setError(t("invalidPhone"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: string; user: PublicUser; isNew: boolean }>(
        "/auth/otp/verify",
        { method: "POST", body: JSON.stringify({ phone, code }) },
      );
      await login(result.token, result.user);
      router.replace(result.user.displayName ? "/home" : "/onboarding/profile");
    } catch (e) {
      setError(mapError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.page}>
            <Text style={[styles.brand, { textAlign: align }]}>TALK</Text>
            <Text style={[styles.sub, { textAlign: align }]}>{t("subtitle")}</Text>
            <PhoneCountryField
              country={country}
              national={national}
              onCountryChange={setCountry}
              onNationalChange={setNational}
            />
            {sent ? (
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={code}
                onChangeText={setCode}
                placeholder={t("codePlaceholder")}
                placeholderTextColor={colors.muted}
                textAlign={align}
                maxLength={6}
              />
            ) : null}
            {error ? <Text style={[styles.error, { textAlign: align }]}>{error}</Text> : null}
            <Pressable style={[styles.btn, busy && styles.btnBusy]} disabled={busy} onPress={sent ? verify : requestCode}>
              <Text style={styles.btnText}>{busy ? t("sending") : sent ? t("enterApp") : t("sendCode")}</Text>
            </Pressable>
          </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: "center", gap: 12 },
  brand: { color: colors.amber, fontSize: 42, fontWeight: "800" },
  sub: { color: colors.muted, fontSize: 16, marginBottom: 16 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    padding: 14,
    fontSize: 18,
  },
  btn: { backgroundColor: colors.amber, borderRadius: 12, padding: 14, alignItems: "center" },
  btnBusy: { opacity: 0.7 },
  btnText: { color: "#1A1406", fontWeight: "800", fontSize: 18 },
  error: { color: colors.red },
});
