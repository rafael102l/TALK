import { Video, ResizeMode } from "expo-av";
import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { ChatCapture } from "../lib/capture";
import { useI18n } from "../i18n";
import { colors } from "../lib/theme";

export function CapturePreview({
  capture,
  onSend,
  onOnce,
  onCancel,
}: {
  capture: ChatCapture | null;
  onSend: () => void;
  onOnce: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  if (!capture) return null;
  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={styles.page}>
        {capture.kind === "video" ? (
          <Video
            source={{ uri: capture.uri }}
            style={styles.media}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            isLooping
            isMuted
          />
        ) : (
          <Image source={{ uri: capture.uri }} style={styles.media} resizeMode="contain" />
        )}
        <View style={styles.bar}>
          <Pressable onPress={onCancel} style={styles.ghost}>
            <Text style={styles.ghostTxt}>{t("cancel")}</Text>
          </Pressable>
          <Pressable onPress={onOnce} style={styles.once}>
            <Text style={styles.onceTxt}>1</Text>
            <Text style={styles.onceLabel}>{t("sendOnce")}</Text>
          </Pressable>
          <Pressable onPress={onSend} style={styles.send}>
            <Text style={styles.sendTxt}>{t("sendMessage")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000000", justifyContent: "flex-end" },
  media: { ...StyleSheet.absoluteFillObject },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 14,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  ghost: { paddingVertical: 12, paddingHorizontal: 8 },
  ghostTxt: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
  once: {
    width: 64,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  onceTxt: { color: "#FFFFFF", fontWeight: "900", fontSize: 16, lineHeight: 18 },
  onceLabel: { color: "#FFFFFF", fontSize: 10, fontWeight: "700" },
  send: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  sendTxt: { color: "#FFFFFF", fontWeight: "800", fontSize: 16 },
});
