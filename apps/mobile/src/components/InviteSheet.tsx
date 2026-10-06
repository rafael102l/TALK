import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Sms from "expo-sms";
import { useI18n } from "../i18n";
import { colors } from "../lib/theme";
import type { InviteTarget } from "../lib/inviteMessage";
import { Avatar } from "./Avatar";

export function InviteSheet({
  target,
  onClose,
}: {
  target: InviteTarget | null;
  onClose: () => void;
}) {
  const { t, align } = useI18n();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (target) {
      setMessage(target.message);
      setError("");
      setBusy(false);
    }
  }, [target]);

  if (!target) return null;

  async function send() {
    setBusy(true);
    setError("");
    try {
      const available = await Sms.isAvailableAsync();
      if (!available) {
        setError(t("inviteSmsUnavailable"));
        setBusy(false);
        return;
      }
      const result = await Sms.sendSMSAsync([target!.e164], message.trim() || target!.message);
      if (result.result === "sent" || result.result === "unknown") {
        onClose();
      }
    } catch (e) {
      setError((e as Error).message || t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={[styles.title, { textAlign: align }]}>{t("inviteSheetTitle")}</Text>
        <Text style={[styles.body, { textAlign: align }]}>
          {t("inviteSheetBody", { phone: target.display })}
        </Text>
        <View style={styles.avatarWrap}>
          <Avatar uri={null} name="?" size={72} />
        </View>
        <Text style={styles.phone}>{target.display}</Text>
        <Text style={[styles.label, { textAlign: align }]}>{t("inviteMessageLabel")}</Text>
        <TextInput
          style={[styles.input, { textAlign: align }]}
          value={message}
          onChangeText={setMessage}
          multiline
          textAlignVertical="top"
        />
        {error ? <Text style={[styles.error, { textAlign: align }]}>{error}</Text> : null}
        <Pressable style={[styles.primary, busy && styles.busy]} disabled={busy} onPress={() => void send()}>
          <Text style={styles.primaryText}>{busy ? t("sending") : t("inviteSendSms")}</Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={styles.secondary}>{t("notNow")}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
    gap: 10,
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D0D0D0",
    marginBottom: 6,
  },
  title: { color: "#111", fontSize: 20, fontWeight: "800" },
  body: { color: "#555", fontSize: 15, lineHeight: 22 },
  avatarWrap: { alignSelf: "center", marginTop: 4 },
  phone: { color: "#111", fontSize: 16, fontWeight: "700", textAlign: "center" },
  label: { color: "#777", fontSize: 13, fontWeight: "700", marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#DDD",
    borderRadius: 12,
    padding: 12,
    minHeight: 110,
    color: "#111",
    fontSize: 15,
    lineHeight: 22,
    backgroundColor: "#FAFAFA",
  },
  error: { color: colors.red, fontWeight: "700" },
  primary: {
    backgroundColor: "#111",
    borderRadius: 28,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  busy: { opacity: 0.6 },
  primaryText: { color: "#FFF", fontWeight: "800", fontSize: 16 },
  secondary: { color: "#1FA855", fontWeight: "700", textAlign: "center", marginTop: 8, fontSize: 16 },
});
