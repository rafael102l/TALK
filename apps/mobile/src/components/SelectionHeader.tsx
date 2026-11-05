import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useI18n } from "../i18n";

const INK = "#111B21";
const SIZE = 24;

export function SelectionHeader({
  count,
  starred,
  onClose,
  onReply,
  onStar,
  onEdit,
  onDelete,
  onCopy,
  onForward,
  onMore,
}: {
  count: number;
  starred?: boolean;
  onClose: () => void;
  onReply: () => void;
  onStar?: () => void;
  onEdit?: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onForward: () => void;
  onMore: () => void;
}) {
  const { rtl } = useI18n();
  const star = onStar ? (
    <IconBtn name={starred ? "star" : "star-outline"} onPress={onStar} />
  ) : null;
  const edit = onEdit ? <IconBtn name="create-outline" onPress={onEdit} /> : null;
  const back = (
    <View style={styles.left}>
      {rtl ? (
        <>
          <Text style={styles.count}>{count}</Text>
          <IconBtn name="arrow-forward" onPress={onClose} />
        </>
      ) : (
        <>
          <IconBtn name="arrow-back" onPress={onClose} />
          <Text style={styles.count}>{count}</Text>
        </>
      )}
    </View>
  );
  const actions = (
    <View style={styles.actions}>
      {rtl ? (
        <>
          <IconBtn name="ellipsis-vertical" onPress={onMore} />
          <IconBtn name="arrow-redo-outline" onPress={onForward} />
          <IconBtn name="copy-outline" onPress={onCopy} />
          {edit}
          {star}
          <IconBtn name="trash-outline" onPress={onDelete} />
          <IconBtn name="arrow-undo-outline" onPress={onReply} />
        </>
      ) : (
        <>
          <IconBtn name="arrow-undo-outline" onPress={onReply} />
          <IconBtn name="trash-outline" onPress={onDelete} />
          {star}
          {edit}
          <IconBtn name="copy-outline" onPress={onCopy} />
          <IconBtn name="arrow-redo-outline" onPress={onForward} />
          <IconBtn name="ellipsis-vertical" onPress={onMore} />
        </>
      )}
    </View>
  );
  return (
    <View style={styles.bar}>
      {rtl ? (
        <>
          {actions}
          <View style={styles.grow} />
          {back}
        </>
      ) : (
        <>
          {back}
          <View style={styles.grow} />
          {actions}
        </>
      )}
    </View>
  );
}

function IconBtn({
  name,
  onPress,
}: {
  name: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.55} style={styles.iconBtn} accessibilityRole="button">
      <Ionicons name={name} size={SIZE} color={INK} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 48,
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
    paddingHorizontal: 2,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(17,27,33,0.08)",
  },
  left: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
  },
  grow: { flex: 1 },
  count: {
    color: INK,
    fontSize: 20,
    fontWeight: "700",
    minWidth: 20,
    textAlign: "center",
    includeFontPadding: false,
  },
  actions: { flexDirection: "row", direction: "ltr", alignItems: "center" },
  iconBtn: {
    padding: 8,
    marginHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
});
