import { LANGUAGES, LanguageCode, type Language } from "@talk/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../i18n";
import { colors } from "../lib/theme";

/** Extra type-ahead aliases (country / common spellings) → language code. */
const ALIASES: Record<string, LanguageCode> = {
  ישראל: "he",
  ישראלי: "he",
  ישראלית: "he",
  עבר: "he",
  hebrew: "he",
  ivrit: "he",
  america: "en",
  usa: "en",
  us: "en",
  england: "en",
  english: "en",
  אנגלית: "en",
  אמריקה: "en",
  רוסיה: "ru",
  ערבית: "ar",
  arabia: "ar",
  france: "fr",
  צרפת: "fr",
  spain: "es",
  ספרד: "es",
  germany: "de",
  גרמניה: "de",
  china: "zh",
  סין: "zh",
  japan: "ja",
  יפן: "ja",
  korea: "ko",
  קוריאה: "ko",
  india: "hi",
  הודו: "hi",
  turkey: "tr",
  טורקיה: "tr",
  ukraine: "uk",
  אוקראינה: "uk",
};

function norm(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

function matchScore(lang: Language, query: string): number {
  if (!query) return 0;
  const q = norm(query);
  const fields = [lang.nativeName, lang.nameHe, lang.nameEn, lang.code].map(norm);
  for (const f of fields) {
    if (f === q) return 100;
    if (f.startsWith(q)) return 80;
    if (f.includes(q)) return 40;
  }
  for (const [alias, code] of Object.entries(ALIASES)) {
    if (code !== lang.code) continue;
    const a = norm(alias);
    if (a === q) return 95;
    if (a.startsWith(q)) return 75;
    if (q.startsWith(a) && a.length >= 2) return 60;
  }
  return 0;
}

export function LanguagePicker({
  value,
  onChange,
}: {
  value: LanguageCode;
  onChange: (code: LanguageCode) => void;
}) {
  const { t, align } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState<LanguageCode>(value);
  const listRef = useRef<FlatList<Language>>(null);

  const selected = useMemo(
    () => LANGUAGES.find((l) => l.code === value) || LANGUAGES[0],
    [value],
  );

  const ranked = useMemo(() => {
    if (!query.trim()) return LANGUAGES.map((l, index) => ({ lang: l, score: l.code === value ? 1 : 0, index }));
    return LANGUAGES.map((l, index) => ({ lang: l, score: matchScore(l, query), index }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }, [query, value]);

  const rows = useMemo(
    () => (query.trim() ? ranked.map((r) => r.lang) : LANGUAGES),
    [query, ranked],
  );

  useEffect(() => {
    if (!open) return;
    const best = query.trim()
      ? ranked[0]?.lang.code
      : value;
    if (best) setHighlight(best);
  }, [query, open, ranked, value]);

  useEffect(() => {
    if (!open || !highlight) return;
    const idx = rows.findIndex((l) => l.code === highlight);
    if (idx < 0) return;
    const timer = setTimeout(() => {
      try {
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.2 });
      } catch {
        /* list may not be measured yet */
      }
    }, 40);
    return () => clearTimeout(timer);
  }, [highlight, open, rows]);

  function closeList() {
    setOpen(false);
    setQuery("");
    setSearching(false);
  }

  function pick(code: LanguageCode) {
    onChange(code);
    setHighlight(code);
    closeList();
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => {
          if (open) {
            closeList();
            return;
          }
          setQuery("");
          setSearching(false);
          setHighlight(value);
          setOpen(true);
        }}
        style={[styles.field, open && styles.fieldOpen]}
      >
        <Text style={[styles.fieldText, { textAlign: align }]}>{selected.nativeName}</Text>
        <Text style={styles.chevron}>{open ? "▴" : "▾"}</Text>
      </Pressable>

      {open ? (
        <View style={styles.dropdown}>
          {searching ? (
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("searchLanguage")}
              placeholderTextColor={colors.muted}
              style={[styles.search, { textAlign: align }]}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
            />
          ) : (
            <Pressable onPress={() => setSearching(true)} style={styles.search}>
              <Text style={[styles.searchHint, { textAlign: align }]}>{t("searchLanguage")}</Text>
            </Pressable>
          )}
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(item) => item.code}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            getItemLayout={(_, index) => ({ length: 48, offset: 48 * index, index })}
            onScrollToIndexFailed={(info) => {
              setTimeout(() => {
                listRef.current?.scrollToIndex({ index: info.index, animated: true });
              }, 80);
            }}
            renderItem={({ item }) => {
              const active = item.code === value;
              const lit = item.code === highlight;
              return (
                <Pressable
                  onPress={() => pick(item.code)}
                  style={[styles.row, lit && styles.rowLit, active && styles.rowOn]}
                >
                  <Text style={[styles.rowTitle, (lit || active) && styles.rowTitleOn, { textAlign: align }]}>
                    {item.nativeName}
                  </Text>
                  <Text style={[styles.rowSub, { textAlign: align }]}>
                    {item.nameHe}
                    {item.nameEn && item.nameEn !== item.nativeName ? ` · ${item.nameEn}` : ""}
                  </Text>
                  {!item.ttsSupported ? <Text style={styles.warn}>{t("captions")}</Text> : null}
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>{t("noLanguageMatch")}</Text>
            }
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { zIndex: 20 },
  field: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panelAlt,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  fieldOpen: { borderColor: colors.amber },
  fieldText: { color: colors.text, fontSize: 16, fontWeight: "600", flex: 1 },
  chevron: { color: colors.muted, fontSize: 14, marginStart: 8 },
  dropdown: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    borderRadius: 12,
    overflow: "hidden",
    maxHeight: 320,
  },
  search: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
  },
  searchHint: { color: colors.muted, fontSize: 15 },
  list: { maxHeight: 260 },
  row: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    justifyContent: "center",
  },
  rowLit: { backgroundColor: "rgba(245, 186, 64, 0.18)" },
  rowOn: { backgroundColor: colors.amber },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  rowTitleOn: { color: "#1A1406" },
  rowSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  warn: { color: colors.muted, fontSize: 10, marginTop: 2 },
  empty: { color: colors.muted, textAlign: "center", padding: 16 },
});
