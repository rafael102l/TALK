import { HistoryItem, TransmissionReadyPayload, VoiceGender } from "@talk/shared";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { I18nManager, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "../../src/components/Avatar";
import { BottomNav } from "../../src/components/BottomNav";
import { SearchIcon } from "../../src/components/MirsIcons";
import { useI18n } from "../../src/i18n";
import { useAuth } from "../../src/lib/auth";
import { api } from "../../src/lib/api";
import { peekHistoryCache, refreshHistory, seedHistoryCache } from "../../src/lib/historyCache";
import { loadGroups, onGroups, upsertGroup, type TalkGroup } from "../../src/lib/groups";
import { SOCKET_EVENTS, getSocket } from "../../src/lib/socket";
import { colors } from "../../src/lib/theme";
import { useTargets } from "../../src/lib/targets";
import { ackDelivered, EMPTY_UNREAD, fetchUnread, type UnreadInfo } from "../../src/lib/unread";

const CHATS = {
  bg: "#F8F9FA",
  ink: "#202124",
  mute: "#5F6368",
  card: "#FFFFFF",
  search: "#EEF1F4",
  line: "#DADCE0",
};

type Thread = {
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  peerGender: VoiceGender;
  lastText: string;
  lastAt: string;
  isGroup?: boolean;
};

function itemKind(item: HistoryItem) {
  if (item.kind === "text" || item.kind === "voice" || item.kind === "walkie" || item.kind === "image" || item.kind === "video") {
    return item.kind;
  }
  if (item.audioUrl || item.durationMs) return "walkie";
  return "text";
}

function lastWhen(iso: string, locale: string) {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) {
    return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString(locale, {
    day: "numeric",
    month: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function previewText(item: HistoryItem, t: (key: "voiceClip" | "walkieClip" | "photoClip" | "videoClip") => string) {
  if (item.viewOnce) return "1";
  const kind = itemKind(item);
  if (kind === "walkie") return item.translatedText || item.originalText || t("walkieClip");
  if (kind === "voice") return item.translatedText || item.originalText || t("voiceClip");
  if (kind === "image") return t("photoClip");
  if (kind === "video") return t("videoClip");
  return item.translatedText || item.originalText || "";
}

export default function HistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();
  const { t, align, lang } = useI18n();
  const { contacts, snapshots } = useTargets();
  const [items, setItems] = useState<HistoryItem[]>(() => peekHistoryCache());
  const [unread, setUnread] = useState<UnreadInfo>(EMPTY_UNREAD);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<TalkGroup[]>([]);

  const refreshUnread = useCallback(() => {
    if (!token) return;
    void fetchUnread(token, 20_000).then(setUnread).catch(() => undefined);
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      if (!token) return;
      const cached = peekHistoryCache();
      if (cached.length) setItems(cached);
      void refreshHistory(token, { maxAgeMs: 30_000 })
        .then((rows) => {
          setItems(rows);
          setError("");
        })
        .catch((e) => {
          if (!peekHistoryCache().length) setError((e as Error).message);
        });
      refreshUnread();
      void loadGroups().then(setGroups);
      void api<Array<{ id: string; type: string; name?: string | null; avatarUrl?: string | null; members?: { userId: string }[]; disappearAfterSec?: number }>>(
        "/channels",
        { token, once: true, timeoutMs: 8000 },
      )
        .then(async (list) => {
          for (const channel of list || []) {
            if (channel.type !== "GROUP" && channel.type !== "BROADCAST") continue;
            await upsertGroup({
              id: channel.id,
              name: channel.name || t("newGroup"),
              avatarUrl: channel.avatarUrl || null,
              memberIds: (channel.members || []).map((row) => row.userId),
              disappearAfterSec: channel.disappearAfterSec || 0,
            });
          }
          setGroups(await loadGroups());
        })
        .catch(() => undefined);
      return onGroups(() => {
        void loadGroups().then(setGroups);
      });
    }, [token, refreshUnread]),
  );

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onReady = (payload: TransmissionReadyPayload) => {
      if (!payload.senderId || !token) return;
      ackDelivered(token, payload, user?.id);
      void refreshHistory(token)
        .then(setItems)
        .catch(() => undefined);
      if (payload.kind === "text" || payload.kind === "voice") refreshUnread();
    };
    const onRemoved = () => {
      if (!token) return;
      void refreshHistory(token)
        .then(setItems)
        .catch(() => undefined);
      refreshUnread();
    };
    socket.on(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
    socket.on(SOCKET_EVENTS.TRANSMISSION_REMOVED, onRemoved);
    return () => {
      socket.off(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
      socket.off(SOCKET_EVENTS.TRANSMISSION_REMOVED, onRemoved);
    };
  }, [refreshUnread, token, user?.id]);

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
          isGroup: Boolean(item.channelId && item.channelId === item.peerId),
        });
      }
    }
    for (const group of groups) {
      const existing = map.get(group.id);
      if (!existing) {
        map.set(group.id, {
          peerId: group.id,
          peerName: group.name,
          peerAvatar: group.avatarUrl,
          peerGender: "male",
          lastText: "",
          lastAt: "",
          isGroup: true,
        });
      } else {
        existing.isGroup = true;
        existing.peerName = group.name || existing.peerName;
        existing.peerAvatar = group.avatarUrl || existing.peerAvatar;
      }
    }
    return [...map.values()].sort((a, b) => {
      const aTime = Date.parse(a.lastAt) || 0;
      const bTime = Date.parse(b.lastAt) || 0;
      return bTime - aTime;
    });
  }, [items, t, groups]);

  const people = useMemo(
    () => contacts.filter((contact) => contact.matchedUser && (contact.status === "ACCEPTED" || !contact.status)),
    [contacts],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const recent = threads.filter((thread) => {
      if (!needle) return true;
      return thread.peerName.toLowerCase().includes(needle) || thread.lastText.toLowerCase().includes(needle);
    });
    if (!needle) return recent;
    const known = new Set(threads.map((thread) => thread.peerId));
    const extra: Thread[] = [];
    for (const contact of people) {
      const person = contact.matchedUser!;
      if (known.has(person.id)) continue;
      const name = person.displayName || contact.displayName || "";
      const phone = contact.phoneE164 || person.phoneE164 || "";
      if (!name.toLowerCase().includes(needle) && !phone.includes(needle)) continue;
      extra.push({
        peerId: person.id,
        peerName: name,
        peerAvatar: person.avatarUrl ?? null,
        peerGender: person.voiceGender ?? "male",
        lastText: "",
        lastAt: "",
      });
    }
    return [...recent, ...extra];
  }, [threads, query, people]);

  function photoFor(thread: Thread) {
    const contact = contacts.find((row) => row.matchedUser?.id === thread.peerId);
    return contact?.matchedUser?.avatarUrl || snapshots[thread.peerId]?.photo || thread.peerAvatar || null;
  }

  function phoneFor(thread: Thread) {
    const contact = contacts.find((row) => row.matchedUser?.id === thread.peerId);
    return contact?.matchedUser?.phoneE164 || contact?.phoneE164 || "";
  }

  function openChat(thread: Thread) {
    if (items.length) seedHistoryCache(items);
    router.push({
      pathname: "/conversation/[userId]",
      params: { userId: thread.peerId, name: thread.peerName, group: thread.isGroup ? "1" : "" },
    });
  }

  function openCard(thread: Thread) {
    router.push({
      pathname: "/contact/[userId]",
      params: {
        userId: thread.peerId,
        name: thread.peerName,
        avatarUrl: photoFor(thread) || "",
        phone: phoneFor(thread),
        gender: thread.peerGender,
      },
    });
  }

  function statusLine(thread: Thread) {
    return thread.lastText || "";
  }

  const waiting = (peerId: string) => unread.byPeer[peerId] || 0;

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <Text style={[styles.title, { textAlign: align }]}>{t("navChats")}</Text>
      <View style={[styles.search, { flexDirection: I18nManager.isRTL ? "row-reverse" : "row" }]}>
        <SearchIcon size={18} color={CHATS.mute} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("searchPlaceholder")}
          placeholderTextColor={CHATS.mute}
          style={[styles.input, { textAlign: align === "right" ? (I18nManager.isRTL ? "left" : "right") : I18nManager.isRTL ? "right" : "left" }]}
        />
      </View>
      {error ? <Text style={[styles.note, { textAlign: align }]}>{error}</Text> : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
        {shown.map((thread) => (
          <View key={thread.peerId} style={[styles.row, { flexDirection: I18nManager.isRTL ? "row-reverse" : "row" }]}>
            <Pressable style={styles.whenWrap} onPress={() => openChat(thread)}>
              <Text style={styles.when}>{lastWhen(thread.lastAt, lang)}</Text>
            </Pressable>
            <Pressable style={styles.mid} onPress={() => openChat(thread)}>
              <Text
                style={[styles.name, { textAlign: I18nManager.isRTL ? "left" : "right" }]}
                numberOfLines={1}
              >
                {thread.peerName}
              </Text>
              <Text
                style={[styles.status, { textAlign: I18nManager.isRTL ? "left" : "right" }]}
                numberOfLines={1}
              >
                {statusLine(thread)}
              </Text>
            </Pressable>
            <Pressable onPress={() => (thread.isGroup ? openChat(thread) : openCard(thread))} hitSlop={6}>
              <View style={styles.avatarWrap}>
                <Avatar uri={photoFor(thread)} name={thread.peerName} size={48} gender={thread.peerGender} />
                {waiting(thread.peerId) > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {waiting(thread.peerId) > 99 ? "99+" : String(waiting(thread.peerId))}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          </View>
        ))}
        {!shown.length ? <Text style={styles.empty}>{t("noHistory")}</Text> : null}
      </ScrollView>
      <View style={[styles.navBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <BottomNav />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: CHATS.bg, paddingHorizontal: 16 },
  title: { color: CHATS.ink, fontSize: 26, fontWeight: "800", marginTop: 8 },
  search: {
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: CHATS.line,
    backgroundColor: CHATS.search,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  input: { flex: 1, color: CHATS.ink, fontSize: 16, paddingVertical: 2 },
  note: { color: "#B06000", marginBottom: 6 },
  scroll: { flex: 1 },
  list: { paddingBottom: 12 },
  row: {
    alignItems: "center",
    backgroundColor: CHATS.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: CHATS.line,
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginBottom: 8,
    gap: 12,
  },
  whenWrap: {
    minWidth: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  when: { color: CHATS.mute, fontSize: 12, fontWeight: "600" },
  mid: { flex: 1 },
  name: { color: CHATS.ink, fontSize: 17, fontWeight: "700" },
  status: { color: CHATS.mute, marginTop: 2, fontSize: 13 },
  empty: { color: CHATS.mute, textAlign: "center", marginTop: 36 },
  avatarWrap: { width: 48, height: 48 },
  navBar: { backgroundColor: colors.bg, marginHorizontal: -16 },
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
