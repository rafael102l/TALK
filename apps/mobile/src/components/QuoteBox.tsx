import { Pressable, StyleSheet, Text, View } from "react-native";

const BAR = "#25D366";
const NAME = "#075E54";
const BODY = "rgba(17,27,33,0.62)";

export function QuoteBox({
  name,
  text,
  compact = false,
  inset = false,
  onClose,
}: {
  name: string;
  text: string;
  compact?: boolean;
  inset?: boolean;
  onClose?: () => void;
}) {
  if (!name && !text) return null;
  return (
    <View style={[styles.box, compact && styles.compact, onClose && !inset ? styles.banner : null, inset && styles.inset]}>
      <View style={styles.bar} />
      <View style={styles.body}>
        {name ? (
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
        ) : null}
        {text ? (
          <Text style={styles.text} numberOfLines={compact ? 2 : 3}>
            {text}
          </Text>
        ) : null}
      </View>
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn} accessibilityRole="button">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: "rgba(17,27,33,0.06)",
    borderRadius: 8,
    overflow: "hidden",
    marginBottom: 6,
  },
  compact: { marginBottom: 0 },
  banner: {
    marginBottom: 0,
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  bar: { width: 4, backgroundColor: BAR },
  body: { flexShrink: 1, minWidth: 0, paddingHorizontal: 8, paddingVertical: 6 },
  name: { color: NAME, fontSize: 13, fontWeight: "700" },
  text: { color: BODY, fontSize: 13, lineHeight: 18, marginTop: 1 },
  closeBtn: { width: 32, alignItems: "center", justifyContent: "center" },
  close: { fontSize: 15, color: "rgba(17,27,33,0.45)", fontWeight: "700" },
  inset: {
    marginBottom: 0,
    marginTop: 8,
    marginHorizontal: 6,
    backgroundColor: "#F0F2F5",
  },
});
