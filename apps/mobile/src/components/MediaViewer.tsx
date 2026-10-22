import { Video, ResizeMode } from "expo-av";
import { useEffect, useState } from "react";
import { AppState, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { setSecureScreen } from "../lib/phoneCall";
import { resolveMediaUri } from "../lib/mediaUri";
import { useI18n } from "../i18n";

export function MediaViewer({
  visible,
  uri,
  kind,
  viewOnce,
  onClose,
}: {
  visible: boolean;
  uri: string | null;
  kind: "image" | "video";
  viewOnce?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(false);
  const src = resolveMediaUri(uri);

  useEffect(() => {
    if (!visible) {
      setSecureScreen(false);
      setHidden(false);
      return;
    }
    if (viewOnce) setSecureScreen(true);
    const sub = AppState.addEventListener("change", (state) => {
      if (!viewOnce) return;
      setHidden(state !== "active");
    });
    return () => {
      sub.remove();
      setSecureScreen(false);
    };
  }, [visible, viewOnce]);

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose}>
      <View style={styles.page}>
        <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
          <Text style={styles.closeTxt}>✕</Text>
        </Pressable>
        {viewOnce ? <Text style={styles.once}>{t("viewOnceMediaHint")}</Text> : null}
        {hidden || !src ? (
          <View style={styles.blank} />
        ) : kind === "video" ? (
          <Video
            source={{ uri: src }}
            style={styles.media}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            useNativeControls
          />
        ) : (
          <Image source={{ uri: src }} style={styles.media} resizeMode="contain" />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000000", justifyContent: "center" },
  media: { width: "100%", height: "100%" },
  blank: { flex: 1, backgroundColor: "#000000" },
  close: {
    position: "absolute",
    top: 48,
    left: 16,
    zIndex: 4,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeTxt: { color: "#FFFFFF", fontSize: 18, fontWeight: "700" },
  once: {
    position: "absolute",
    top: 56,
    alignSelf: "center",
    zIndex: 3,
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    fontWeight: "700",
  },
});
