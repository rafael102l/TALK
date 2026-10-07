import { CountryCode, DeviceTransferChallenge, PublicUser, toE164 } from "@talk/shared";
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

type AuthOk = { token: string; user: PublicUser; isNew: boolean };
type VerifyResult = AuthOk | DeviceTransferChallenge;

function isTransfer(r: VerifyResult): r is DeviceTransferChallenge {
  return "requiresDeviceTransfer" in r && r.requiresDeviceTransfer === true;
}

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

  const [transfer, setTransfer] = useState<DeviceTransferChallenge | null>(null);
  const [email, setEmail] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [confirmOwnership, setConfirmOwnership] = useState(false);

  function mapError(err: unknown) {
    const raw = err instanceof Error ? err.message : "";
    if (/unauthorized|session replaced|401/i.test(raw)) {
      return "יש להתחבר מחדש. הזינו את הקוד מה-SMS.";
    }
    if (/network|failed|fetch|timeout|abort|אינטרנט|נטוורק|בקשה נכשלה|חיבור לשרת|התעורר/i.test(raw)) {
      return t("network");
    }
    return raw || t("error");
  }

  function phoneValue() {
    return composedE164(country, national) ?? toE164(national, country);
  }

  async function finishLogin(result: AuthOk) {
    await login(result.token, result.user);
    router.replace(result.user.displayName ? "/home" : "/onboarding/profile");
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
      const result = await api<VerifyResult>("/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ phone, code }),
      });
      if (isTransfer(result)) {
        setTransfer(result);
        setConfirmOwnership(false);
        setSmsCode("");
        setEmailCode("");
        setEmail("");
        return;
      }
      await finishLogin(result);
    } catch (e) {
      setError(mapError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTransfer() {
    Keyboard.dismiss();
    if (!transfer) return;
    if (!confirmOwnership) {
      setError("אשרו שזה החשבון שלכם");
      return;
    }
    if (!email.trim()) {
      setError("יש להזין אימייל");
      return;
    }
    if (!smsCode.trim()) {
      setError("יש להזין את קוד ה-SMS לאימות מכשיר");
      return;
    }
    if (transfer.hasEmail && !emailCode.trim()) {
      setError("יש להזין את קוד האימייל");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<AuthOk>("/auth/device-transfer/confirm", {
        method: "POST",
        body: JSON.stringify({
          challengeToken: transfer.challengeToken,
          email: email.trim(),
          smsCode: smsCode.trim(),
          emailCode: transfer.hasEmail ? emailCode.trim() : undefined,
          confirmOwnership: true,
        }),
      });
      setTransfer(null);
      await finishLogin(result);
    } catch (e) {
      setError(mapError(e));
    } finally {
      setBusy(false);
    }
  }

  if (transfer) {
    return (
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.page}>
            <Text style={[styles.brand, { textAlign: align }]}>TALK</Text>
            <Text style={[styles.sub, { textAlign: align }]}>
              החשבון מחובר במכשיר אחר. כדי להמשיך כאן — אשרו שזה אתם (כמו בוואטסאפ).
            </Text>
            <Text style={[styles.meta, { textAlign: align }]}>{transfer.phoneE164}</Text>
            {transfer.hasEmail && transfer.emailMasked ? (
              <Text style={[styles.meta, { textAlign: align }]}>
                נשלח קוד לאימייל: {transfer.emailMasked}
              </Text>
            ) : (
              <Text style={[styles.meta, { textAlign: align }]}>
                הזינו אימייל לשחזור — יישמר לחשבון
              </Text>
            )}
            <TextInput
              style={styles.input}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
              placeholder={transfer.hasEmail ? "האימייל של החשבון" : "אימייל לשחזור"}
              placeholderTextColor={colors.muted}
              textAlign={align}
            />
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={smsCode}
              onChangeText={setSmsCode}
              placeholder="קוד SMS לאימות מכשיר"
              placeholderTextColor={colors.muted}
              textAlign={align}
              maxLength={6}
            />
            {transfer.hasEmail ? (
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={emailCode}
                onChangeText={setEmailCode}
                placeholder="קוד מהאימייל"
                placeholderTextColor={colors.muted}
                textAlign={align}
                maxLength={6}
              />
            ) : null}
            <Pressable
              style={styles.checkRow}
              onPress={() => setConfirmOwnership((v) => !v)}
            >
              <View style={[styles.checkBox, confirmOwnership && styles.checkOn]} />
              <Text style={[styles.checkText, { textAlign: align }]}>זה אני — העבירו את החשבון למכשיר הזה</Text>
            </Pressable>
            {error ? <Text style={[styles.error, { textAlign: align }]}>{error}</Text> : null}
            <Pressable
              style={[styles.btn, busy && styles.btnBusy]}
              disabled={busy}
              onPress={() => void confirmTransfer()}
            >
              <Text style={styles.btnText}>{busy ? t("sending") : "אישור והמשך"}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setTransfer(null);
                setError("");
              }}
            >
              <Text style={[styles.link, { textAlign: align }]}>חזרה</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
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
  sub: { color: colors.muted, fontSize: 16, marginBottom: 8 },
  meta: { color: colors.text, fontSize: 14 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    padding: 14,
    fontSize: 18,
  },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.amber,
    backgroundColor: "transparent",
  },
  checkOn: { backgroundColor: colors.amber },
  checkText: { color: colors.text, flex: 1, fontSize: 15, fontWeight: "600" },
  btn: { backgroundColor: colors.amber, borderRadius: 12, padding: 14, alignItems: "center" },
  btnBusy: { opacity: 0.7 },
  btnText: { color: "#1A1406", fontWeight: "800", fontSize: 18 },
  error: { color: colors.red },
  link: { color: colors.muted, marginTop: 8, fontSize: 15 },
});
