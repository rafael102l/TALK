import {
  CountryCode,
  DEFAULT_COUNTRY,
  findPhoneCountry,
  listPhoneCountries,
  parsePastedPhone,
  PhoneCountry,
  toE164,
} from "@talk/shared";
import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { colors } from "../lib/theme";

export function PhoneCountryField({
  country,
  national,
  onCountryChange,
  onNationalChange,
  autoFocus,
}: {
  country: CountryCode;
  national: string;
  onCountryChange: (country: CountryCode) => void;
  onNationalChange: (national: string) => void;
  autoFocus?: boolean;
}) {
  const { t, lang, align, row } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = findPhoneCountry(country);

  function localizedName(iso: string, fallback: string) {
    try {
      return new Intl.DisplayNames([lang], { type: "region" }).of(iso) ?? fallback;
    } catch {
      return fallback;
    }
  }

  const countries = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\+/, "");
    const all = listPhoneCountries();
    if (!q) return all;
    return all.filter((item) => {
      const local = localizedName(item.iso, item.name).toLowerCase();
      return (
        local.includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.iso.toLowerCase().includes(q) ||
        item.callingCode.includes(q)
      );
    });
  }, [query, lang]);

  function onChangeNumber(value: string) {
    const pasted = value.includes("+") ? parsePastedPhone(value, country) : null;
    if (pasted) {
      onCountryChange(pasted.country);
      onNationalChange(pasted.national);
      return;
    }
    onNationalChange(value.replace(/[^\d]/g, ""));
  }

  function pick(item: PhoneCountry) {
    onCountryChange(item.iso);
    setOpen(false);
    setQuery("");
  }

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.countryRow} onPress={() => setOpen(true)}>
        <Text style={styles.flag}>{selected.flag}</Text>
        <Text style={styles.countryName}>{localizedName(selected.iso, selected.name)}</Text>
        <Text style={styles.code}>+{selected.callingCode}</Text>
        <Text style={styles.chevron}>▼</Text>
      </Pressable>
      <View style={styles.numberRow}>
        <Text style={styles.prefix}>+{selected.callingCode}</Text>
        <TextInput
          style={styles.input}
          value={national}
          onChangeText={onChangeNumber}
          keyboardType="phone-pad"
          placeholder={t("phonePlaceholder")}
          placeholderTextColor={colors.muted}
          autoFocus={autoFocus}
        />
      </View>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modal}>
          <View style={[styles.modalTop, { flexDirection: row }]}>
            <Text style={styles.modalTitle}>{t("chooseCountryTitle")}</Text>
            <Pressable onPress={() => setOpen(false)} style={styles.close}>
              <Text style={styles.closeText}>{t("close")}</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder={t("searchCountry")}
            placeholderTextColor={colors.muted}
            textAlign={align}
            autoCorrect={false}
          />
          <FlatList
            data={countries}
            keyExtractor={(item) => item.iso}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                style={[styles.option, item.iso === country && styles.optionOn]}
                onPress={() => pick(item)}
              >
                <Text style={styles.flag}>{item.flag}</Text>
                <Text style={styles.optionName}>{localizedName(item.iso, item.name)}</Text>
                <Text style={styles.optionCode}>+{item.callingCode}</Text>
              </Pressable>
            )}
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}

export function composedE164(country: CountryCode, national: string) {
  return toE164(national, country) ?? (national.startsWith("+") ? toE164(national) : null);
}

export { DEFAULT_COUNTRY };

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  countryRow: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
    gap: 10,
    borderWidth: 2,
    borderColor: colors.ring,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  flag: { fontSize: 24 },
  countryName: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "700", textAlign: "left" },
  code: { color: colors.ring, fontSize: 16, fontWeight: "800" },
  chevron: { color: colors.ring, fontSize: 12 },
  numberRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 2,
    borderColor: colors.ring,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.12)",
    paddingHorizontal: 12,
    direction: "ltr",
  },
  prefix: { color: colors.ring, fontSize: 18, fontWeight: "800", paddingHorizontal: 6 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 20,
    paddingVertical: 12,
    letterSpacing: 0.5,
  },
  modal: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  modalTop: {
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  modalTitle: { color: colors.text, fontSize: 22, fontWeight: "800" },
  close: {
    borderWidth: 2,
    borderColor: colors.ring,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  closeText: { color: colors.ring, fontWeight: "700" },
  search: {
    borderWidth: 2,
    borderColor: colors.ring,
    borderRadius: 16,
    color: colors.text,
    padding: 12,
    fontSize: 16,
    marginBottom: 8,
  },
  option: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.18)",
  },
  optionOn: { backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 12, paddingHorizontal: 8 },
  optionName: { flex: 1, color: colors.text, fontSize: 16, textAlign: "left" },
  optionCode: { color: colors.muted, fontWeight: "700" },
});
