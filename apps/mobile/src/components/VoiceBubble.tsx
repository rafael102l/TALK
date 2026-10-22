import { memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatClock, pausePlayer, playUrl, resumePlayer, stopPlayer } from "../lib/audio";
import { speakRobot } from "../lib/onDeviceAi";
import { VoiceWave } from "./VoiceWave";
import { Avatar } from "./Avatar";
import { QuoteBox } from "./QuoteBox";
import { MessageReceipt, VoiceGender } from "@talk/shared";
import { ReceiptTicks } from "./ReceiptTicks";

const MINE_BG = "#D9FDD3";
const THEIRS_BG = "#FFFFFF";
const INK = "#111B21";
const MUTED = "rgba(17,27,33,0.45)";

export const VoiceBubble = memo(function VoiceBubble({
  uri,
  durationMs,
  mine,
  avatarUrl,
  name,
  gender,
  locked,
  viewOnce,
  caption,
  listenLang,
  at,
  onOpenOnce,
  selected = false,
  selecting = false,
  reaction = "",
  quoteName = "",
  quoteText = "",
  onLongPress,
  onSelect,
  receipt,
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
  listenLang?: string;
  at?: string;
  onOpenOnce?: () => void;
  selected?: boolean;
  selecting?: boolean;
  reaction?: string;
  quoteName?: string;
  quoteText?: string;
  onLongPress?: () => void;
  onSelect?: () => void;
  receipt?: MessageReceipt | null;
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
    try {
      if (uri) {
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
        return;
      }
      if (caption) {
        const ok = await speakRobot(caption, listenLang || "en", gender === "female" || gender === "child" ? gender : "male");
        setPlaying(false);
        setProgress(ok ? 0 : 0);
        return;
      }
      setPlaying(false);
    } catch (error) {
      console.log(`[walkie] play ${(error as Error).message}`);
      if (caption) {
        try {
          await speakRobot(caption, listenLang || "en", gender === "female" || gender === "child" ? gender : "male");
        } catch {
          /* already logged */
        }
      }
      setPlaying(false);
    }
  }

  const time = at
    ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <View style={styles.row}>
      {!mine ? <Avatar name={name || "?"} uri={avatarUrl} size={36} gender={gender} /> : null}
      <View style={styles.stack}>
        <View style={styles.bubbleBox}>
          <Pressable
            onPress={() => {
              if (selecting) onSelect?.();
              else void toggle();
            }}
            onLongPress={onLongPress}
            delayLongPress={280}
            accessibilityState={{ selected }}
            style={[styles.bubble, mine ? styles.mine : styles.theirs, quoteName || quoteText ? styles.bubbleQuoted : null, reaction ? styles.bubbleReact : null]}
          >
            {quoteName || quoteText ? <QuoteBox name={quoteName} text={quoteText} compact /> : null}
            <View style={styles.playRow}>
              <View style={[styles.play, mine ? styles.playMine : styles.playTheirs]}>
                <Text style={styles.playIcon}>{locked ? "1" : playing ? "❚❚" : "▶"}</Text>
              </View>
              <VoiceWave
                progress={locked ? 0 : progress || 0.08}
                tint={mine ? "#3A7BD5" : "#667781"}
                dim="rgba(17,27,33,0.16)"
              />
              <Text style={styles.duration}>{locked ? "1" : clock}</Text>
              {viewOnce && !locked ? (
                <View style={styles.onceBadge}>
                  <Text style={styles.onceBadgeTxt}>1</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
          {reaction ? (
            <View style={[styles.reaction, mine ? styles.reactionMine : styles.reactionTheirs]}>
              <Text style={styles.reactionTxt}>{reaction}</Text>
            </View>
          ) : null}
        </View>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
        {time || mine ? (
          <View style={styles.stampRow}>
            {time ? <Text style={styles.stamp}>{time}</Text> : null}
            {mine ? <ReceiptTicks receipt={receipt} /> : null}
          </View>
        ) : null}
      </View>
      {mine ? <Avatar name={name || "?"} uri={avatarUrl} size={36} gender={gender} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  stack: { gap: 4 },
  caption: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: INK, flexShrink: 1 },
  stampRow: { flexDirection: "row", alignItems: "center" },
  stamp: { color: MUTED, fontSize: 11, fontWeight: "600" },
  bubbleBox: { position: "relative", overflow: "visible" },
  bubble: {
    position: "relative",
    overflow: "visible",
    padding: 10,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bubbleReact: { paddingBottom: 6 },
  bubbleQuoted: { flexDirection: "column", alignItems: "stretch", gap: 6 },
  playRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  mine: { backgroundColor: MINE_BG, borderTopRightRadius: 4 },
  theirs: {
    backgroundColor: THEIRS_BG,
    borderTopLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(17,27,33,0.08)",
  },
  reaction: {
    position: "absolute",
    bottom: -8,
    zIndex: 10,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    paddingHorizontal: 5,
    paddingVertical: 1,
    elevation: 3,
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(17,27,33,0.12)",
  },
  reactionMine: { left: 10 },
  reactionTheirs: { right: 10 },
  reactionTxt: { fontSize: 14 },
  play: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  playMine: { backgroundColor: "rgba(58,123,213,0.16)" },
  playTheirs: { backgroundColor: "rgba(17,27,33,0.08)" },
  playIcon: { fontWeight: "800", fontSize: 13, color: INK },
  duration: { fontWeight: "800", fontSize: 12, minWidth: 32, textAlign: "right", color: INK },
  onceBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: INK,
    alignItems: "center",
    justifyContent: "center",
  },
  onceBadgeTxt: { color: INK, fontWeight: "900", fontSize: 10 },
});
