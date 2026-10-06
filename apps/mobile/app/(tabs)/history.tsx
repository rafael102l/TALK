import { HistoryItem, TransmissionReadyPayload, VoiceGender } from "@talk/shared";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "../../src/components/Avatar";
import { BackBar } from "../../src/components/BackBar";
import { useI18n } from "../../src/i18n";
import { useAuth } from "../../src/lib/auth";
import { peekHistoryCache, refreshHistory, seedHistoryCache } from "../../src/lib/historyCache";
import { SOCKET_EVENTS, getSocket } from "../../src/lib/socket";
import { colors } from "../../src/lib/theme";
import { EMPTY_UNREAD, fetchUnread, type UnreadInfo } from "../../src/lib/unread";

type Thread = {
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  peerGender: VoiceGender;
  lastText: string;
  lastAt: string;
};

function itemKind(item: HistoryItem) {
  if (item.kind === "text" || item.kind === "voice" || item.kind === "walkie") return item.kind;
  if (item.audioUrl || item.durationMs) return "walkie";
  return "text";
}

function previewText(item: HistoryItem, t: (key: "voiceClip" | "walkieClip") => string) {
  if (item.viewOnce) return "1";
  const kind = itemKind(item);
  if (kind === "walkie") return item.translatedText || item.originalText || t("walkieClip");
  if (kind === "voice") return item.translatedText || item.originalText || t("voiceClip");
  return item.translatedText || item.originalText || "";
}

export default function HistoryScreen() {
  const router = useRouter();
  const { token } = useAuth();
  const { t, align, lang, row } = useI18n();
  const [items, setItems] = useState<HistoryItem[]>(() => peekHistoryCache());
  const [unread, setUnread] = useState<UnreadInfo>(EMPTY_UNREAD);
  const [error, setError] = useState("");

  const refreshUnread = useCallback(() => {
    if (!token) return;
    void fetchUnread(token).then(setUnread).catch(() => undefined);
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      if (!token) return;
      const cached = peekHistoryCache();
      if (cached.length) setItems(cached);
      void refreshHistory(token, { maxAgeMs: 8_000 })
        .then((rows) => {
          setItems(rows);
          setError("");
        })
        .catch((e) => {
          if (!peekHistoryCache().length) setError((e as Error).message);
        });
      refreshUnread();
    }, [token, refreshUnread]),
  );

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onReady = (payload: TransmissionReadyPayload) => {
      if (!payload.senderId || !token) return;
      void refreshHistory(token)
        .then(setItems)
        .catch(() => undefined);
      if (payload.kind === "text" || payload.kind === "voice") refreshUnread();
    };
    const onRemoved = () => {
      if (!token) return;
      void refreshHistory(token).then(setItems).catch(() => undefined);
      refreshUnread();
    };
    socket.on(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
    socket.on(SOCKET_EVENTS.TRANSMISSION_REMOVED, onRemoved);
    return () => {
      socket.off(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
      socket.off(SOCKET_EVENTS.TRANSMISSION_REMOVED, onRemoved);
    };
  }, [refreshUnread, token]);

  const threads = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const item of items) {
      const peerId = item.peerId || (item.mine ? "" : item.senderId);
      if (!peerId) continue;
      const lastText = previewText(item, t);
      const existing = map.get(peerId);
      if (!existing || item.createdAt > existing.lastAt) {
        map.set(peerId, {
          peerId,
          peerName: item.peerName || item.senderName,
          peerAvatar: item.peerAvatar ?? null,
          peerGender: item.peerGender ?? "male",
          lastText,
          lastAt: item.createdAt,
        });
      }
    }
    return [...map.values()].sort((a, b) => {
      const aTime = Date.parse(a.lastAt) || 0;
      const bTime = Date.parse(b.lastAt) || 0;
      return bTime - aTime;
    });
  }, [items, t]);

  return (
    <SafeAreaView style={styles.page}>
      <BackBar title={t("messages")} />
      {error ? <Text style={[styles.error, { textAlign: align }]}>{error}</Text> : null}
      <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 32 }}>
        {threads.map((thread) => (
          <Pressable
            key={thread.peerId}
            style={[styles.card, { flexDirection: row }]}
            onPress={() => {
              if (items.length) seedHistoryCache(items);
              router.push({
                pathname: "/conversation/[userId]",
                params: { userId: thread.peerId, name: thread.peerName },
              });
            }}
          >
            <View style={styles.avatarWrap}>
              <Avatar
                uri={thread.peerAvatar}
                name={thread.peerName}
                size={48}
                gender={thread.peerGender}
              />
              {(unread.byPeer[thread.peerId] || 0) > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {unread.byPeer[thread.peerId] > 99 ? "99+" : String(unread.byPeer[thread.peerId])}
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={styles.body}>
              <Text style={[styles.name, { textAlign: align }]}>{thread.peerName}</Text>
              <Text style={[styles.text, { textAlign: align }]} numberOfLines={2}>
                {thread.lastText}
              </Text>
              <Text style={[styles.meta, { textAlign: align }]}>
                {thread.lastAt ? new Date(thread.lastAt).toLocaleString(lang) : ""}
              </Text>
            </View>
          </Pressable>
        ))}
        {!threads.length ? <Text style={styles.empty}>{t("noHistory")}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  card: {
    backgroundColor: colors.panel,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    gap: 12,
  },
  body: { flex: 1 },
  avatarWrap: { width: 48, height: 48 },
  name: { color: colors.amber, fontWeight: "700", fontSize: 17 },
  text: { color: colors.text, marginTop: 4 },
  meta: { color: colors.muted, marginTop: 6, fontSize: 12 },
  empty: { color: colors.muted, textAlign: "center", marginTop: 40 },
  error: { color: colors.red },
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: "#E53935",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900" },
});
