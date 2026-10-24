import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { QuoteBox } from "./QuoteBox";
import { ReceiptTicks } from "./ReceiptTicks";
import { cacheChatMedia } from "../lib/mediaCache";
import { resolveMediaUri } from "../lib/mediaUri";
import { formatClock } from "../lib/audio";
import type { MessageReceipt } from "@talk/shared";

const INK = "#111B21";

export function MediaBubble({
  uri,
  kind,
  durationMs,
  mine,
  locked,
  viewOnce,
  time,
  receipt,
  selected,
  quoteName,
  quoteText,
  onOpen,
  onLongPress,
  onSelect,
  selecting,
  photoLabel,
  videoLabel,
  caption,
  openedOnce,
  onceTitle,
  onceBody,
  openedLabel,
}: {
  uri: string | null;
  kind: "image" | "video";
  durationMs?: number | null;
  mine: boolean;
  locked?: boolean;
  viewOnce?: boolean;
  time?: string;
  receipt?: MessageReceipt;
  selected?: boolean;
  quoteName?: string;
  quoteText?: string;
  onOpen: () => void;
  onLongPress: () => void;
  onSelect?: () => void;
  selecting?: boolean;
  photoLabel: string;
  videoLabel: string;
  caption?: string | null;
  openedOnce?: boolean;
  onceTitle?: string;
  onceBody?: string;
  openedLabel?: string;
}) {
  const remote = resolveMediaUri(uri);
  const [src, setSrc] = useState(remote);
  useEffect(() => {
    let live = true;
    setSrc(remote);
    if (!remote || viewOnce) {
      return () => {
        live = false;
      };
    }
    void cacheChatMedia(remote, { album: false }).then((local) => {
      if (live && local) setSrc(local);
    });
    return () => {
      live = false;
    };
  }, [remote, viewOnce]);
  return (
    <Pressable
      onPress={() => {
        if (selecting) onSelect?.();
        else if (!openedOnce) onOpen();
      }}
      onLongPress={onLongPress}
      delayLongPress={280}
      style={[styles.bubble, mine ? styles.mine : styles.theirs, selected && styles.picked, openedOnce && styles.openedBubble]}
    >
      {quoteName || quoteText ? <QuoteBox name={quoteName || ""} text={quoteText || ""} compact /> : null}
      {openedOnce ? (
        <View style={styles.openedRow}>
          <Text style={styles.openedTxt}>{openedLabel || "נפתחה"}</Text>
        </View>
      ) : locked ? (
        <View style={styles.onceCard}>
          <View style={styles.onceIcon}>
            <Text style={styles.onceIconTxt}>1</Text>
          </View>
          <Text style={styles.onceTitle}>{onceTitle || photoLabel}</Text>
          {onceBody ? <Text style={styles.onceBody}>{onceBody}</Text> : null}
        </View>
      ) : kind === "image" && src ? (
        <Image source={{ uri: src }} style={styles.photo} onError={() => setSrc("")} />
      ) : kind === "image" ? (
        <View style={[styles.photo, styles.missing]}>
          <Text style={styles.missingText}>{photoLabel}</Text>
        </View>
      ) : (
        <View style={styles.video}>
          {src ? <Image source={{ uri: src }} style={styles.photo} /> : null}
          <View style={styles.play}>
            <Text style={styles.playTxt}>▶</Text>
          </View>
          {durationMs ? <Text style={styles.dur}>{formatClock(durationMs)}</Text> : null}
        </View>
      )}
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      <View style={styles.metaRow}>
        {viewOnce && !locked ? <Text style={styles.once}>1</Text> : null}
        {time ? <Text style={styles.meta}>{time}</Text> : null}
        {mine && receipt ? <ReceiptTicks receipt={receipt} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: "78%",
    minWidth: 160,
    borderRadius: 12,
    padding: 4,
    overflow: "hidden",
  },
  mine: { backgroundColor: "#D9FDD3", borderTopRightRadius: 4 },
  theirs: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(17,27,33,0.08)",
  },
  picked: { backgroundColor: "rgba(30,120,240,0.16)" },
  photo: { width: 220, height: 220, borderRadius: 8, backgroundColor: "#D1D7DB" },
  missing: { alignItems: "center", justifyContent: "center" },
  missingText: { color: "#54656F", fontWeight: "700" },
  video: {
    width: 220,
    height: 160,
    borderRadius: 8,
    backgroundColor: "#111B21",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  play: {
    position: "absolute",
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  playTxt: { color: "#FFFFFF", fontSize: 18, marginLeft: 3 },
  dur: {
    position: "absolute",
    left: 8,
    bottom: 8,
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 12,
  },
  lock: {
    width: 220,
    height: 120,
    borderRadius: 8,
    backgroundColor: "rgba(17,27,33,0.08)",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  lockOne: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: INK,
    alignItems: "center",
    justifyContent: "center",
  },
  lockOneTxt: { fontWeight: "900", fontSize: 16, color: INK },
  lockTxt: { color: INK, fontWeight: "700", fontSize: 14 },
  onceCard: {
    width: 220,
    minHeight: 160,
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 18,
    gap: 8,
  },
  onceIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#00A884",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  onceIconTxt: { color: "#FFFFFF", fontWeight: "900", fontSize: 20 },
  onceTitle: { color: INK, fontWeight: "800", fontSize: 15, textAlign: "center" },
  onceBody: { color: "#667781", fontSize: 12, lineHeight: 17, textAlign: "center" },
  openedBubble: { minWidth: 96, maxWidth: 160 },
  openedRow: { paddingHorizontal: 10, paddingVertical: 6, minWidth: 88 },
  openedTxt: { color: "rgba(17,27,33,0.55)", fontWeight: "700", fontSize: 13 },
  metaRow: { marginTop: 4, flexDirection: "row", alignItems: "center", alignSelf: "flex-end", gap: 4, paddingHorizontal: 4 },
  meta: { fontSize: 11, fontWeight: "600", color: "rgba(17,27,33,0.42)" },
  once: { fontSize: 11, fontWeight: "800", color: "rgba(17,27,33,0.55)" },
  caption: { color: INK, fontSize: 15, paddingHorizontal: 6, paddingTop: 4 },
});
