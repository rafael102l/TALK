import { HistoryItem, TransmissionReadyPayload } from "@talk/shared";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  InteractionManager,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BackBar } from "../../src/components/BackBar";
import { EmojiPicker } from "../../src/components/EmojiPicker";
import { MicIcon, SendArrowIcon } from "../../src/components/MirsIcons";
import { PttButton } from "../../src/components/PttButton";
import { RecordDock } from "../../src/components/RecordDock";
import { ViewOncePlayer } from "../../src/components/ViewOncePlayer";
import { VoiceBubble } from "../../src/components/VoiceBubble";
import { useI18n } from "../../src/i18n";
import { api } from "../../src/lib/api";
import {
  cancelRecording,
  getRecordingMeter,
  pauseRecording,
  resumeRecording,
  startRecording,
  stopPlayback,
  stopRecording,
} from "../../src/lib/audio";
import { useAuth } from "../../src/lib/auth";
import { MAX_PTT_MS } from "../../src/lib/config";
import { holdDiscovery } from "../../src/lib/discover";
import {
  isHistoryFresh,
  peekHistoryCache,
  refreshHistory,
  seedHistoryCache,
} from "../../src/lib/historyCache";
import { SOCKET_EVENTS, getSocket } from "../../src/lib/socket";
import { colors } from "../../src/lib/theme";
import { markPeerTextRead } from "../../src/lib/unread";

function txIdOf(id: string) {
  return id.split(":")[0];
}

function itemKind(item: HistoryItem): "walkie" | "voice" | "text" {
  if (item.kind === "text" || item.kind === "voice" || item.kind === "walkie") return item.kind;
  if (item.audioUrl || item.durationMs) return "walkie";
  return "text";
}

type Tab = "messages" | "walkie";

export default function ConversationScreen() {
  const { userId, name } = useLocalSearchParams<{ userId: string; name?: string }>();
  const { token, user } = useAuth();
  const { t, align, lang, row, rtl } = useI18n();
  const [tab, setTab] = useState<Tab>("messages");
  const [walkieMounted, setWalkieMounted] = useState(false);
  const [items, setItems] = useState<HistoryItem[]>(() => peekHistoryCache());
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const hasDraft = draft.length > 0;
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const [walkieTalking, setWalkieTalking] = useState(false);
  const [onceItem, setOnceItem] = useState<HistoryItem | null>(null);
  const recordingRef = useRef(false);
  const walkieTalkingRef = useRef(false);
  const wantEndWalkieRef = useRef(false);
  const walkiePressRef = useRef(0);
  const onceRef = useRef<HistoryItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const walkieTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgScroll = useRef<ScrollView>(null);
  const walkieScroll = useRef<ScrollView>(null);

  const load = useCallback(
    (opts?: { immediate?: boolean }) => {
      if (!token) return;
      const cached = peekHistoryCache();
      if (cached.length) setItems(cached);
      // Fresh cache: paint instantly, skip blocking network on open.
      if (!opts?.immediate && isHistoryFresh(45_000)) return;
      const run = () => {
        void refreshHistory(token, { maxAgeMs: opts?.immediate ? 0 : 45_000 })
          .then((rows) => {
            setItems(rows);
            setError("");
          })
          .catch((e) => {
            if (!peekHistoryCache().length) setError((e as Error).message);
          });
      };
      if (opts?.immediate) run();
      else InteractionManager.runAfterInteractions(run);
    },
    [token],
  );

  useFocusEffect(
    useCallback(() => {
      const cached = peekHistoryCache();
      if (cached.length) setItems(cached);
      load();
      let cancelled = false;
      InteractionManager.runAfterInteractions(() => {
        if (cancelled || !token || !userId) return;
        void markPeerTextRead(token, userId).catch(() => undefined);
      });
      return () => {
        cancelled = true;
        if (onceRef.current && onceRef.current.viewOnce && !onceRef.current.mine && token) {
          const id = txIdOf(onceRef.current.id);
          void api(`/transmissions/${id}/once-close`, { method: "POST", token }).catch(() => undefined);
          onceRef.current = null;
        }
        if (recordingRef.current) {
          recordingRef.current = false;
          void cancelRecording();
        }
        if (walkieTalkingRef.current) {
          walkieTalkingRef.current = false;
          holdDiscovery(false);
          void cancelRecording();
        }
      };
    }, [load, token, userId]),
  );

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onReady = (payload: TransmissionReadyPayload) => {
      if (payload.senderId !== userId && payload.senderId !== user?.id) return;
      if (!payload.transmissionId) return;
      const mine = payload.senderId === user?.id;
      const kind = payload.kind || (payload.audioUrl ? "walkie" : "text");
      // Each device keeps the transcript in its own language:
      // sender → source text; recipient → translated listen-language text.
      const myText = mine
        ? payload.originalText || payload.translatedText || null
        : payload.translatedText || payload.originalText || null;
      const row: HistoryItem = {
        id: mine ? `${payload.transmissionId}:${userId}` : payload.transmissionId,
        senderName: payload.senderName || "",
        senderId: payload.senderId,
        originalText: mine ? myText : payload.originalText ?? null,
        translatedText: myText,
        audioUrl: kind === "text" ? null : payload.audioUrl ?? null,
        language: payload.language,
        speakLang: payload.speakLang,
        createdAt: new Date().toISOString(),
        durationMs: payload.durationMs ?? null,
        mine,
        peerId: userId,
        peerAvatar: mine ? user?.avatarUrl : payload.senderAvatarUrl,
        peerGender: payload.voiceGender,
        kind,
        viewOnce: payload.viewOnce,
      };
      setItems((current) => {
        const without = current.filter(
          (item) =>
            txIdOf(item.id) !== payload.transmissionId &&
            !(item.id.startsWith("local-") && item.mine === mine && itemKind(item) === kind),
        );
        const next = [row, ...without];
        seedHistoryCache(next);
        return next;
      });
      if (token && (kind === "text" || kind === "voice") && payload.senderId === userId) {
        void markPeerTextRead(token, userId).catch(() => undefined);
      }
    };
    const onRemoved = (payload: { transmissionId?: string }) => {
      const id = payload.transmissionId;
      if (!id) return;
      setItems((current) => current.filter((item) => txIdOf(item.id) !== id));
      if (onceRef.current && txIdOf(onceRef.current.id) === id) {
        onceRef.current = null;
        setOnceItem(null);
      }
    };
    socket.on(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
    socket.on(SOCKET_EVENTS.TRANSMISSION_REMOVED, onRemoved);
    return () => {
      socket.off(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
      socket.off(SOCKET_EVENTS.TRANSMISSION_REMOVED, onRemoved);
    };
  }, [user?.id, user?.avatarUrl, userId, token]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      void getRecordingMeter().then((meter) => setRecMs(meter.durationMs));
    }, 90);
    return () => clearInterval(id);
  }, [recording]);

  const peerItems = useMemo(() => {
    const rows = items.filter((item) => (item.peerId || (!item.mine && item.senderId)) === userId);
    return rows.sort((a, b) => {
      const aTime = Date.parse(a.createdAt) || 0;
      const bTime = Date.parse(b.createdAt) || 0;
      if (aTime !== bTime) return aTime - bTime;
      return String(a.id).localeCompare(String(b.id));
    });
  }, [items, userId]);

  const walkieThread = useMemo(() => {
    if (!walkieMounted) return [] as HistoryItem[];
    return peerItems.filter((item) => itemKind(item) === "walkie");
  }, [peerItems, walkieMounted]);
  const messageThread = useMemo(() => {
    const rows = peerItems.filter((item) => itemKind(item) !== "walkie");
    // First paint: newest slice only — keeps open snappy on long threads.
    return rows.length > 80 ? rows.slice(rows.length - 80) : rows;
  }, [peerItems]);

  const lastMessageId = messageThread[messageThread.length - 1]?.id ?? "";
  const lastWalkieId = walkieThread[walkieThread.length - 1]?.id ?? "";

  const stickBottom = useCallback((which: Tab) => {
    const ref = which === "messages" ? msgScroll : walkieScroll;
    requestAnimationFrame(() => {
      ref.current?.scrollToEnd({ animated: false });
      setTimeout(() => ref.current?.scrollToEnd({ animated: false }), 50);
    });
  }, []);

  useEffect(() => {
    if (tab !== "messages") return;
    stickBottom("messages");
  }, [tab, messageThread.length, lastMessageId, stickBottom]);

  useEffect(() => {
    if (tab !== "walkie") return;
    stickBottom("walkie");
  }, [tab, walkieThread.length, lastWalkieId, stickBottom]);

  const title = name || peerItems[0]?.peerName || t("messages");

  function switchTab(next: Tab) {
    if (next === tab) return;
    if (next === "walkie") setWalkieMounted(true);
    setTab(next);
    setEmojiOpen(false);
    // Cleanup after paint so the tab switch feels instant.
    requestAnimationFrame(() => {
      if (next === "walkie" && recordingRef.current) void deleteRec();
      if (next === "messages" && walkieTalkingRef.current) void endWalkie();
    });
  }

  async function sendText() {
    const text = draft.trim();
    if (!text || !token || !userId || sending || recordingRef.current || walkieTalkingRef.current) return;
    setSending(true);
    setError("");
    setDraft("");
    setEmojiOpen(false);
    const optimistic: HistoryItem = {
      id: `local-${Date.now()}`,
      senderName: user?.displayName || "",
      senderId: user?.id || "",
      originalText: text,
      translatedText: text,
      audioUrl: null,
      language: user?.speakLang || lang,
      createdAt: new Date().toISOString(),
      durationMs: null,
      mine: true,
      peerId: userId,
      kind: "text",
    };
    setItems((current) => {
      const next = [optimistic, ...current];
      seedHistoryCache(next);
      return next;
    });
    try {
      await api("/transmissions/text", {
        method: "POST",
        token,
        timeoutMs: 45000,
        body: JSON.stringify({ originalText: text, targetUserIds: [userId] }),
      });
      load();
    } catch (e) {
      setError((e as Error).message);
      setDraft(text);
      setItems((current) => {
        const next = current.filter((item) => item.id !== optimistic.id);
        seedHistoryCache(next);
        return next;
      });
    } finally {
      setSending(false);
    }
  }

  async function beginVoice() {
    if (recordingRef.current || walkieTalkingRef.current || sending || !userId) return;
    setEmojiOpen(false);
    try {
      await stopPlayback();
      recordingRef.current = true;
      setPaused(false);
      setRecMs(0);
      setError("");
      await startRecording();
      setRecording(true);
      timer.current = setTimeout(() => {
        void pauseRec(true);
      }, MAX_PTT_MS);
    } catch (e) {
      recordingRef.current = false;
      setRecording(false);
      setError((e as Error).message);
    }
  }

  async function pauseRec(force = false) {
    if (!recordingRef.current) return;
    if (paused && !force) {
      await resumeRecording();
      setPaused(false);
      return;
    }
    await pauseRecording();
    setPaused(true);
    if (timer.current) clearTimeout(timer.current);
  }

  async function deleteRec() {
    if (timer.current) clearTimeout(timer.current);
    recordingRef.current = false;
    setRecording(false);
    setPaused(false);
    setRecMs(0);
    await cancelRecording();
  }

  async function sendVoice(viewOnce: boolean) {
    if (!recordingRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    recordingRef.current = false;
    setRecording(false);
    setPaused(false);
    const recorded = await stopRecording();
    if (!recorded?.uri || !token || !userId) return;
    if ((recorded.durationMs ?? 0) < 400) {
      setError(t("tooShort"));
      return;
    }
    setError("");
    const optimistic: HistoryItem = {
      id: `local-${Date.now()}`,
      senderName: user?.displayName || "",
      senderId: user?.id || "",
      originalText: null,
      translatedText: null,
      audioUrl: recorded.uri,
      language: user?.speakLang || lang,
      createdAt: new Date().toISOString(),
      durationMs: recorded.durationMs,
      mine: true,
      peerId: userId,
      peerAvatar: user?.avatarUrl,
      kind: "voice",
      viewOnce,
    };
    setItems((current) => [optimistic, ...current]);
    const form = new FormData();
    form.append("audio", {
      uri: recorded.uri,
      name: "voice.m4a",
      type: "audio/m4a",
    } as unknown as Blob);
    form.append("durationMs", String(recorded.durationMs ?? 0));
    form.append("targetUserIds", JSON.stringify([userId]));
    form.append("kind", "voice");
    form.append("viewOnce", viewOnce ? "true" : "false");
    try {
      await api("/transmissions", { method: "POST", token, body: form, timeoutMs: 45000 });
      load();
    } catch (e) {
      setError((e as Error).message);
      setItems((current) => current.filter((item) => item.id !== optimistic.id));
    }
  }

  async function beginWalkie() {
    if (walkieTalkingRef.current || recordingRef.current || !userId) return;
    try {
      wantEndWalkieRef.current = false;
      walkieTalkingRef.current = true;
      holdDiscovery(true);
      setWalkieTalking(true);
      setError("");
      walkiePressRef.current = Date.now();
      await stopPlayback();
      await startRecording();
      if (wantEndWalkieRef.current) {
        await endWalkie();
        return;
      }
      getSocket()?.emit(SOCKET_EVENTS.PTT_START, { targetUserIds: [userId] });
      walkieTimer.current = setTimeout(() => void endWalkie(), MAX_PTT_MS);
    } catch (e) {
      walkieTalkingRef.current = false;
      holdDiscovery(false);
      setWalkieTalking(false);
      setError((e as Error).message);
    }
  }

  async function endWalkie() {
    wantEndWalkieRef.current = true;
    if (!walkieTalkingRef.current) return;
    walkieTalkingRef.current = false;
    holdDiscovery(false);
    if (walkieTimer.current) clearTimeout(walkieTimer.current);
    setWalkieTalking(false);
    const release = Date.now();
    getSocket()?.emit(SOCKET_EVENTS.PTT_RELEASED, { targetUserIds: userId ? [userId] : [] });
    let recorded: { uri: string; durationMs: number; peakDb: number } | null = null;
    try {
      recorded = await stopRecording();
    } catch (e) {
      setError((e as Error).message || t("txFail"));
      return;
    }
    if (!recorded?.uri || !token || !userId) {
      setError(t("txFail"));
      return;
    }
    const holdMs = walkiePressRef.current ? release - walkiePressRef.current : 0;
    const durationMs = recorded.durationMs || holdMs;
    if (durationMs < 500) {
      setError(t("tooShort"));
      return;
    }
    setError("");
    const optimistic: HistoryItem = {
      id: `local-${Date.now()}`,
      senderName: user?.displayName || "",
      senderId: user?.id || "",
      originalText: null,
      translatedText: null,
      audioUrl: recorded.uri,
      language: user?.speakLang || lang,
      createdAt: new Date().toISOString(),
      durationMs,
      mine: true,
      peerId: userId,
      peerAvatar: user?.avatarUrl,
      kind: "walkie",
    };
    setItems((current) => [optimistic, ...current]);
    const wav = recorded.uri.toLowerCase().includes(".wav") || recorded.uri.toLowerCase().includes(".caf");
    const form = new FormData();
    form.append("audio", {
      uri: recorded.uri,
      name: wav ? "ptt.wav" : "ptt.m4a",
      type: wav ? "audio/wav" : "audio/m4a",
    } as unknown as Blob);
    form.append("durationMs", String(durationMs));
    form.append("targetUserIds", JSON.stringify([userId]));
    form.append("kind", "walkie");
    form.append("releasedAt", String(release));
    try {
      await api("/transmissions", { method: "POST", token, body: form, timeoutMs: 45000 });
      load();
    } catch (e) {
      setError((e as Error).message);
      setItems((current) => current.filter((item) => item.id !== optimistic.id));
    }
  }

  async function closeOnce() {
    const item = onceRef.current;
    onceRef.current = null;
    setOnceItem(null);
    await stopPlayback();
    if (!item || item.mine || !item.viewOnce || !token) return;
    const id = txIdOf(item.id);
    try {
      await api(`/transmissions/${id}/once-close`, { method: "POST", token });
    } catch {
      /* already gone */
    }
    setItems((current) => current.filter((row) => txIdOf(row.id) !== id));
  }

  function walkieCaption(item: HistoryItem, mine: boolean) {
    // Own device language: sender keeps source text; incoming keeps listen-language text.
    if (mine) return item.originalText || item.translatedText || "";
    return item.translatedText || item.originalText || "";
  }

  function messageText(item: HistoryItem, mine: boolean) {
    if (mine) return item.originalText || item.translatedText || "";
    return item.translatedText || item.originalText || "";
  }

  function renderThread(list: HistoryItem[]) {
    return list.map((item) => {
      const mine = Boolean(item.mine || item.senderId === user?.id);
      const kind = itemKind(item);
      if (kind === "walkie" || kind === "voice") {
        const locked = Boolean(item.viewOnce && !mine);
        return (
          <VoiceBubble
            key={item.id}
            uri={item.audioUrl}
            durationMs={item.durationMs}
            mine={mine}
            avatarUrl={mine ? user?.avatarUrl : item.peerAvatar}
            name={mine ? user?.displayName : item.senderName}
            gender={item.peerGender}
            locked={locked}
            viewOnce={item.viewOnce}
            caption={
              kind === "walkie"
                ? walkieCaption(item, mine)
                : item.translatedText || item.originalText || ""
            }
            onOpenOnce={() => {
              onceRef.current = item;
              setOnceItem(item);
            }}
          />
        );
      }
      const text = messageText(item, mine);
      return (
        <View key={item.id} style={[styles.row, mine ? styles.mineRow : styles.theirsRow]}>
          <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
            {text ? <Text style={styles.text}>{text}</Text> : null}
            <Text style={styles.meta}>{new Date(item.createdAt).toLocaleString(lang)}</Text>
          </View>
        </View>
      );
    });
  }

  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "padding"}
        keyboardVerticalOffset={8}
      >
        <View style={styles.body}>
          <BackBar title={title} />
          <View style={[styles.tabs, { flexDirection: row }]}>
            <Pressable
              onPress={() => switchTab("messages")}
              style={[styles.tab, tab === "messages" && styles.tabOn]}
            >
              <Text style={[styles.tabText, tab === "messages" && styles.tabTextOn]}>
                {t("messages")}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => switchTab("walkie")}
              style={[styles.tab, tab === "walkie" && styles.tabOn]}
            >
              <Text style={[styles.tabText, tab === "walkie" && styles.tabTextOn]}>
                {t("tabWalkie")}
              </Text>
            </Pressable>
          </View>
          {error ? <Text style={[styles.error, { textAlign: align }]}>{error}</Text> : null}
          <View style={styles.panels}>
            <View
              style={[styles.panel, tab !== "messages" && styles.panelOff]}
              pointerEvents={tab === "messages" ? "auto" : "none"}
            >
              <ScrollView
                ref={msgScroll}
                contentContainerStyle={styles.list}
                keyboardShouldPersistTaps="handled"
                removeClippedSubviews
                onContentSizeChange={() => stickBottom("messages")}
              >
                {renderThread(messageThread)}
                {!messageThread.length ? <Text style={styles.empty}>{t("noMessagesYet")}</Text> : null}
              </ScrollView>
            </View>
            {walkieMounted ? (
              <View
                style={[styles.panel, tab !== "walkie" && styles.panelOff]}
                pointerEvents={tab === "walkie" ? "auto" : "none"}
              >
                <ScrollView
                  ref={walkieScroll}
                  contentContainerStyle={styles.list}
                  keyboardShouldPersistTaps="handled"
                  removeClippedSubviews
                  onContentSizeChange={() => stickBottom("walkie")}
                >
                  {renderThread(walkieThread)}
                  {!walkieThread.length ? <Text style={styles.empty}>{t("noWalkieYet")}</Text> : null}
                </ScrollView>
              </View>
            ) : null}
          </View>
        </View>
        {tab === "messages" ? (
          <View>
            <EmojiPicker
              visible={emojiOpen && !recording}
              onPick={(emoji) => setDraft((current) => `${current}${emoji}`)}
            />
            {recording ? (
              <View style={styles.dockBleed}>
                <RecordDock
                  durationMs={recMs}
                  paused={paused}
                  live={!paused}
                  onPause={() => void pauseRec()}
                  onSend={() => void sendVoice(false)}
                  onDelete={() => void deleteRec()}
                  onViewOnce={() => void sendVoice(true)}
                />
              </View>
            ) : (
              <View style={styles.composer}>
                <View style={styles.pill}>
                  <Pressable
                    onPress={() => setEmojiOpen((open) => !open)}
                    hitSlop={8}
                    style={styles.emojiBtn}
                  >
                    <Text style={[styles.pillIcon, emojiOpen && styles.pillIconOn]}>😊</Text>
                  </Pressable>
                  <TextInput
                    style={[styles.input, { textAlign: align }]}
                    value={draft}
                    onChangeText={(value) => {
                      setDraft(value);
                      if (emojiOpen && value.length === 0) setEmojiOpen(false);
                    }}
                    onFocus={() => setEmojiOpen(false)}
                    placeholder={t("typeMessage")}
                    placeholderTextColor="#7A99C4"
                    multiline
                    underlineColorAndroid="transparent"
                  />
                </View>
                <Pressable
                  onPress={() => {
                    if (hasDraft) void sendText();
                    else void beginVoice();
                  }}
                  disabled={hasDraft && (!draft.trim() || sending)}
                  style={[styles.actionBtn, hasDraft && (!draft.trim() || sending) && styles.actionOff]}
                  hitSlop={4}
                >
                  {hasDraft ? (
                    <SendArrowIcon size={22} color="#FFFFFF" rtl={rtl} />
                  ) : (
                    <MicIcon size={26} color="#FFFFFF" />
                  )}
                </Pressable>
              </View>
            )}
          </View>
        ) : walkieMounted ? (
          <View style={styles.walkieDock}>
            <Text style={[styles.walkieHint, { textAlign: "center" }]}>{t("holdMic")}</Text>
            <View style={styles.walkieMic}>
              <PttButton
                talking={walkieTalking}
                onPressIn={() => void beginWalkie()}
                onPressOut={() => void endWalkie()}
              />
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
      <ViewOncePlayer
        visible={Boolean(onceItem)}
        uri={onceItem?.audioUrl || null}
        durationMs={onceItem?.durationMs || null}
        onClose={() => void closeOnce()}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  tabs: {
    gap: 8,
    marginBottom: 8,
  },
  tab: {
    flex: 1,
    minHeight: 38,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  tabOn: {
    borderColor: colors.amber,
    backgroundColor: colors.bgDeep,
  },
  tabText: { color: colors.muted, fontWeight: "700", fontSize: 14 },
  tabTextOn: { color: colors.amber },
  panels: { flex: 1, position: "relative" },
  panel: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  panelOff: {
    opacity: 0,
    zIndex: 0,
  },
  dockOff: {
    height: 0,
    overflow: "hidden",
    opacity: 0,
    borderTopWidth: 0,
    paddingTop: 0,
    paddingBottom: 0,
    margin: 0,
  },
  list: {
    gap: 10,
    paddingTop: 12,
    paddingBottom: 20,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  row: { width: "100%" },
  mineRow: { alignItems: "flex-end" },
  theirsRow: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "86%",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  mine: { backgroundColor: colors.bgDeep, borderWidth: 1, borderColor: colors.ring },
  theirs: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line },
  text: { color: colors.text, fontSize: 16, lineHeight: 22 },
  meta: { color: colors.muted, marginTop: 6, fontSize: 11 },
  empty: { color: colors.muted, textAlign: "center", marginTop: 40 },
  error: { color: colors.red, marginBottom: 6 },
  dockBleed: { marginTop: 4 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.22)",
    backgroundColor: colors.bg,
  },
  walkieDock: {
    alignItems: "center",
    justifyContent: "flex-end",
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.22)",
    backgroundColor: colors.bg,
  },
  walkieHint: { color: colors.muted, fontSize: 13, marginBottom: 6 },
  walkieMic: {
    transform: [{ scale: 0.82 }],
  },
  actionBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgDeep,
    borderWidth: 2,
    borderColor: colors.amber,
  },
  actionOff: { opacity: 0.45 },
  pill: {
    flex: 1,
    flexDirection: "row",
    minHeight: 48,
    maxHeight: 120,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "rgba(14,76,184,0.25)",
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 6,
  },
  pillIcon: {
    fontSize: 18,
    lineHeight: 22,
    opacity: 0.55,
    paddingBottom: 2,
  },
  pillIconOn: { opacity: 1 },
  emojiBtn: {
    minWidth: 28,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 112,
    color: colors.bgDeep,
    fontSize: 16,
    paddingHorizontal: 4,
    paddingVertical: Platform.OS === "ios" ? 11 : 8,
  },
});
