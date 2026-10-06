import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/theme";
import { formatClock, pausePlayer, playUrl, resumePlayer, stopPlayer } from "../lib/audio";
import { VoiceWave } from "./VoiceWave";
import { Avatar } from "./Avatar";
import { VoiceGender } from "@talk/shared";

export function VoiceBubble({
  uri,
  durationMs,
  mine,
  avatarUrl,
  name,
  gender,
  locked,
  viewOnce,
  caption,
  onOpenOnce,
}: {
  uri: string | null;
  durationMs: number | null;
  mine: boolean;
  avatarUrl?: string | null;
  name?: string | null;
  gender?: VoiceGender;
  locked?: boolean;
  viewOnce?: boolean;
  caption?: string | null;
  onOpenOnce?: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [clock, setClock] = useState(formatClock(durationMs || 0));

  useEffect(() => {
    setProgress(0);
    setPlaying(false);
    setClock(formatClock(durationMs || 0));
    return () => {
      void stopPlayer();
    };
  }, [uri, durationMs]);

  async function toggle() {
    if (locked) {
      onOpenOnce?.();
      return;
    }
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

  return (
    <View style={[styles.row, mine ? styles.mineRow : styles.theirsRow]}>
      {!mine ? <Avatar name={name || "?"} uri={avatarUrl} size={36} gender={gender} /> : null}
      <View style={styles.stack}>
        <Pressable onPress={toggle} style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
        <View style={[styles.play, mine ? styles.playMine : styles.playTheirs]}>
          <Text style={[styles.playIcon, mine ? styles.playIconMine : styles.playIconTheirs]}>
            {locked ? "1" : playing ? "❚❚" : "▶"}
          </Text>
        </View>
        <VoiceWave
          progress={locked ? 0 : progress || 0.08}
          tint={mine ? colors.bgDeep : colors.neon}
          dim={mine ? "rgba(14,76,184,0.22)" : "rgba(94,231,255,0.28)"}
        />
        <Text style={[styles.time, mine ? styles.mineTime : styles.theirTime]}>
          {locked ? "1" : clock}
        </Text>
        {viewOnce && !locked ? (
          <View style={styles.onceBadge}>
            <Text style={styles.onceBadgeTxt}>1</Text>
          </View>
        ) : null}
        </Pressable>
        {caption ? (
          <Text style={[styles.caption, mine ? styles.captionMine : styles.captionTheirs]}>{caption}</Text>
        ) : null}
      </View>
      {mine ? <Avatar name={name || "?"} uri={avatarUrl} size={36} gender={gender} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginBottom: 10, maxWidth: "92%" },
  stack: { maxWidth: 280, gap: 4 },
  caption: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  captionMine: { color: colors.text, textAlign: "right" },
  captionTheirs: { color: colors.text, textAlign: "left" },
  mineRow: { alignSelf: "flex-end" },
  theirsRow: { alignSelf: "flex-start" },
  bubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 18,
    minWidth: 210,
    maxWidth: 280,
  },
  mine: { backgroundColor: colors.neon },
  theirs: { backgroundColor: colors.bgDeep, borderWidth: 1, borderColor: "rgba(255,255,255,0.28)" },
  play: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  playMine: { backgroundColor: colors.bgDeep },
  playTheirs: { backgroundColor: colors.neon },
  playIcon: { fontWeight: "800", fontSize: 13 },
  playIconMine: { color: colors.ring },
  playIconTheirs: { color: colors.bgDeep },
  time: { fontWeight: "800", fontSize: 12, minWidth: 32, textAlign: "right" },
  mineTime: { color: colors.bgDeep },
  theirTime: { color: colors.neon },
  onceBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.bgDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  onceBadgeTxt: { color: colors.bgDeep, fontWeight: "900", fontSize: 10 },
});
