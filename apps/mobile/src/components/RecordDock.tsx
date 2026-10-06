import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/theme";
import { formatClock } from "../lib/audio";
import { VoiceWave } from "./VoiceWave";
import { useI18n } from "../i18n";

export function RecordDock({
  durationMs,
  paused,
  live,
  onPause,
  onSend,
  onDelete,
  onViewOnce,
}: {
  durationMs: number;
  paused: boolean;
  live: boolean;
  onPause: () => void;
  onSend: () => void;
  onDelete: () => void;
  onViewOnce: () => void;
}) {
  const { t } = useI18n();
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable onPress={onViewOnce} style={styles.once}>
          <Text style={styles.onceTxt}>1</Text>
        </Pressable>
        <VoiceWave
          progress={live ? 1 : 0.25}
          seed={live ? durationMs : 0}
          tint={colors.bgDeep}
          dim="rgba(14,76,184,0.2)"
        />
        <Text style={styles.clock}>{formatClock(durationMs)}</Text>
        <Pressable onPress={onSend} style={styles.send}>
          <Text style={styles.sendIcon}>➤</Text>
        </Pressable>
      </View>
      <View style={styles.actions}>
        <Pressable onPress={onPause} style={styles.pause}>
          <Text style={styles.pauseIcon}>{paused ? "▶" : "❚❚"}</Text>
          <Text style={styles.pauseTxt}>{paused ? t("resumeRec") : t("pauseRec")}</Text>
        </Pressable>
        <Pressable onPress={onDelete} style={styles.trash}>
          <Text style={styles.trashIcon}>🗑</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.ring,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 18,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  once: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: colors.bgDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  onceTxt: { color: colors.bgDeep, fontWeight: "900", fontSize: 16 },
  clock: { color: colors.bgDeep, fontWeight: "800", fontSize: 13, minWidth: 36 },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bgDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  sendIcon: { color: colors.ring, fontSize: 18, marginLeft: 2 },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  pause: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 6 },
  pauseIcon: { color: colors.bgDeep, fontSize: 16 },
  pauseTxt: { color: colors.bgDeep, fontWeight: "800", fontSize: 16 },
  trash: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffe4e4",
    alignItems: "center",
    justifyContent: "center",
  },
  trashIcon: { fontSize: 18 },
});
