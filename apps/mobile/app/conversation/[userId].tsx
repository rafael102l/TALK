import { decodeReply, HistoryItem, MessageReceipt, TransmissionReadyPayload } from "@talk/shared";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  BackHandler,
  FlatList,
  InteractionManager,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChatHeader } from "../../src/components/ChatHeader";
import { ChatOverflowMenu } from "../../src/components/ChatOverflowMenu";
import { HighlightText } from "../../src/components/HighlightText";
import { MuteSheet, type MuteChoice } from "../../src/components/MuteSheet";
import { ChatWallpaper } from "../../src/components/ChatWallpaper";
import { EmojiPicker, EMOJIS } from "../../src/components/EmojiPicker";
import { ReactionBar } from "../../src/components/ReactionBar";
import { SelectionHeader } from "../../src/components/SelectionHeader";
import { QuoteBox } from "../../src/components/QuoteBox";
import { SwipeToReply } from "../../src/components/SwipeToReply";
import { BackChevronIcon, MicIcon, SendArrowIcon } from "../../src/components/MirsIcons";
import { RecordDock } from "../../src/components/RecordDock";
import { ViewOncePlayer } from "../../src/components/ViewOncePlayer";
import { ReceiptTicks } from "../../src/components/ReceiptTicks";
import { VoiceBubble } from "../../src/components/VoiceBubble";
import { useI18n } from "../../src/i18n";
import { api } from "../../src/lib/api";
import {
  cancelRecording,
  getRecordingMeter,
  pauseRecording,
  resumeRecording,
  prefetchAudio,
  primeConversationMic,
  releaseStandbyMic,
  startRecording,
  stopPlayback,
  stopRecording,
} from "../../src/lib/audio";
import { useAuth } from "../../src/lib/auth";
import { MAX_PTT_MS } from "../../src/lib/config";
import { fetchPresence, isCachedOnline, knownLastSeen, rememberLastSeen, subscribePresence } from "../../src/lib/presence";
import { loadReactions, setReaction } from "../../src/lib/reactions";
import {
  isHistoryFresh,
  onChatReceipt,
  peekHistoryCache,
  refreshHistory,
  seedHistoryCache,
  takePendingReceipt,
} from "../../src/lib/historyCache";
import { copyText, showCopied } from "../../src/lib/clipboard";
import { SOCKET_EVENTS, ensureSocket, getSocket } from "../../src/lib/socket";
import { useTargets } from "../../src/lib/targets";
import { colors } from "../../src/lib/theme";
import { ackDelivered, markPeerTextRead } from "../../src/lib/unread";
import { startOutgoing } from "../../src/lib/voiceCall";
import { MUTE_ALWAYS, getDisappearAfterSec, isPeerMuted, setPeerMuteUntil } from "../../src/lib/contactPrefs";
import { loadGroups, type TalkGroup } from "../../src/lib/groups";

function txIdOf(id: string) {
  return id.split(":")[0];
}

function receiptRank(receipt?: string | null) {
  if (receipt === "read") return 3;
  if (receipt === "delivered") return 2;
  if (receipt === "sent") return 1;
  return 0;
}

function mergeReceipt(a?: MessageReceipt | null, b?: MessageReceipt | null): MessageReceipt | undefined {
  if (!a) return b || undefined;
  if (!b) return a;
  return receiptRank(a) >= receiptRank(b) ? a : b;
}

function itemKind(item: HistoryItem): "walkie" | "voice" | "text" {
  if (item.kind === "text" || item.kind === "voice" || item.kind === "walkie") return item.kind;
  if (item.audioUrl || item.durationMs) return "walkie";
  return "text";
}

const MINE_BG = "#D9FDD3";
const THEIRS_BG = "#FFFFFF";
const CHAT_BG = "#E4D9EE";
const INK = "#111B21";

function dayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

type ChatRow = { key: string; type: "day"; label: string } | { key: string; type: "msg"; item: HistoryItem };

function hydrateItem(item: HistoryItem): HistoryItem {
  const packed = decodeReply(item.originalText || "");
  const translated = decodeReply(item.translatedText || "");
  return {
    ...item,
    originalText: packed.text || item.originalText,
    translatedText: translated.text || item.translatedText,
    replyToId: item.replyToId || packed.reply?.id || null,
    replyToName: item.replyToName || packed.reply?.name || null,
    replyToText: item.replyToText || packed.reply?.text || null,
  };
}

function sortMessages(rows: HistoryItem[]) {
  const uniq = new Map<string, HistoryItem>();
  for (const row of rows) uniq.set(row.id, hydrateItem(row));
  return [...uniq.values()].sort((a, b) => {
    const at = Date.parse(a.createdAt) || 0;
    const bt = Date.parse(b.createdAt) || 0;
    if (at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  });
}

export default function ConversationScreen() {
  const router = useRouter();
  const { userId: userIdParam, name, group } = useLocalSearchParams<{ userId: string; name?: string; group?: string }>();
  const userId = Array.isArray(userIdParam) ? userIdParam[0] || "" : userIdParam || "";
  const isGroup = group === "1";
  const { token, user } = useAuth();
  const { t, align, lang, rtl } = useI18n();
  const { contacts, snapshots } = useTargets();
  const [peerOnline, setPeerOnline] = useState(() => isCachedOnline(userId));
  const [peerTyping, setPeerTyping] = useState(false);
  const [peerLastSeen, setPeerLastSeen] = useState(0);
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [reactFor, setReactFor] = useState("");
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [reactSheet, setReactSheet] = useState(false);
  const [replyTo, setReplyTo] = useState<HistoryItem | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const typingOnRef = useRef(false);
  const typingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingEmitRef = useRef(0);
  const [items, setItems] = useState<HistoryItem[]>(() => peekHistoryCache());
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const hasDraft = draft.length > 0;
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const [onceItem, setOnceItem] = useState<HistoryItem | null>(null);
  const recordingRef = useRef(false);
  const onceRef = useRef<HistoryItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgScroll = useRef<FlatList<ChatRow>>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [muteOpen, setMuteOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [muted, setMuted] = useState(false);
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [groupInfo, setGroupInfo] = useState<TalkGroup | null>(null);
  const [disappearSec, setDisappearSec] = useState(0);

  const load = useCallback(
    (opts?: { immediate?: boolean }) => {
      if (!token) return;
      const cached = peekHistoryCache();
      if (cached.length) {
        const rows = sortMessages(cached);
        setItems(rows);
        for (const row of rows) if (row.audioUrl) void prefetchAudio(row.audioUrl);
      }
      // Fresh cache: paint instantly, skip blocking network on open.
      if (!opts?.immediate && isHistoryFresh(45_000)) return;
      const run = () => {
        void refreshHistory(token, { maxAgeMs: opts?.immediate ? 0 : 45_000 })
          .then((rows) => {
            const next = sortMessages(rows);
            setItems(next);
            setError("");
            for (const row of next) if (row.audioUrl) void prefetchAudio(row.audioUrl);
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
      if (cached.length) setItems(sortMessages(cached));
      load();
      void primeConversationMic();
      void isPeerMuted(userId).then(setMuted);
      void getDisappearAfterSec(userId).then(setDisappearSec);
      if (isGroup) {
        void loadGroups().then((list) => {
          const found = list.find((row) => row.id === userId);
          if (found) {
            setGroupMembers(found.memberIds);
            setGroupInfo(found);
          }
        });
      }
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
        void releaseStandbyMic();
      };
    }, [load, token, userId, isGroup]),
  );

  useEffect(() => {
    if (!token) return;
    const socket = ensureSocket(token);
    const onReady = (payload: TransmissionReadyPayload) => {
      const forThis = isGroup
        ? payload.channelId === userId
        : payload.senderId === userId || payload.senderId === user?.id;
      if (!forThis) return;
      if (!payload.transmissionId) return;
      const mine = payload.senderId === user?.id;
      if (!mine) ackDelivered(token, payload, user?.id);
      const kind = payload.kind || (payload.audioUrl ? "walkie" : "text");
      // Each device keeps the transcript in its own language:
      // sender → source text; recipient → translated listen-language text.
      const myText = mine
        ? payload.originalText || payload.translatedText || null
        : payload.translatedText || payload.originalText || null;
      const packed = decodeReply(myText || "");
      const row: HistoryItem = hydrateItem({
        id: mine ? `${payload.transmissionId}:${userId}` : payload.transmissionId,
        senderName: payload.senderName || "",
        senderId: payload.senderId,
        originalText: mine ? packed.text || myText : payload.originalText ?? null,
        translatedText: packed.text || myText,
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
        replyToId: payload.replyToId || packed.reply?.id || null,
        replyToName: payload.replyToName || packed.reply?.name || null,
        replyToText: payload.replyToText || packed.reply?.text || null,
        receipt: mine
          ? mergeReceipt(payload.receipt || "sent", takePendingReceipt(payload.transmissionId)) || "sent"
          : undefined,
        channelId: payload.channelId || (isGroup ? userId : null),
        expiresAt: payload.expiresAt || null,
      });
      if (row.audioUrl) void prefetchAudio(row.audioUrl);
      setItems((current) => {
        const existing = current.find(
          (item) => txIdOf(item.id) === payload.transmissionId || (item.id.startsWith("local-") && item.mine === mine && itemKind(item) === kind),
        );
        if (mine) row.receipt = mergeReceipt(existing?.receipt, row.receipt || "sent");
        const without = current.filter(
          (item) =>
            txIdOf(item.id) !== payload.transmissionId &&
            !(item.id.startsWith("local-") && item.mine === mine && itemKind(item) === kind),
        );
        const next = sortMessages([row, ...without]);
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
  }, [user?.id, user?.avatarUrl, userId, token, isGroup]);

  useEffect(() => {
    return onChatReceipt((transmissionId, receipt) => {
      setItems((current) => {
        let changed = false;
        const next = current.map((item) => {
          if (!item.mine) return item;
          const sameTx = txIdOf(item.id) === transmissionId;
          const sameLocal = item.id.startsWith("local-") && item.peerId === userId;
          if (!sameTx && !sameLocal) return item;
          const nextReceipt = mergeReceipt(item.receipt, receipt);
          if (nextReceipt === item.receipt) return item;
          changed = true;
          return { ...item, receipt: nextReceipt };
        });
        if (!changed) return current;
        seedHistoryCache(next);
        return next;
      });
    });
  }, [userId]);

  useEffect(() => {
    void loadReactions().then(setReactions);
  }, []);

  useEffect(() => {
    if (!token || !userId) return;
    let cancelled = false;
    setPeerLastSeen(knownLastSeen(userId));
    setPeerOnline(isCachedOnline(userId));
    const socket = ensureSocket(token);
    const refresh = () => {
      void fetchPresence(token, [userId])
        .then(({ online, lastSeen }) => {
          if (cancelled) return;
          setPeerOnline(online.has(userId));
          const at = lastSeen[userId] || knownLastSeen(userId);
          if (at) setPeerLastSeen(at);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubPresence = subscribePresence((payload) => {
      if (payload.userId !== userId) return;
      setPeerOnline(payload.online);
      if (payload.online) return;
      setPeerTyping(false);
      const at = Number(payload.lastSeen) || Date.now();
      setPeerLastSeen(at);
      void rememberLastSeen(userId, at);
    });
    const onTyping = (payload: { userId?: string; typing?: boolean }) => {
      if (String(payload.userId || "") !== userId) return;
      const typing = Boolean(payload.typing);
      setPeerTyping(typing);
      if (typing) setPeerOnline(true);
      if (typingClearRef.current) clearTimeout(typingClearRef.current);
      if (typing) {
        typingClearRef.current = setTimeout(() => setPeerTyping(false), 4000);
      }
    };
    const onReaction = (payload: { userId?: string; transmissionId?: string; emoji?: string }) => {
      if (String(payload.userId || "") !== userId || !payload.transmissionId) return;
      const tx = txIdOf(payload.transmissionId);
      const emoji = payload.emoji || "";
      setReactions((current) => {
        const next = { ...current };
        if (emoji) {
          next[tx] = emoji;
          next[payload.transmissionId] = emoji;
        } else {
          delete next[tx];
          delete next[payload.transmissionId];
        }
        return next;
      });
      void setReaction(tx, emoji || null);
    };
    socket.on(SOCKET_EVENTS.CHAT_TYPING, onTyping);
    socket.on(SOCKET_EVENTS.CHAT_REACTION, onReaction);
    socket.on("connect", refresh);
    const subApp = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      cancelled = true;
      unsubPresence();
      subApp.remove();
      if (typingStopRef.current) clearTimeout(typingStopRef.current);
      if (typingClearRef.current) clearTimeout(typingClearRef.current);
      if (typingOnRef.current) {
        typingOnRef.current = false;
        socket.emit(SOCKET_EVENTS.CHAT_TYPING, { targetUserId: userId, typing: false });
      }
      socket.off(SOCKET_EVENTS.CHAT_TYPING, onTyping);
      socket.off(SOCKET_EVENTS.CHAT_REACTION, onReaction);
      socket.off("connect", refresh);
    };
  }, [token, userId]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      void getRecordingMeter().then((meter) => setRecMs(meter.durationMs));
    }, 90);
    return () => clearInterval(id);
  }, [recording]);

  const peerItems = useMemo(() => {
    const now = Date.now();
    return sortMessages(
      items.filter((item) => {
        if (item.expiresAt && Date.parse(item.expiresAt) && Date.parse(item.expiresAt) < now) return false;
        if (isGroup) return item.channelId === userId || item.peerId === userId;
        return (item.peerId || (!item.mine && item.senderId)) === userId;
      }),
    );
  }, [items, userId, isGroup]);

  const messageThread = useMemo(() => {
    const rows = peerItems.filter((item) => itemKind(item) !== "walkie");
    return rows.length > 80 ? rows.slice(rows.length - 80) : rows;
  }, [peerItems]);

  const lastMessageId = messageThread[messageThread.length - 1]?.id ?? "";

  const stickBottom = useCallback(() => {
    requestAnimationFrame(() => {
      msgScroll.current?.scrollToEnd({ animated: false });
      setTimeout(() => msgScroll.current?.scrollToEnd({ animated: false }), 50);
    });
  }, []);

  useEffect(() => {
    stickBottom();
  }, [messageThread.length, lastMessageId, stickBottom]);

  const peer = useMemo(() => {
    const contact = contacts.find((row) => row.matchedUser?.id === userId);
    const matched = contact?.matchedUser;
    const snap = userId ? snapshots[userId] : undefined;
    const incoming = peerItems.find((item) => !item.mine);
    return {
      name: groupInfo?.name || name || matched?.displayName || snap?.name || incoming?.peerName || incoming?.senderName || t("messages"),
      avatarUrl: groupInfo?.avatarUrl || matched?.avatarUrl || snap?.photo || incoming?.peerAvatar || null,
      gender: matched?.voiceGender || snap?.gender || incoming?.peerGender || "male",
    };
  }, [contacts, snapshots, userId, name, peerItems, t, groupInfo]);

  function stopTyping() {
    if (typingStopRef.current) clearTimeout(typingStopRef.current);
    if (!typingOnRef.current || !userId) return;
    typingOnRef.current = false;
    lastTypingEmitRef.current = 0;
    const socket = token ? ensureSocket(token) : getSocket();
    socket?.emit(SOCKET_EVENTS.CHAT_TYPING, { targetUserId: userId, typing: false });
  }

  function pulseTyping(next: string) {
    if (!userId || !token) return;
    if (!next.trim()) {
      stopTyping();
      return;
    }
    const socket = ensureSocket(token);
    const now = Date.now();
    if (!typingOnRef.current || now - lastTypingEmitRef.current > 1000) {
      typingOnRef.current = true;
      lastTypingEmitRef.current = now;
      socket.emit(SOCKET_EVENTS.CHAT_TYPING, { targetUserId: userId, typing: true });
    }
    if (typingStopRef.current) clearTimeout(typingStopRef.current);
    typingStopRef.current = setTimeout(() => stopTyping(), 1500);
  }

  const selectedIds = Object.keys(selected);
  const selectedCount = selectedIds.length;
  const selecting = selectedCount > 0;

  useEffect(() => {
    if (!selecting && !searching) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selecting) {
        clearSelect();
        return true;
      }
      setSearching(false);
      setSearchQuery("");
      return true;
    });
    return () => sub.remove();
  }, [selecting, searching]);

  function clearSelect() {
    setSelected({});
    setReactFor("");
    setReactSheet(false);
  }

  function beginSelect(id: string) {
    if (selecting) {
      toggleSelect(id);
      return;
    }
    setSelected({ [id]: true });
    setReactFor(id);
  }

  function toggleSelect(id: string) {
    setSelected((current) => {
      const next = { ...current };
      if (next[id]) delete next[id];
      else next[id] = true;
      const keys = Object.keys(next);
      setReactFor(keys.length === 1 ? keys[0] : keys.length ? id : "");
      if (!keys.length) setReactSheet(false);
      return next;
    });
  }

  function applyReaction(id: string, emoji: string) {
    if (!id || !emoji) return;
    const tx = txIdOf(id);
    setReactions((current) => ({ ...current, [id]: emoji, [tx]: emoji }));
    clearSelect();
    void setReaction(tx, emoji);
    if (id !== tx) void setReaction(id, emoji);
    const socket = token ? ensureSocket(token) : getSocket();
    socket?.emit(SOCKET_EVENTS.CHAT_REACTION, {
      targetUserId: userId,
      transmissionId: tx,
      emoji,
    });
  }

  function selectedItems() {
    const ids = new Set(selectedIds.flatMap((id) => [id, txIdOf(id)]));
    return messageThread.filter((item) => ids.has(item.id) || ids.has(txIdOf(item.id)));
  }

  function replyToItem(item: HistoryItem) {
    setReplyTo(item);
    clearSelect();
  }

  function replySelected() {
    const rows = selectedItems();
    const item = rows[rows.length - 1] || messageThread.find((row) => row.id === reactFor);
    if (item) replyToItem(item);
    else clearSelect();
  }

  function dropLocal(ids: Set<string>) {
    setItems((current) => {
      const next = current.filter((item) => !ids.has(item.id) && !ids.has(txIdOf(item.id)));
      seedHistoryCache(next);
      return next;
    });
  }

  function deleteSelected() {
    setDeleteOpen(true);
  }

  function deleteForMe() {
    const ids = new Set(selectedIds.flatMap((id) => [id, txIdOf(id)]));
    dropLocal(ids);
    setDeleteOpen(false);
    clearSelect();
  }

  async function deleteForEveryone() {
    const rows = selectedItems().filter((item) => item.mine || item.senderId === user?.id);
    const ids = new Set(rows.flatMap((item) => [item.id, txIdOf(item.id)]));
    dropLocal(ids);
    setDeleteOpen(false);
    clearSelect();
    if (!token) return;
    for (const row of rows) {
      const id = txIdOf(row.id);
      if (!id || id.startsWith("local-")) continue;
      await api(`/transmissions/${id}/unsend`, { method: "POST", token }).catch(() => undefined);
    }
  }

  async function copySelected() {
    const texts = selectedItems()
      .map((item) => messageText(item, Boolean(item.mine || item.senderId === user?.id)).trim())
      .filter(Boolean);
    if (!texts.length) return;
    const ok = await copyText(texts.join("\n"));
    if (ok) showCopied(t("messageCopied"));
  }

  async function forwardSelected() {
    const texts = selectedItems()
      .map((item) => messageText(item, Boolean(item.mine || item.senderId === user?.id)).trim())
      .filter(Boolean);
    if (!texts.length) return;
    try {
      await Share.share({ message: texts.join("\n") });
    } catch {
      /* cancelled */
    }
  }

  function quotePreview(item: HistoryItem) {
    const owned = Boolean(item.mine || item.senderId === user?.id);
    const text =
      (owned ? item.originalText || item.translatedText : item.translatedText || item.originalText) || "";
    return {
      id: item.id,
      name: owned ? user?.displayName || "" : peer.name,
      text: text || (itemKind(item) === "voice" ? t("voiceClip") : ""),
    };
  }

  async function sendText() {
    const text = draft.trim();
    if (!text || !token || !userId || sending || recordingRef.current) return;
    const quoted = replyTo ? quotePreview(replyTo) : null;
    stopTyping();
    setSending(true);
    setError("");
    setDraft("");
    setEmojiOpen(false);
    setReplyTo(null);
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
      replyToId: quoted?.id || null,
      replyToName: quoted?.name || null,
      replyToText: quoted?.text || null,
      receipt: "sent",
      channelId: isGroup ? userId : null,
      expiresAt: disappearSec ? new Date(Date.now() + disappearSec * 1000).toISOString() : null,
    };
    setItems((current) => {
      const next = sortMessages([optimistic, ...current]);
      seedHistoryCache(next);
      return next;
    });
    try {
      const saved = await api<{ id?: string }>("/transmissions/text", {
        method: "POST",
        token,
        timeoutMs: 45000,
        body: JSON.stringify({
          originalText: text,
          targetUserIds: isGroup ? groupMembers.filter((id) => id !== user?.id) : [userId],
          channelId: isGroup ? userId : undefined,
          replyToId: quoted?.id,
          replyToName: quoted?.name,
          replyToText: quoted?.text,
        }),
      });
      if (saved?.id) {
        const pending = takePendingReceipt(saved.id);
        setItems((current) => {
          const next = current.map((item) =>
            item.id === optimistic.id
              ? { ...item, id: `${saved.id}:${userId}`, receipt: mergeReceipt(item.receipt || "sent", pending) || "sent" }
              : item,
          );
          seedHistoryCache(next);
          return next;
        });
      }
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
    if (recordingRef.current || sending || !userId) return;
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
    void primeConversationMic();
  }

  async function sendVoice(viewOnce: boolean) {
    if (!recordingRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    recordingRef.current = false;
    setRecording(false);
    setPaused(false);
    const quoted = replyTo ? quotePreview(replyTo) : null;
    setReplyTo(null);
    const recorded = await stopRecording();
    void primeConversationMic();
    if (!recorded?.uri || !token || !userId) return;
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
      replyToId: quoted?.id || null,
      replyToName: quoted?.name || null,
      replyToText: quoted?.text || null,
      receipt: "sent",
      channelId: isGroup ? userId : null,
      expiresAt: disappearSec ? new Date(Date.now() + disappearSec * 1000).toISOString() : null,
    };
    setItems((current) => {
      const next = sortMessages([optimistic, ...current]);
      seedHistoryCache(next);
      return next;
    });
    const form = new FormData();
    form.append("audio", {
      uri: recorded.uri,
      name: "voice.m4a",
      type: "audio/m4a",
    } as unknown as Blob);
    form.append("durationMs", String(recorded.durationMs ?? 0));
    form.append("targetUserIds", JSON.stringify(isGroup ? groupMembers.filter((id) => id !== user?.id) : [userId]));
    if (isGroup) form.append("channelId", userId);
    form.append("kind", "voice");
    form.append("viewOnce", viewOnce ? "true" : "false");
    if (quoted?.id) {
      form.append("replyToId", quoted.id);
      form.append("replyToName", quoted.name);
      form.append("replyToText", quoted.text);
    }
    try {
      const saved = await api<{ id?: string }>("/transmissions", { method: "POST", token, body: form, timeoutMs: 45000 });
      if (saved?.id) {
        const pending = takePendingReceipt(saved.id);
        setItems((current) => {
          const next = current.map((item) =>
            item.id === optimistic.id
              ? { ...item, id: `${saved.id}:${userId}`, receipt: mergeReceipt(item.receipt || "sent", pending) || "sent" }
              : item,
          );
          seedHistoryCache(next);
          return next;
        });
      }
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

  function messageText(item: HistoryItem, mine: boolean) {
    if (mine) return item.originalText || item.translatedText || "";
    return item.translatedText || item.originalText || "";
  }

  function dayLabel(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
    if (diff === 0) return t("today");
    if (diff === 1) return t("yesterday");
    return date.toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric" });
  }

  const chatRows = useMemo(() => {
    const rows: ChatRow[] = [];
    let lastDay = "";
    for (const item of messageThread) {
      const day = dayKey(item.createdAt);
      if (day && day !== lastDay) {
        lastDay = day;
        rows.push({ key: `day-${day}`, type: "day", label: dayLabel(item.createdAt) });
      }
      rows.push({ key: item.id, type: "msg", item });
    }
    return rows;
  }, [messageThread, lang, t]);

  function renderChatRow({ item: row }: { item: ChatRow }) {
    if (row.type === "day") {
      return (
        <View
          collapsable={false}
          style={{
            width: "100%",
            alignItems: "center",
            marginVertical: 4,
            paddingHorizontal: 12,
          }}
        >
          <Text style={styles.day}>{row.label}</Text>
        </View>
      );
    }
    const item = row.item;
    const mine = Boolean(item.mine || item.senderId === user?.id);
    const kind = itemKind(item);
    const time = item.createdAt
      ? new Date(item.createdAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })
      : "";
    const picking = Boolean(selected[item.id]);
    const reaction = reactions[item.id] || reactions[txIdOf(item.id)] || "";
    const quotedName = item.replyToName || "";
    const quotedText = item.replyToText || "";
    const onlyId = selectedCount === 1 ? selectedIds[0] : "";
    const bar =
      onlyId === item.id ? (
        <ReactionBar
          rtl={rtl}
          mine={mine}
          onPick={(emoji) => void applyReaction(item.id, emoji)}
          onMore={() => {
            setReactFor(item.id);
            setReactSheet(true);
          }}
        />
      ) : null;
    const node =
      kind === "voice" ? (
        <VoiceBubble
          uri={item.audioUrl}
          durationMs={item.durationMs}
          mine={mine}
          avatarUrl={mine ? user?.avatarUrl : item.peerAvatar}
          name={mine ? user?.displayName : item.senderName}
          gender={item.peerGender}
          locked={Boolean(item.viewOnce && !mine)}
          viewOnce={item.viewOnce}
          listenLang={item.language || user?.listenLang || lang}
          at={item.createdAt}
          caption={item.translatedText || item.originalText || ""}
          selected={picking}
          selecting={selecting}
          reaction={reaction}
          quoteName={quotedName}
          quoteText={quotedText}
          onLongPress={() => beginSelect(item.id)}
          onSelect={() => toggleSelect(item.id)}
          onOpenOnce={() => {
            onceRef.current = item;
            setOnceItem(item);
          }}
          receipt={mine ? item.receipt || "sent" : undefined}
        />
      ) : (
        <Pressable
          onPress={() => {
            if (selecting) toggleSelect(item.id);
          }}
          onLongPress={() => beginSelect(item.id)}
          delayLongPress={280}
        >
          <View style={[styles.bubble, mine ? styles.mine : styles.theirs, reaction ? styles.bubbleReact : null]}>
            {quotedName || quotedText ? <QuoteBox name={quotedName} text={quotedText} compact /> : null}
            {messageText(item, mine) ? (
              <HighlightText
                text={messageText(item, mine)}
                query={searchQuery}
                style={[styles.text, mine ? styles.mineText : styles.theirText]}
              />
            ) : null}
            {time || mine ? (
              <View style={styles.metaRow}>
                {time ? <Text style={[styles.meta, mine ? styles.mineMeta : styles.theirMeta]}>{time}</Text> : null}
                {mine ? <ReceiptTicks receipt={item.receipt || "sent"} /> : null}
              </View>
            ) : null}
            {reaction ? (
              <View style={[styles.reactionChip, mine ? styles.reactionMine : styles.reactionTheirs]}>
                <Text style={styles.reactionTxt}>{reaction}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      );
    return (
      <View
        collapsable={false}
        style={[
          {
            width: "100%",
            flexDirection: "row",
            justifyContent: mine ? "flex-end" : "flex-start",
            alignItems: mine ? "flex-end" : "flex-start",
            marginTop: 4,
            marginBottom: reaction ? 10 : 4,
            paddingHorizontal: 12,
          },
          picking ? styles.pickedRow : null,
        ]}
      >
        <View style={styles.itemStack}>
          {bar}
          <SwipeToReply rtl={rtl} disabled={selecting} onReply={() => replyToItem(item)}>
            {node}
          </SwipeToReply>
        </View>
      </View>
    );
  }

  async function addToPhonebook() {
    const contact = contacts.find((row) => row.matchedUser?.id === userId);
    const phone = contact?.matchedUser?.phoneE164 || contact?.phoneE164 || "";
    try {
      const Contacts = require("expo-contacts") as typeof import("expo-contacts");
      const perm = await Contacts.requestPermissionsAsync();
      if (!perm.granted) return;
      await Contacts.addContactAsync({
        name: peer.name,
        contactType: Contacts.ContactTypes.Person,
        phoneNumbers: phone ? [{ label: "mobile", number: phone }] : [],
      });
      Alert.alert(t("contactAdded"));
    } catch {
      Alert.alert(t("addToContacts"), phone || peer.name);
    }
  }

  async function applyMute(choice: MuteChoice) {
    const until =
      choice === "always" ? MUTE_ALWAYS : choice === "week" ? Date.now() + 7 * 86400000 : Date.now() + 8 * 3600000;
    await setPeerMuteUntil(userId, until);
    setMuted(true);
  }

  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "padding"}
        keyboardVerticalOffset={8}
      >
        {searching ? (
          <View style={[styles.searchBar, { flexDirection: rtl ? "row-reverse" : "row" }]}>
            <Pressable
              onPress={() => {
                setSearching(false);
                setSearchQuery("");
              }}
              style={styles.searchIcon}
            >
              <BackChevronIcon size={20} color="#111B21" rtl={false} />
            </Pressable>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t("searchInChat")}
              placeholderTextColor="rgba(17,27,33,0.45)"
              autoFocus
              style={[styles.searchInput, { textAlign: align }]}
            />
          </View>
        ) : selectedCount ? (
          <SelectionHeader
            count={selectedCount}
            onClose={clearSelect}
            onReply={replySelected}
            onDelete={deleteSelected}
            onCopy={() => void copySelected()}
            onForward={() => void forwardSelected()}
            onMore={() => Alert.alert("", "", [{ text: t("cancel") }])}
          />
        ) : (
        <ChatHeader
          name={peer.name}
          avatarUrl={peer.avatarUrl}
          gender={peer.gender}
          online={peerOnline}
          typing={peerTyping}
          lastSeen={peerLastSeen}
          onOpenProfile={() => {
            if (!userId || isGroup) return;
            const contact = contacts.find((row) => row.matchedUser?.id === userId);
            router.push({
              pathname: "/contact/[userId]",
              params: {
                userId,
                name: peer.name,
                avatarUrl: peer.avatarUrl || "",
                phone: contact?.matchedUser?.phoneE164 || contact?.phoneE164 || "",
                gender: peer.gender,
              },
            });
          }}
          onMenu={() => setMenuOpen(true)}
          onVideo={
            isGroup
              ? undefined
              : () => {
                  if (!userId) return;
                  startOutgoing({
                    userId,
                    name: peer.name,
                    avatarUrl: peer.avatarUrl,
                    gender: peer.gender,
                    video: true,
                  });
                }
          }
          onCall={
            isGroup
              ? undefined
              : () => {
                  if (!userId) return;
                  startOutgoing({
                    userId,
                    name: peer.name,
                    avatarUrl: peer.avatarUrl,
                    gender: peer.gender,
                  });
                }
          }
        />
        )}
        <View style={styles.body}>
          {error ? <Text style={[styles.error, { textAlign: align }]}>{error}</Text> : null}
          <View style={styles.chatStage}>
            <ChatWallpaper />
            <FlatList
              ref={msgScroll}
              style={styles.flex}
              data={chatRows}
              extraData={`${selectedCount}:${selecting}:${searchQuery}:${peerItems.map((item) => item.receipt || "").join()}:${Object.keys(selected).join()}:${Object.values(reactions).join()}`}
              keyExtractor={(row) => row.key}
              renderItem={renderChatRow}
              contentContainerStyle={styles.list}
              keyboardShouldPersistTaps="handled"
              windowSize={12}
              initialNumToRender={24}
              onContentSizeChange={() => stickBottom()}
              ListEmptyComponent={<Text style={styles.empty}>{t("noMessagesYet")}</Text>}
            />
          </View>
        </View>
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
            <View>
              {replyTo ? (
                <View style={styles.replyBar}>
                  <QuoteBox
                    name={quotePreview(replyTo).name}
                    text={quotePreview(replyTo).text}
                    onClose={() => setReplyTo(null)}
                  />
                </View>
              ) : null}
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
                    pulseTyping(value);
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
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
      <ViewOncePlayer
        visible={Boolean(onceItem)}
        uri={onceItem?.audioUrl || null}
        durationMs={onceItem?.durationMs || null}
        onClose={() => void closeOnce()}
      />
      <Modal visible={deleteOpen} transparent animationType="fade" onRequestClose={() => setDeleteOpen(false)}>
        <Pressable style={styles.deleteOverlay} onPress={() => setDeleteOpen(false)}>
          <Pressable style={styles.deleteCard} onPress={() => undefined}>
            <Text style={[styles.deleteTitle, { textAlign: rtl ? "right" : "left" }]}>
              {selectedCount > 1 ? t("deleteMessagesTitle") : t("deleteMessageTitle")}
            </Text>
            {selectedItems().every((item) => item.mine || item.senderId === user?.id) ? (
              <Pressable onPress={() => void deleteForEveryone()} style={styles.deleteRow}>
                <Text style={[styles.deleteDanger, { textAlign: rtl ? "right" : "left" }]}>{t("deleteForEveryone")}</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={deleteForMe} style={styles.deleteRow}>
              <Text style={[styles.deleteDanger, { textAlign: rtl ? "right" : "left" }]}>{t("deleteForMe")}</Text>
            </Pressable>
            <Pressable onPress={() => setDeleteOpen(false)} style={styles.deleteRow}>
              <Text style={[styles.deleteCancel, { textAlign: rtl ? "right" : "left" }]}>{t("cancel")}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal
        visible={reactSheet}
        transparent
        animationType="fade"
        onRequestClose={() => setReactSheet(false)}
      >
        <Pressable style={styles.reactOverlay} onPress={() => setReactSheet(false)}>
          <Pressable style={styles.reactSheet} onPress={() => undefined}>
            <ScrollView contentContainerStyle={styles.reactGrid}>
              {EMOJIS.map((emoji) => (
                <Pressable
                  key={emoji}
                  onPress={() => {
                    void applyReaction(reactFor || selectedIds[0], emoji);
                    setReactSheet(false);
                  }}
                  style={styles.reactCell}
                >
                  <Text style={styles.reactFace}>{emoji}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
      <ChatOverflowMenu
        open={menuOpen}
        muted={muted}
        isGroup={isGroup}
        onClose={() => setMenuOpen(false)}
        onAddContact={() => void addToPhonebook()}
        onSearch={() => setSearching(true)}
        onMute={() => {
          if (muted) {
            void setPeerMuteUntil(userId, 0);
            setMuted(false);
            return;
          }
          setMuteOpen(true);
        }}
        onDisappear={() =>
          router.push({
            pathname: "/disappear/[userId]",
            params: { userId, channelId: isGroup ? userId : "", name: peer.name },
          })
        }
        onNewGroup={() =>
          router.push({
            pathname: "/group/new",
            params: { seed: isGroup ? "" : userId },
          })
        }
      />
      <MuteSheet
        open={muteOpen}
        onClose={() => setMuteOpen(false)}
        onPick={(choice) => void applyMute(choice)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#FFFFFF" },
  flex: { flex: 1 },
  searchBar: {
    height: 48,
    alignItems: "center",
    paddingHorizontal: 4,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(17,27,33,0.08)",
    gap: 4,
  },
  searchIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  searchInput: { flex: 1, color: "#111B21", fontSize: 16, paddingVertical: 8 },
  body: { flex: 1, paddingTop: 4, backgroundColor: CHAT_BG },
  chatStage: { flex: 1, overflow: "hidden" },
  list: {
    paddingVertical: 10,
  },
  itemStack: {
    maxWidth: "75%",
    flexShrink: 1,
  },
  day: {
    backgroundColor: "rgba(255,255,255,0.78)",
    color: "rgba(17,27,33,0.62)",
    fontSize: 12,
    fontWeight: "700",
    overflow: "hidden",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  bubble: {
    position: "relative",
    overflow: "visible",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  bubbleReact: { paddingBottom: 6 },
  mine: { backgroundColor: MINE_BG, borderTopRightRadius: 4 },
  pickedRow: {
    backgroundColor: "rgba(17,27,33,0.08)",
    borderRadius: 8,
  },
  pickedBubble: { backgroundColor: "rgba(30,120,240,0.16)" },
  reactionChip: {
    position: "absolute",
    bottom: -8,
    zIndex: 10,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    paddingHorizontal: 5,
    paddingVertical: 1,
    elevation: 3,
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(17,27,33,0.12)",
  },
  reactionMine: { left: 10 },
  reactionTheirs: { right: 10 },
  reactionTxt: { fontSize: 14 },
  replyBar: {
    backgroundColor: "#EFEAF6",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 2,
  },
  reactOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  reactSheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "55%",
    paddingBottom: 16,
  },
  reactGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  reactCell: {
    width: "12.5%",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  reactFace: { fontSize: 26 },
  deleteOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  deleteCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    paddingTop: 18,
    paddingBottom: 8,
    paddingHorizontal: 4,
  },
  deleteTitle: {
    color: INK,
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: 18,
    paddingBottom: 10,
    textAlign: "left",
  },
  deleteRow: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  deleteDanger: { color: "#E53935", fontSize: 16, fontWeight: "600" },
  deleteCancel: { color: "#00A884", fontSize: 16, fontWeight: "700" },
  theirs: {
    backgroundColor: THEIRS_BG,
    borderTopLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(17,27,33,0.08)",
  },
  text: { fontSize: 16, lineHeight: 22, flexShrink: 1 },
  mineText: { color: INK },
  theirText: { color: INK },
  metaRow: { marginTop: 4, flexDirection: "row", alignItems: "center", alignSelf: "flex-end" },
  meta: { fontSize: 11, fontWeight: "600" },
  mineMeta: { color: "rgba(17,27,33,0.42)" },
  theirMeta: { color: "rgba(17,27,33,0.38)" },
  empty: { color: "rgba(17,27,33,0.45)", textAlign: "center", marginTop: 40 },
  error: { color: colors.red, marginBottom: 6 },
  dockBleed: { marginTop: 4 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(92,78,114,0.12)",
    backgroundColor: "#EFEAF6",
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
