import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/theme";

const EMOJIS = [
  "😀", "😃", "😄", "😁", "😅", "😂", "🤣", "😊", "😇", "🙂",
  "😉", "😍", "🥰", "😘", "😗", "😋", "😜", "🤗", "🤔", "🤨",
  "😐", "😑", "😶", "🙄", "😏", "😣", "😥", "😮", "😯", "😪",
  "😫", "🥱", "😴", "😌", "😛", "😝", "🤤", "😒", "😓", "😔",
  "😕", "🙃", "🤑", "😲", "☹️", "🙁", "😖", "😞", "😟", "😤",
  "😢", "😭", "😦", "😧", "😨", "😩", "🤯", "😬", "😰", "😱",
  "😳", "🤪", "😵", "😡", "😠", "🤬", "😷", "🤒", "🤕", "🤢",
  "👍", "👎", "👏", "🙌", "🤝", "🙏", "💪", "✌️", "🤞", "🤟",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "❣️",
  "🔥", "⭐", "✨", "🎉", "🎊", "💯", "✅", "❌", "⚡", "💤",
];

export function EmojiPicker({
  visible,
  onPick,
}: {
  visible: boolean;
  onPick: (emoji: string) => void;
}) {
  if (!visible) return null;
  return (
    <View style={styles.wrap}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.grid}
        style={styles.scroll}
      >
        {EMOJIS.map((emoji) => (
          <Pressable key={emoji} onPress={() => onPick(emoji)} style={styles.cell} hitSlop={2}>
            <Text style={styles.emoji}>{emoji}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: 220,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.22)",
    backgroundColor: colors.bgDeep,
  },
  scroll: { flex: 1 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  cell: {
    width: "12.5%",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: { fontSize: 26 },
});
