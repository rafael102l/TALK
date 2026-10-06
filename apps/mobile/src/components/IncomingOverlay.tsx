import { TransmissionReadyPayload } from "@talk/shared";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../i18n";
import { Avatar } from "./Avatar";
import { colors } from "../lib/theme";

export function IncomingOverlay({
  payload,
  onClose,
  onAccept,
  onDecline,
}: {
  payload: TransmissionReadyPayload | null;
  onClose: () => void;
  onAccept?: () => void;
  onDecline?: () => void;
}) {
  const { t, align, row } = useI18n();
  if (!payload) return null;
  const caption = payload.translatedText || payload.originalText;
  if (payload.needsAccept) {
    return (
      <View style={styles.wrap}>
        <Text style={[styles.kicker, { textAlign: align }]}>{t("requestTitle")}</Text>
        <View style={[styles.who, { flexDirection: row }]}>
          <Avatar uri={payload.senderAvatarUrl} name={payload.senderName} size={52} />
          <Text style={[styles.name, { textAlign: align }]}>{payload.senderName}</Text>
        </View>
        <Text style={[styles.text, { textAlign: align }]}>{t("requestBody")}</Text>
        <View style={[styles.row, { flexDirection: row }]}>
          <Pressable onPress={onDecline} style={styles.no}>
            <Text style={styles.noText}>{t("notNow")}</Text>
          </Pressable>
          <Pressable onPress={onAccept} style={styles.yes}>
            <Text style={styles.yesText}>{t("acceptPlay")}</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.wrap}>
      <Text style={[styles.kicker, { textAlign: align }]}>
        {payload.mode === "free" ? t("incomingFree") : t("incoming")}
      </Text>
      <Text style={[styles.name, { textAlign: align }]}>{payload.senderName}</Text>
      {caption ? <Text style={[styles.text, { textAlign: align }]}>{caption}</Text> : null}
      {payload.originalText &&
      payload.translatedText &&
      payload.originalText !== payload.translatedText ? (
        <Text style={[styles.orig, { textAlign: align }]}>{payload.originalText}</Text>
      ) : null}
      <Pressable onPress={onClose} style={styles.btn}>
        <Text style={styles.btnText}>{t("close")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    top: 56,
    backgroundColor: colors.panel,
    borderColor: colors.amber,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    zIndex: 20,
  },
  kicker: { color: colors.amber, fontSize: 12 },
  who: { alignItems: "center", gap: 10 },
  name: { color: colors.text, fontSize: 22, fontWeight: "700", flex: 1 },
  text: { color: colors.text, fontSize: 16 },
  orig: { color: colors.muted, fontSize: 13 },
  row: { gap: 8, marginTop: 8 },
  yes: { flex: 1, backgroundColor: colors.amber, borderRadius: 12, padding: 12, alignItems: "center" },
  yesText: { color: "#1A1406", fontWeight: "800" },
  no: { flex: 1, backgroundColor: colors.bgDeep, borderRadius: 12, padding: 12, alignItems: "center" },
  noText: { color: colors.text, fontWeight: "700" },
  btn: {
    alignSelf: "flex-start",
    backgroundColor: colors.panelAlt,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  btnText: { color: colors.text },
});
