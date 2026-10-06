import { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/theme";

export function RoundAction({
  children,
  onPress,
  size = 62,
}: {
  children: ReactNode;
  onPress: () => void;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={[styles.btn, { width: size, height: size, borderRadius: size / 2 }]}
    >
      {children}
    </Pressable>
  );
}

export function LabeledAction({
  label,
  children,
  onPress,
  active,
  size = 68,
  badge = 0,
}: {
  label: string;
  children?: ReactNode;
  onPress: () => void;
  active?: boolean;
  size?: number;
  badge?: number;
}) {
  return (
    <Pressable onPressIn={onPress} delayPressIn={0} style={styles.labeled}>
      <View style={[styles.iconWrap, { width: size, height: size }]}>
        <View
          style={[
            styles.btn,
            { width: size, height: size, borderRadius: size / 2 },
            active && styles.btnOn,
          ]}
        >
          {children ?? <Text style={styles.btnWord}>{label}</Text>}
        </View>
        {badge > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 99 ? "99+" : String(badge)}</Text>
          </View>
        ) : null}
      </View>
      {children ? <Text style={[styles.caption, active && styles.captionOn]}>{label}</Text> : null}
    </Pressable>
  );
}

export function ChannelPill({
  title,
  subtitle,
  index,
  active,
  wide,
  onPress,
}: {
  title: string;
  subtitle?: string;
  index?: number;
  active?: boolean;
  wide?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, wide && styles.wide, active && styles.active]}>
      {index != null ? <Text style={styles.index}>{index}</Text> : null}
      <Text numberOfLines={2} style={[styles.title, wide && styles.titleWide]}>
        {title}
      </Text>
      {subtitle ? (
        <Text numberOfLines={1} style={styles.sub}>
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: "transparent",
    borderWidth: 2.4,
    borderColor: colors.ring,
    alignItems: "center",
    justifyContent: "center",
  },
  btnOn: { backgroundColor: "rgba(255,255,255,0.22)" },
  btnWord: { color: colors.ring, fontWeight: "900", fontSize: 14, textAlign: "center", paddingHorizontal: 4 },
  labeled: { alignItems: "center", gap: 4, flex: 1, maxWidth: 96, overflow: "visible" },
  iconWrap: { overflow: "visible" },
  caption: { color: colors.ring, fontSize: 13, fontWeight: "800", textAlign: "center" },
  captionOn: { opacity: 1 },
  badge: {
    position: "absolute",
    top: -6,
    right: -8,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: "#E53935",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 8,
    elevation: 8,
  },
  badgeText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
  pill: {
    minHeight: 42,
    minWidth: 88,
    maxWidth: 160,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 22,
    borderWidth: 2.2,
    borderColor: colors.ring,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  wide: {
    flex: 1,
    minWidth: 0,
    maxWidth: "100%",
    minHeight: 86,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  active: { backgroundColor: "rgba(255,255,255,0.18)" },
  index: {
    position: "absolute",
    top: 6,
    color: colors.ring,
    fontSize: 12,
    fontWeight: "800",
    opacity: 0.95,
  },
  title: { color: colors.ring, fontSize: 14, fontWeight: "800", textAlign: "center", lineHeight: 18 },
  titleWide: { fontSize: 17, lineHeight: 22 },
  sub: { color: "#E8F2FF", fontSize: 13, fontWeight: "700", marginTop: 2, textAlign: "center" },
});
