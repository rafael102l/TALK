import { LanguageCode, VoiceGender } from "@talk/shared";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../i18n";
import { isRtlLang, translateMsg, type MsgKey } from "../i18n/catalog";
import { colors } from "../lib/theme";

const OPTIONS: { id: VoiceGender; key: "voiceMale" | "voiceFemale" | "voiceChild" }[] = [
  { id: "male", key: "voiceMale" },
  { id: "female", key: "voiceFemale" },
  { id: "child", key: "voiceChild" },
];

export function VoicePicker({
  value,
  onChange,
  lang,
}: {
  value: VoiceGender;
  onChange: (value: VoiceGender) => void;
  lang?: LanguageCode;
}) {
  const i18n = useI18n();
  const t = lang ? (key: MsgKey) => translateMsg(lang, key) : i18n.t;
  const align = lang ? (isRtlLang(lang) ? "right" : "left") : i18n.align;
  return (
    <View style={styles.row}>
      {OPTIONS.map((option) => {
        const on = option.id === value;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            style={[styles.chip, on && styles.chipOn]}
          >
            <Text style={[styles.label, on && styles.labelOn, { textAlign: align }]}>{t(option.key)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  chip: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panelAlt,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  chipOn: { backgroundColor: colors.amber, borderColor: colors.amber },
  label: { color: colors.text, fontWeight: "800", fontSize: 14 },
  labelOn: { color: "#1A1406" },
});
