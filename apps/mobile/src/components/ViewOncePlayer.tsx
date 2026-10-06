import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/theme";
import { formatClock, pausePlayer, playUrl, resumePlayer, stopPlayer } from "../lib/audio";
import { VoiceWave } from "./VoiceWave";
import { useI18n } from "../i18n";

export function ViewOncePlayer({
  uri,
  durationMs,
  visible,
  onClose,
}: {
  uri: string | null;
  durationMs: number | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [clock, setClock] = useState(formatClock(durationMs || 0));

  useEffect(() => {
    if (!visible) {
      void stopPlayer();
      setPlaying(false);
      setProgress(0);
      setClock(formatClock(durationMs || 0));
    }
  }, [visible, durationMs]);

  async function toggle() {
    if (!uri) return;
    if (playing) {
      await pausePlayer();
      setPlaying(false);
      return;
    }
    if (progress > 0 && progress < 0.98) {
      await resumePlayer();
      setPlaying(true);
      return;
    }
    setPlaying(true);
    await playUrl(uri, (pos, dur, isPlaying) => {
      const total = dur || durationMs || 1;
      setProgress(total ? pos / total : 0);
      setClock(formatClock(isPlaying ? pos : durationMs || dur || 0));
      setPlaying(isPlaying);
      if (!isPlaying && pos >= (dur || 0) - 40) {
        setProgress(0);
        setClock(formatClock(durationMs || dur || 0));
      }
    });
  }

  async function close() {
    await stopPlayer();
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={styles.bg}>
        <Pressable style={styles.dim} onPress={close} />
        <View style={styles.sheet}>
          <Text style={styles.title}>{t("viewOnceTitle")}</Text>
          <Text style={styles.hint}>{t("viewOnceHint")}</Text>
          <Pressable onPress={toggle} style={styles.player}>
            <View style={styles.play}>
              <Text style={styles.playIcon}>{playing ? "❚❚" : "▶"}</Text>
            </View>
            <VoiceWave progress={progress || 0.08} tint={colors.neon} dim="rgba(94,231,255,0.28)" />
            <Text style={styles.clock}>{clock}</Text>
          </Pressable>
          <Pressable onPress={close} style={styles.close}>
            <Text style={styles.closeTxt}>{t("closeOnce")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, justifyContent: "flex-end" },
  dim: { flex: 1, backgroundColor: "rgba(7,22,40,0.72)" },
  sheet: {
    backgroundColor: colors.bgDeep,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 22,
    paddingBottom: 36,
  },
  title: { color: colors.ring, fontWeight: "900", fontSize: 20, textAlign: "center" },
  hint: {
    color: colors.muted,
    fontSize: 13,
    textAlign: "center",
    marginTop: 8,
    marginBottom: 22,
  },
  player: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.panel,
    borderRadius: 18,
    padding: 12,
  },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.neon,
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: { color: colors.bgDeep, fontWeight: "800", fontSize: 14 },
  clock: { color: colors.neon, fontWeight: "800", fontSize: 14, minWidth: 36 },
  close: {
    marginTop: 18,
    backgroundColor: colors.red,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
  },
  closeTxt: { color: colors.ring, fontWeight: "900", fontSize: 16 },
});
