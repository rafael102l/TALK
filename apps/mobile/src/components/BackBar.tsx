import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../i18n";
import { colors } from "../lib/theme";

export function BackBar({ title }: { title: string }) {
  const router = useRouter();
  const { t, align, row } = useI18n();
  return (
    <View style={[styles.row, { flexDirection: row }]}>
      <Text style={[styles.title, { textAlign: align }]}>{title}</Text>
      <Pressable
        onPress={() => {
          if (router.canGoBack()) router.back();
          else router.replace("/home");
        }}
        style={styles.back}
      >
        <Text style={styles.backText}>{t("back")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  title: { color: colors.text, fontSize: 26, fontWeight: "800", textAlign: "right", flex: 1 },
  back: {
    borderWidth: 2,
    borderColor: colors.ring,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  backText: { color: colors.ring, fontWeight: "700" },
});
