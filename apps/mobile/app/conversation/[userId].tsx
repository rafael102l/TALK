import { decodeReply, HistoryItem, MessageReceipt, PublicUser, TransmissionReadyPayload } from "@talk/shared";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import {
  Alert,
  Animated,
  AppState,
  BackHandler,
  FlatList,
  InteractionManager,
  Keyboard,
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
  type GestureResponderEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ChatHeader } from "../../src/components/ChatHeader";
import { ChatOverflowMenu } from "../../src/components/ChatOverflowMenu";
import { ChatCamera } from "../../src/components/ChatCamera";
import { ContactShareCard } from "../../src/components/ContactShareCard";
import { VideoNoteBubble } from "../../src/components/VideoNoteBubble";
import { LocationPickSheet } from "../../src/components/LocationPickSheet";
import { PeoplePickSheet, type PickedPerson } from "../../src/components/PeoplePickSheet";
import { PinMenu } from "../../src/components/PinMenu";
import { PlaceShareCard } from "../../src/components/PlaceShareCard";
import { HighlightText } from "../../src/components/HighlightText";
import { MuteSheet, type MuteChoice } from "../../src/components/MuteSheet";
import { ChatWallpaper } from "../../src/components/ChatWallpaper";
import { EmojiPicker, EMOJIS } from "../../src/components/EmojiPicker";
import { ReactionBar, ReactionChip } from "../../src/components/ReactionBar";
import { SelectionHeader } from "../../src/components/SelectionHeader";
import { QuoteBox } from "../../src/components/QuoteBox";
import { SwipeToReply } from "../../src/components/SwipeToReply";
import { BackChevronIcon, MicIcon, SendArrowIcon } from "../../src/components/MirsIcons";
import { CapturePreview } from "../../src/components/CapturePreview";
import { MediaBubble } from "../../src/components/MediaBubble";
import { MediaViewer } from "../../src/components/MediaViewer";
import { VoiceHoldBar, VoiceLockBar } from "../../src/components/VoiceRecordBar";
import { ViewOncePlayer } from "../../src/components/ViewOncePlayer";
import { ReceiptTicks } from "../../src/components/ReceiptTicks";
import { VoiceBubble } from "../../src/components/VoiceBubble";
import { useI18n } from "../../src/i18n";
import { api } from "../../src/lib/api";
import {
  cacheIncomingWalkie,
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
  hydrateHistoryCache,
  isHistoryFresh,
  isVoiceDubbed,
  markVoiceDubbed,
  mergeLocalIntoCache,
  onChatReceipt,
  onHistoryCacheChange,
  peekHistoryCache,
  receiptAfterSend,
  receiptFromEcho,
  refreshHistory,
  removeFromHistory,
  seedHistoryCache,
  takePendingReceipt,
} from "../../src/lib/historyCache";
import { enqueueFileSend, enqueueTextSend, flushOutbox, isShadowDbEnabled, loadLocalMessages, onOutboxKept, onOutboxSent, searchLocalMessages, shadowUpsertNow } from "../../src/lib/localFirst";
import { cacheChatMedia, keepLocalCapture } from "../../src/lib/mediaCache";
import { copyText, showCopied } from "../../src/lib/clipboard";
import { SOCKET_EVENTS, ensureSocket, getSocket } from "../../src/lib/socket";
import { useTargets } from "../../src/lib/targets";
import { colors } from "../../src/lib/theme";
import { ackDelivered, markPeerTextRead } from "../../src/lib/unread";
import { formatTime24 } from "../../src/lib/time24";
import { clearPeerTyping, isPeerTyping, subscribeTyping } from "../../src/lib/typing";
import { setActiveChat } from "../../src/lib/activeChat";
import { encodeVideoNoteCaption, isVideoNote, videoNoteCaption, type ChatCapture } from "../../src/lib/capture";
import { encodeSharedContact, parseSharedContact } from "../../src/lib/contactShare";
import { requestLocationAccess } from "../../src/lib/geo";
import { startLiveShare, stopLiveShare } from "../../src/lib/liveLocation";
import { encodePlaceShare, parsePlaceShare } from "../../src/lib/placeShare";
import { startGroupOutgoing, startOutgoing } from "../../src/lib/voiceCall";
import { MUTE_ALWAYS, getDisappearAfterSec, isPeerMuted, setPeerMuteUntil } from "../../src/lib/contactPrefs";
import { loadGroups, onGroups, type TalkGroup } from "../../src/lib/groups";
import { cachedDeviceBook, loadDeviceBook } from "../../src/lib/deviceBook";
import { findDeviceContact, peerTitle, talkNickname } from "../../src/lib/personLabel";
import type { DeviceContact } from "../../src/lib/contacts";

const MIN_VOICE_MS = 800;
const CANCEL_DX = 28;
const LOCK_DY = 72;

function txIdOf(id: string) {
  return typeof id === "string" && id ? id.split(":")[0] : "";
}

function receiptRank(receipt?: string | null) {
  if (receipt === "read") return 3;
  if (receipt === "delivered") return 2;
  if (receipt === "sent") return 1;
  if (receipt === "pending") return 0;
  return 0;
}

function isNoRecipientError(error: unknown) {
  return /לא נבחרו נמענים/.test(error instanceof Error ? error.message : String(error));
}

function displayReceipt(item: HistoryItem): MessageReceipt {
  if (item.receipt === "pending" || item.receipt === "sent" || item.receipt === "delivered" || item.receipt === "read") {
    return item.receipt;
  }
  return typeof item.id === "string" && item.id.startsWith("local-") ? "pending" : "sent";
}

function mergeReceipt(a?: MessageReceipt | null, b?: MessageReceipt | null): MessageReceipt | undefined {
  if (!a) return b || undefined;
  if (!b) return a;
  return receiptRank(a) >= receiptRank(b) ? a : b;
}

function itemKind(item: HistoryItem): "walkie" | "voice" | "text" | "image" | "video" {
  if (!item) return "text";
  if (item.kind === "text" || item.kind === "voice" || item.kind === "walkie" || item.kind === "image" || item.kind === "video") {
    return item.kind;
  }
  if (item.audioUrl || item.durationMs) return "walkie";
  return "text";
}

function keepChatMedia(item: HistoryItem) {
  const kind = itemKind(item);
  if (!item.audioUrl || item.viewOnce) return;
  if (kind === "image" || kind === "video") void cacheChatMedia(item.audioUrl, { album: false });
}

const MINE_BG = "#D9FDD3";
const THEIRS_BG = "#FFFFFF";
const CHAT_BG = "#E4D9EE";
const INK = "#111B21";
const INPUT_MIN = 44;
const INPUT_MAX = 240;

function ComposerInput({
  inputRef,
  draftRef,
  external,
  rtl,
  placeholder,
  onChangeText,
  onFocus,
}: {
  inputRef: RefObject<TextInput | null>;
  draftRef: MutableRefObject<string>;
  external: string;
  rtl: boolean;
  placeholder: string;
  onChangeText: (value: string) => void;
  onFocus: () => void;
}) {
  const [local, setLocal] = useState(external);
  const [height, setHeight] = useState(INPUT_MIN);
  const self = useRef(false);
  useEffect(() => {
    if (self.current) {
      self.current = false;
      return;
    }
    draftRef.current = external;
    setLocal(external);
    if (!external) setHeight(INPUT_MIN);
  }, [draftRef, external]);
  return (
    <View style={[styles.inputWrap, { height }]}>
      {!local ? (
        <Text
          pointerEvents="none"
          style={[styles.fakePlaceholder, rtl ? styles.fakePlaceholderRtl : styles.fakePlaceholderLtr]}
        >
          {placeholder}
        </Text>
      ) : null}
      <TextInput
        ref={inputRef}
        style={[
          styles.input,
          {
            height,
            textAlign: rtl ? "right" : "left",
            textAlignVertical: height > INPUT_MIN ? "top" : "center",
          },
        ]}
        value={local}
        onChangeText={(value) => {
          self.current = true;
          draftRef.current = value;
          setLocal(value);
          if (!value) setHeight(INPUT_MIN);
          onChangeText(value);
        }}
        onContentSizeChange={(event) => {
          const next = Math.min(INPUT_MAX, Math.max(INPUT_MIN, Math.ceil(event.nativeEvent.contentSize.height)));
          setHeight((prev) => (Math.abs(prev - next) < 2 ? prev : next));
        }}
        onFocus={onFocus}
        placeholder=""
        multiline
        scrollEnabled={height >= INPUT_MAX}
        underlineColorAndroid="transparent"
      />
    </View>
  );
}

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
  if (!item) return item;
  try {
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
  } catch {
    return item;
  }
}

function sortMessages(rows: HistoryItem[]) {
  const uniq = new Map<string, HistoryItem>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || row.id == null) continue;
      const key = String(row.id);
      try {
        uniq.set(key, hydrateItem(row));
      } catch {
        // A single malformed row must not break the whole thread.
        uniq.set(key, row);
      }
    }
  }
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
  const { contacts, snapshots, selectMany } = useTargets();
  const [peerOnline, setPeerOnline] = useState(() => isCachedOnline(userId));
  const [peerTyping, setPeerTyping] = useState(false);
  const [peerLastSeen, setPeerLastSeen] = useState(0);
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [reactFor, setReactFor] = useState("");
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [reactSheet, setReactSheet] = useState(false);
  const [replyTo, setReplyTo] = useState<HistoryItem | null>(null);
  const [editing, setEditing] = useState<{ id: string; tx: string } | null>(null);
  const [capture, setCapture] = useState<ChatCapture | null>(null);
  const inputRef = useRef<TextInput>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const typingOnRef = useRef(false);
  const typingHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTypingEmitRef = useRef(0);
  const [items, setItems] = useState<HistoryItem[]>(() => peekHistoryCache());
  const [book, setBook] = useState<DeviceContact[]>(() => cachedDeviceBook());
  const [profile, setProfile] = useState<PublicUser | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [failedIds, setFailedIds] = useState<Record<string, { text: string; quoted: ReturnType<typeof quotePreview> | null }>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const hasDraft = draft.length > 0 || Boolean(editing);
  const camSlide = useRef(new Animated.Value(1)).current;
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const [voiceLocked, setVoiceLocked] = useState(false);
  const [recCancel, setRecCancel] = useState(false);
  const [holdUi, setHoldUi] = useState(false);
  const [onceItem, setOnceItem] = useState<HistoryItem | null>(null);
  const recordingRef = useRef(false);
  const voiceLockedRef = useRef(false);
  const recCancelRef = useRef(false);
  const recStartX = useRef(0);
  const recStartY = useRef(0);
  const recDx = useRef(0);
  const recDy = useRef(0);
  const recStartedAt = useRef(0);
  const beginWait = useRef(Promise.resolve());
  const recBusyRef = useRef(false);
  const onceRef = useRef<HistoryItem | null>(null);
  const selectLockAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgScroll = useRef<FlatList<ChatRow>>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [muteOpen, setMuteOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<HistoryItem[] | null>(null);
  const [muted, setMuted] = useState(false);
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [groupInfo, setGroupInfo] = useState<TalkGroup | null>(null);
  const [disappearSec, setDisappearSec] = useState(0);
  const [pinOpen, setPinOpen] = useState(false);
  const [locationPick, setLocationPick] = useState(false);
  const [contactPick, setContactPick] = useState(false);
  const [camOpen, setCamOpen] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const nearBottomRef = useRef(true);

  const load = useCallback(
    (opts?: { immediate?: boolean }) => {
      if (!token) return;
      const paint = (rows: HistoryItem[]) => {
        const next = sortMessages(rows);
        setItems(next);
        setError("");
        for (const row of next) {
          keepChatMedia(row);
          if (row.audioUrl && itemKind(row) !== "image" && itemKind(row) !== "video") void prefetchAudio(row.audioUrl);
        }
      };
      const cached = peekHistoryCache();
      if (cached.length) paint(cached);
      if (isShadowDbEnabled()) {
        void loadLocalMessages().then((local) => {
          if (!local.length) return;
          paint(mergeLocalIntoCache(local));
        });
      }
      // Fresh cache: paint instantly. Network is backfill only — never a load gate.
      if (!opts?.immediate && isHistoryFresh(45_000) && cached.length) return;
      const run = () => {
        void refreshHistory(token, { maxAgeMs: opts?.immediate ? 0 : 45_000 })
          .then((rows) => paint(isShadowDbEnabled() ? peekHistoryCache() : rows))
          .catch(() => {
            const fallback = peekHistoryCache();
            if (fallback.length) paint(fallback);
          });
      };
      if (opts?.immediate) run();
      else InteractionManager.runAfterInteractions(run);
    },
    [token],
  );

  useFocusEffect(
    useCallback(() => {
      setActiveChat(userId || null);
      void hydrateHistoryCache().then((disk) => {
        const cached = disk.length ? disk : peekHistoryCache();
        if (cached.length) setItems(sortMessages(cached));
      });
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
        setActiveChat(null);
        cancelled = true;
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        void stopPlayback();
        if (onceRef.current && onceRef.current.viewOnce && !onceRef.current.mine && token) {
          const id = txIdOf(onceRef.current.id);
          void api(`/transmissions/${id}/once-close`, { method: "POST", token }).catch(() => undefined);
          onceRef.current = null;
        }
        if (recordingRef.current) {
          recordingRef.current = false;
          voiceLockedRef.current = false;
          recCancelRef.current = false;
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
      try {
        const mine = payload.senderId === user?.id;
        if (!mine) ackDelivered(token, payload, user?.id);
        const kind = payload.kind || (payload.audioUrl ? "walkie" : "text");
        // Voice: never paint captions without playable audio (wait for synced TTS+text).
        const voiceCaptionBlocked =
          kind === "voice" && Boolean(payload.translatedText || payload.originalText) && !payload.audioUrl;
        // Each device keeps the transcript in its own language:
        // sender → source text; recipient → translated listen-language text.
        const myText = voiceCaptionBlocked
          ? null
          : mine
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
            ? mergeReceipt(receiptFromEcho(payload.receipt), takePendingReceipt(payload.transmissionId)) || "sent"
            : undefined,
          channelId: payload.channelId || (isGroup ? userId : null),
          expiresAt: payload.expiresAt || null,
        });
        keepChatMedia(row);
        if (kind === "voice" && row.audioUrl) {
          void cacheIncomingWalkie({
            transmissionId: payload.transmissionId,
            audioUrl: row.audioUrl,
            usedOriginalVoice: payload.usedOriginalVoice !== false,
          }).then((local) => {
            if (!local) return;
            setItems((current) => {
              const next = current.map((item) =>
                txIdOf(item.id) === payload.transmissionId ? { ...item, audioUrl: local } : item,
              );
              seedHistoryCache(next);
              return next;
            });
          });
        } else if (row.audioUrl && kind !== "image" && kind !== "video") {
          void prefetchAudio(row.audioUrl);
        }
        setItems((current) => {
          const echoBody = (row.originalText || row.translatedText || "").replace(/\s+/g, " ").trim();
          const isLocalEcho = (item: HistoryItem) => {
            if (typeof item.id !== "string" || !item.id.startsWith("local-") || item.mine !== mine || itemKind(item) !== kind) {
              return false;
            }
            const localBody = (item.originalText || item.translatedText || "").replace(/\s+/g, " ").trim();
            if (kind === "text" && localBody && echoBody && localBody !== echoBody) return false;
            return true;
          };
          const sameTx = (item: HistoryItem) => txIdOf(item.id) === payload.transmissionId || isLocalEcho(item);
          const existing = current.find(sameTx);
          // One voice transmission = one bubble. After dubbed TTS lands, ignore late original retries.
          if (kind === "voice" && payload.usedOriginalVoice && isVoiceDubbed(payload.transmissionId)) {
            return current;
          }
          if (kind === "voice" && payload.usedOriginalVoice === false && payload.audioUrl) {
            markVoiceDubbed(payload.transmissionId);
          }
          if (mine) row.receipt = mergeReceipt(existing?.receipt, row.receipt || "sent");
          if (existing) {
            row.createdAt = existing.createdAt || row.createdAt;
            // Sender keeps the local recording file; caption updates must not wipe it.
            if (kind === "voice" && mine && existing.audioUrl?.startsWith("file:")) {
              row.audioUrl = existing.audioUrl;
            } else if (kind === "voice" && payload.usedOriginalVoice && existing.audioUrl && !row.audioUrl) {
              row.audioUrl = existing.audioUrl;
            }
            // Keep captions only when this payload carries them (synced with audio).
            if (kind === "voice" && !row.translatedText && !row.originalText) {
              row.translatedText = existing.translatedText ?? null;
              row.originalText = existing.originalText ?? null;
            }
          }
          const without = current.filter((item) => !sameTx(item));
          const next = sortMessages([row, ...without]);
          seedHistoryCache(next);
          if (isShadowDbEnabled()) shadowUpsertNow([row]);
          return next;
        });
        if (token && (kind === "text" || kind === "voice") && payload.senderId === userId) {
          void markPeerTextRead(token, userId).catch(() => undefined);
        }
      } catch {
        /* ignore a malformed realtime payload instead of crashing the screen */
      }
    };
    const onRemoved = (payload: { transmissionId?: string; opened?: boolean }) => {
      const id = payload.transmissionId;
      if (!id) return;
      try {
        removeFromHistory(id, { opened: payload.opened });
        setItems(sortMessages(peekHistoryCache()));
        if (onceRef.current && txIdOf(onceRef.current.id) === id) {
          onceRef.current = null;
          setOnceItem(null);
        }
      } catch {
        /* ignore a malformed removal payload */
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
    void loadDeviceBook().then(setBook);
    if (!token || !userId || isGroup) {
      setProfile(null);
      return;
    }
    void api<PublicUser>(`/users/${userId}`, { token, timeoutMs: 8000, once: true })
      .then(setProfile)
      .catch(() => undefined);
  }, [token, userId, isGroup]);

  useEffect(() => {
    if (!isGroup || !userId) return;
    return onGroups(() => {
      void loadGroups().then((list) => {
        const found = list.find((row) => row.id === userId);
        if (found) {
          setGroupMembers(found.memberIds);
          setGroupInfo(found);
        }
      });
    });
  }, [isGroup, userId]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !userId || isGroup) return;
    const onUser = (payload?: { user?: PublicUser }) => {
      if (payload?.user?.id !== userId) return;
      setProfile((current) => {
        const next = payload.user;
        if (!next) return current;
        if (next.avatarHidden || current?.avatarHidden) {
          return { ...next, avatarUrl: null, avatarHidden: true };
        }
        return next;
      });
    };
    socket.on(SOCKET_EVENTS.USER_UPDATED, onUser);
    return () => {
      socket.off(SOCKET_EVENTS.USER_UPDATED, onUser);
    };
  }, [userId, isGroup]);

  useEffect(() => {
    const markSent = (localId: string, serverId?: string) => {
      setItems((current) => {
        let changed = false;
        const next = current.map((item) => {
          if (item.id !== localId && !(typeof item.id === "string" && item.id.startsWith(`${localId}:`))) return item;
          changed = true;
          return {
            ...item,
            id: serverId ? `${serverId}:${userId}` : item.id,
            receipt: receiptAfterSend(item.receipt, serverId),
          };
        });
        if (!changed) return current;
        seedHistoryCache(next);
        return next;
      });
    };
    const offSent = onOutboxSent((localId, serverId) => markSent(localId, serverId));
    const offKept = onOutboxKept((localId) => markSent(localId));
    return () => {
      offSent();
      offKept();
    };
  }, [userId]);

  useEffect(() => {
    return onHistoryCacheChange((rows) => {
      setItems((current) => {
        let changed = false;
        const next = current.map((item) => {
          if (!item.mine) return item;
          const tx = txIdOf(item.id);
          const fresh = rows.find(
            (row) => row.mine && (row.id === item.id || txIdOf(row.id) === tx || (tx && row.id.startsWith(`${tx}:`))),
          );
          if (!fresh?.receipt) return item;
          const merged = mergeReceipt(item.receipt, fresh.receipt);
          if (merged === item.receipt) return item;
          changed = true;
          return { ...item, receipt: merged };
        });
        return changed ? next : current;
      });
    });
  }, []);

  useEffect(() => {
    return onChatReceipt((transmissionId, receipt) => {
      setItems((current) => {
        let changed = false;
        const next = current.map((item) => {
          if (!item.mine) return item;
          if (txIdOf(item.id) !== transmissionId && item.id !== transmissionId) return item;
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
      clearPeerTyping(userId);
      setPeerTyping(false);
      const at = Number(payload.lastSeen) || Date.now();
      setPeerLastSeen(at);
      void rememberLastSeen(userId, at);
    });
    const syncTyping = () => {
      const typing = isPeerTyping(userId);
      setPeerTyping(typing);
      if (typing) setPeerOnline(true);
    };
    syncTyping();
    const unsubTyping = subscribeTyping(syncTyping);
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
    const onEdit = (payload: { userId?: string; transmissionId?: string; text?: string }) => {
      if (String(payload.userId || "") !== userId || !payload.transmissionId) return;
      const tx = txIdOf(payload.transmissionId);
      const text = String(payload.text || "");
      setItems((current) => {
        let changed = false;
        const next = current.map((item) => {
          if (item.id === payload.transmissionId || txIdOf(item.id) === tx) {
            changed = true;
            return { ...item, originalText: text, translatedText: text, edited: true };
          }
          return item;
        });
        if (changed) seedHistoryCache(next);
        return changed ? next : current;
      });
    };
    socket.on(SOCKET_EVENTS.CHAT_REACTION, onReaction);
    socket.on(SOCKET_EVENTS.CHAT_EDIT, onEdit);
    socket.on("connect", refresh);
    const subApp = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
      else void stopPlayback();
    });
    return () => {
      cancelled = true;
      unsubPresence();
      unsubTyping();
      subApp.remove();
      if (typingHeartbeatRef.current) {
        clearInterval(typingHeartbeatRef.current);
        typingHeartbeatRef.current = null;
      }
      if (typingOnRef.current) {
        typingOnRef.current = false;
        socket.emit(SOCKET_EVENTS.CHAT_TYPING, { targetUserId: userId, typing: false });
      }
      socket.off(SOCKET_EVENTS.CHAT_REACTION, onReaction);
      socket.off(SOCKET_EVENTS.CHAT_EDIT, onEdit);
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

  useEffect(() => {
    if (!searching) {
      setSearchHits(null);
      return;
    }
    const q = searchQuery.trim();
    if (!q || !isShadowDbEnabled()) {
      setSearchHits(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchLocalMessages(q, { peerId: userId, limit: 100 }).then(setSearchHits);
    }, 80);
    return () => clearTimeout(timer);
  }, [searching, searchQuery, userId]);

  const displayedThread = useMemo(() => {
    const q = searchQuery.trim();
    if (!searching || !q) return messageThread;
    if (isShadowDbEnabled() && searchHits) return searchHits;
    const needle = q.toLowerCase();
    return messageThread.filter((item) => {
      const hay = `${item.originalText || ""} ${item.translatedText || ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [searching, searchQuery, messageThread, searchHits]);

  const lastMessageId = messageThread[messageThread.length - 1]?.id ?? "";

  const stickBottom = useCallback(() => {
    if (!nearBottomRef.current) return;
    msgScroll.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  function markNearBottom(near: boolean) {
    nearBottomRef.current = near;
    setAwayFromBottom((prev) => (prev === !near ? prev : !near));
  }

  function onThreadScroll(event: { nativeEvent: { contentOffset: { y: number } } }) {
    markNearBottom(event.nativeEvent.contentOffset.y <= 120);
  }

  function jumpToLatest() {
    markNearBottom(true);
    msgScroll.current?.scrollToOffset({ offset: 0, animated: true });
  }

  useEffect(() => {
    if (searching) return;
    stickBottom();
  }, [messageThread.length, lastMessageId, stickBottom, searching]);

  useEffect(() => {
    Animated.timing(camSlide, {
      toValue: hasDraft ? 0 : 1,
      duration: 180,
      useNativeDriver: false,
    }).start();
  }, [hasDraft, camSlide]);

  const peer = useMemo(() => {
    const contact = contacts.find((row) => row.matchedUser?.id === userId);
    const matched = contact?.matchedUser;
    const snap = userId ? snapshots[userId] : undefined;
    const incoming = peerItems.find((item) => !item.mine);
    const outgoing = peerItems.find((item) => item.mine);
    const phone =
      profile?.phoneE164 ||
      matched?.phoneE164 ||
      contact?.phoneE164 ||
      incoming?.peerPhone ||
      outgoing?.peerPhone ||
      "";
    const talkName =
      profile?.displayName ||
      matched?.displayName ||
      snap?.name ||
      incoming?.peerName ||
      incoming?.senderName ||
      outgoing?.peerName ||
      (typeof name === "string" ? name : "");
    return {
      name:
        groupInfo?.name ||
        peerTitle({
          deviceName: findDeviceContact(phone, book)?.displayName,
          localHint: contact?.displayName,
          talkName,
          phone,
        }) ||
        t("messages"),
      avatarUrl: profile?.avatarHidden
        ? null
        : groupInfo?.avatarUrl || profile?.avatarUrl || matched?.avatarUrl || snap?.photo || incoming?.peerAvatar || outgoing?.peerAvatar || null,
      hideAvatar: Boolean(profile?.avatarHidden),
      gender: profile?.voiceGender || matched?.voiceGender || snap?.gender || incoming?.peerGender || "male",
      phone,
      talkName: talkNickname(profile?.displayName || matched?.displayName || talkName),
    };
  }, [contacts, snapshots, userId, name, peerItems, t, groupInfo, book, profile]);

  function stopTyping() {
    if (typingHeartbeatRef.current) {
      clearInterval(typingHeartbeatRef.current);
      typingHeartbeatRef.current = null;
    }
    if (!typingOnRef.current || !userId) return;
    typingOnRef.current = false;
    lastTypingEmitRef.current = 0;
    const socket = token ? ensureSocket(token) : getSocket();
    socket?.emit(SOCKET_EVENTS.CHAT_TYPING, { targetUserId: userId, typing: false });
  }

  function emitTypingTrue() {
    if (!userId || !token) return;
    const socket = ensureSocket(token);
    typingOnRef.current = true;
    lastTypingEmitRef.current = Date.now();
    socket.emit(SOCKET_EVENTS.CHAT_TYPING, { targetUserId: userId, typing: true });
  }

  function pulseTyping(next: string) {
    if (!userId || !token) return;
    // Empty box → clear "typing..." immediately. Non-empty → stay on until clear/send.
    if (!next.trim()) {
      stopTyping();
      return;
    }
    if (!typingOnRef.current) {
      emitTypingTrue();
    } else if (Date.now() - lastTypingEmitRef.current > 12_000) {
      emitTypingTrue();
    }
    if (!typingHeartbeatRef.current) {
      typingHeartbeatRef.current = setInterval(() => {
        if (!draftRef.current.trim()) {
          stopTyping();
          return;
        }
        emitTypingTrue();
      }, 12_000);
    }
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
    selectLockAt.current = Date.now();
    setSelected({});
    setReactFor("");
    setReactSheet(false);
  }

  function selectionLocked() {
    return Date.now() - selectLockAt.current < 500;
  }

  function beginSelect(id: string) {
    if (selectionLocked()) return;
    if (selecting) {
      toggleSelect(id);
      return;
    }
    setSelected({ [id]: true });
    setReactFor(id);
  }

  function toggleSelect(id: string) {
    if (selectionLocked()) return;
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
    clearSelect();
    setReactions((current) => ({ ...current, [id]: emoji, [tx]: emoji }));
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
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function replySelected() {
    const rows = selectedItems();
    const item = rows[rows.length - 1] || messageThread.find((row) => row.id === reactFor);
    if (item) replyToItem(item);
    else clearSelect();
  }

  // Edit is only offered for a single own text message in a direct chat.
  function canEditSelected() {
    if (isGroup || selectedCount !== 1) return false;
    const item = selectedItems()[0] || messageThread.find((row) => row.id === reactFor);
    if (!item) return false;
    return Boolean(item.mine || item.senderId === user?.id) && itemKind(item) === "text";
  }

  function editSelected() {
    const item = selectedItems()[0] || messageThread.find((row) => row.id === reactFor);
    if (!item || isGroup || !(item.mine || item.senderId === user?.id) || itemKind(item) !== "text") {
      clearSelect();
      return;
    }
    setReplyTo(null);
    setEditing({ id: item.id, tx: txIdOf(item.id) });
    setDraft((item.originalText || item.translatedText || "").toString());
    clearSelect();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelEdit() {
    setEditing(null);
    setDraft("");
  }

  // Send the CHAT_EDIT event, update my copy immediately, and mark it edited.
  async function commitEdit() {
    const text = (draftRef.current || draft).trim();
    const target = editing;
    if (!target || !text || !token || !userId) return;
    setEditing(null);
    setDraft("");
    stopTyping();
    setItems((current) => {
      const next = current.map((item) =>
        item.id === target.id || txIdOf(item.id) === target.tx
          ? { ...item, originalText: text, translatedText: text, edited: true }
          : item,
      );
      seedHistoryCache(next);
      return next;
    });
    const socket = token ? ensureSocket(token) : getSocket();
    socket?.emit(SOCKET_EVENTS.CHAT_EDIT, {
      targetUserId: userId,
      transmissionId: target.tx,
      text,
    });
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
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const item of selectedItems()) {
      const key = txIdOf(item.id) || item.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const owned = Boolean(item.mine || item.senderId === user?.id);
      const text = messageText(item, owned).trim() || clipLabel(item);
      if (text) texts.push(text);
    }
    clearSelect();
    if (!texts.length) return;
    const ok = await copyText(texts.join("\n"));
    if (ok) showCopied(t("messageCopied"));
  }

  async function forwardSelected() {
    const texts = selectedItems()
      .map((item) => {
        const owned = Boolean(item.mine || item.senderId === user?.id);
        return messageText(item, owned).trim() || clipLabel(item);
      })
      .filter(Boolean);
    clearSelect();
    if (!texts.length) return;
    try {
      await Share.share({ message: texts.join("\n") });
    } catch {
      /* cancelled */
    }
  }

  function messageText(item: HistoryItem, mine: boolean) {
    if (mine) return item.originalText || item.translatedText || "";
    return item.translatedText || item.originalText || "";
  }

  function clipLabel(item: HistoryItem) {
    const kind = itemKind(item);
    if (kind === "voice") return t("voiceClip");
    if (kind === "image") return t("photoClip");
    if (kind === "video") return t("videoClip");
    return "";
  }

  /** Payload for send: always the quoted message's original (source) text. */
  function quotePreview(item: HistoryItem) {
    const owned = Boolean(item.mine || item.senderId === user?.id);
    const original = decodeReply(item.originalText || "").text.trim();
    return {
      id: txIdOf(item.id) || item.id,
      name: owned ? user?.displayName || "" : peer.name,
      text: original || clipLabel(item),
    };
  }

  /** Composer / bubble quote: same original-vs-translated rule as a regular bubble. */
  function quoteViewText(item: HistoryItem) {
    const owned = Boolean(item.mine || item.senderId === user?.id);
    return messageText(item, owned) || clipLabel(item);
  }

  function findQuoted(item: HistoryItem) {
    const qid = item.replyToId;
    if (!qid) return undefined;
    const tx = txIdOf(qid) || qid;
    return messageThread.find((row) => row.id === qid || txIdOf(row.id) === tx);
  }

  function quotedDisplayText(item: HistoryItem) {
    const src = findQuoted(item);
    if (src) return quoteViewText(src) || item.replyToText || "";
    return item.replyToText || "";
  }

  async function deliverText(
    optimisticId: string,
    text: string,
    quoted: ReturnType<typeof quotePreview> | null,
  ) {
    if (!token || !userId) return;
    setError("");
    // clear any prior failed mark for this bubble (retry case) and show it as sending again
    setFailedIds((cur) => {
      if (!cur[optimisticId]) return cur;
      const next = { ...cur };
      delete next[optimisticId];
      return next;
    });
    const targetUserIds = isGroup ? groupMembers.filter((id) => id !== user?.id) : [userId];
    if (isShadowDbEnabled()) {
      const queued = await enqueueTextSend({
        localId: optimisticId,
        peerId: userId,
        originalText: text,
        targetUserIds,
        channelId: isGroup ? userId : undefined,
        replyToId: quoted?.id,
        replyToName: quoted?.name,
        replyToText: quoted?.text,
      });
      if (queued) {
        void flushOutbox();
        return;
      }
    }
    try {
      const saved = await api<{ id?: string }>("/transmissions/text", {
        method: "POST",
        token,
        timeoutMs: 45000,
        body: JSON.stringify({
          originalText: text,
          targetUserIds,
          channelId: isGroup ? userId : undefined,
          replyToId: quoted?.id,
          replyToName: quoted?.name,
          replyToText: quoted?.text,
          clientLocalId: optimisticId,
        }),
      });
      if (saved?.id) {
        const pending = takePendingReceipt(saved.id);
        setItems((current) => {
          const next = current.map((item) =>
            item.id === optimisticId
              ? { ...item, id: `${saved.id}:${userId}`, receipt: mergeReceipt(item.receipt || "sent", pending) || "sent" }
              : item,
          );
          seedHistoryCache(next);
          return next;
        });
      }
    } catch (e) {
      if (isNoRecipientError(e)) {
        setItems((current) => {
          const next = current.map((item) =>
            item.id === optimisticId ? { ...item, receipt: mergeReceipt(item.receipt, "sent") || "sent" } : item,
          );
          seedHistoryCache(next);
          return next;
        });
        return;
      }
      // Network/send failure: keep the bubble in place and mark it failed (red + retry),
      // instead of deleting it and freezing the flow.
      setError((e as Error).message);
      setFailedIds((cur) => ({ ...cur, [optimisticId]: { text, quoted } }));
    }
  }

  function retrySend(optimisticId: string) {
    if (isShadowDbEnabled()) {
      void flushOutbox();
    }
    const payload = failedIds[optimisticId];
    if (!payload) return;
    void deliverText(optimisticId, payload.text, payload.quoted);
  }

  async function sendPayload(text: string, fromComposer = false) {
    if (!text || !token || !userId || sendingRef.current || recordingRef.current) return;
    const quoted = fromComposer && replyTo ? quotePreview(replyTo) : null;
    if (fromComposer) {
      stopTyping();
      setDraft("");
      setEmojiOpen(false);
      setReplyTo(null);
    }
    sendingRef.current = true;
    setSending(true);
    setError("");
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
      receipt: "pending",
      channelId: isGroup ? userId : null,
      expiresAt: disappearSec ? new Date(Date.now() + disappearSec * 1000).toISOString() : null,
    };
    setItems((current) => {
      const next = sortMessages([optimistic, ...current]);
      seedHistoryCache(next);
      return next;
    });
    try {
      await deliverText(optimistic.id, text, quoted);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function sendText() {
    await sendPayload((draftRef.current || draft).trim(), true);
  }

  async function sendPickedContacts(people: PickedPerson[]) {
    setContactPick(false);
    for (const person of people) {
      await sendPayload(
        encodeSharedContact({
          name: person.name,
          phone: person.phone,
          userId: person.userId,
          avatar: person.avatar,
        }),
      );
    }
  }

  async function sendPickedPlace(place: { lat: number; lng: number; name?: string; address?: string }) {
    setLocationPick(false);
    try {
      await sendPayload(
        encodePlaceShare({
          live: false,
          liveId: "",
          lat: place.lat,
          lng: place.lng,
          until: 0,
          name: place.name,
          address: place.address,
        }),
      );
    } catch (e) {
      setError((e as Error).message || t("locationOff"));
    }
  }

  async function sendLivePlace(durationMs: number) {
    setLocationPick(false);
    if (!(await requestLocationAccess())) {
      Alert.alert("", t("locationOff"));
      return;
    }
    try {
      const place = await startLiveShare(userId, durationMs, {
        peerName: peer.name,
        peerAvatar: peer.avatarUrl,
      });
      markNearBottom(true);
      await sendPayload(encodePlaceShare(place));
    } catch (e) {
      stopLiveShare();
      setError((e as Error).message || t("locationOff"));
    }
  }

  function resetVoiceUi() {
    voiceLockedRef.current = false;
    recCancelRef.current = false;
    recStartedAt.current = 0;
    recDx.current = 0;
    recDy.current = 0;
    setVoiceLocked(false);
    setRecCancel(false);
    setHoldUi(false);
    setRecording(false);
    setPaused(false);
    setRecMs(0);
  }

  async function beginVoice() {
    if (recordingRef.current || sending || !userId) return;
    setEmojiOpen(false);
    Keyboard.dismiss();
    try {
      await stopPlayback();
      recordingRef.current = true;
      recStartedAt.current = Date.now();
      setPaused(false);
      setRecMs(0);
      setError("");
      await startRecording();
      setRecording(true);
      timer.current = setTimeout(() => {
        if (voiceLockedRef.current) void pauseRec(true);
        else void sendVoice(false);
      }, MAX_PTT_MS);
    } catch (e) {
      recordingRef.current = false;
      resetVoiceUi();
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
    resetVoiceUi();
    await cancelRecording();
    void primeConversationMic();
  }

  function isCancelSlide(dx: number, dy: number) {
    if (dy < -LOCK_DY && Math.abs(dy) >= Math.abs(dx)) return false;
    return Math.abs(dx) >= CANCEL_DX;
  }

  function onMicGrant(event: GestureResponderEvent) {
    if (hasDraft || editing || sending || voiceLockedRef.current) return;
    if (recordingRef.current || recStartedAt.current) return;
    recStartX.current = event.nativeEvent.pageX;
    recStartY.current = event.nativeEvent.pageY;
    recDx.current = 0;
    recDy.current = 0;
    recCancelRef.current = false;
    voiceLockedRef.current = false;
    setEmojiOpen(false);
    setRecCancel(false);
    setVoiceLocked(false);
    setHoldUi(true);
    recStartedAt.current = Date.now();
    beginWait.current = beginVoice();
  }

  function onMicMove(event: GestureResponderEvent) {
    if (voiceLockedRef.current || !recStartedAt.current) return;
    const dx = event.nativeEvent.pageX - recStartX.current;
    const dy = event.nativeEvent.pageY - recStartY.current;
    recDx.current = dx;
    recDy.current = dy;
    if (dy < -LOCK_DY && Math.abs(dy) >= Math.abs(dx)) {
      voiceLockedRef.current = true;
      recCancelRef.current = false;
      setVoiceLocked(true);
      setRecCancel(false);
      return;
    }
    const armed = isCancelSlide(dx, dy);
    recCancelRef.current = armed;
    setRecCancel(armed);
  }

  async function onMicRelease() {
    if (voiceLockedRef.current) return;
    if (recBusyRef.current) return;
    recBusyRef.current = true;
    try {
      await beginWait.current.catch(() => undefined);
      if (voiceLockedRef.current) return;
      const cancel = recCancelRef.current || isCancelSlide(recDx.current, recDy.current);
      if (cancel) {
        await deleteRec();
        return;
      }
      const held = Date.now() - recStartedAt.current;
      if (held < MIN_VOICE_MS) {
        await deleteRec();
        return;
      }
      await sendVoice(false);
    } finally {
      recBusyRef.current = false;
    }
  }

  async function sendVoice(viewOnce: boolean) {
    if (!recordingRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    recordingRef.current = false;
    const holdMs = Math.max(0, Date.now() - recStartedAt.current);
    resetVoiceUi();
    const quoted = replyTo ? quotePreview(replyTo) : null;
    setReplyTo(null);
    const recorded = await stopRecording();
    void primeConversationMic();
    if (!recorded?.uri || !token || !userId) return;
    if (!recorded.durationMs && holdMs > 0) recorded.durationMs = holdMs;
    if ((recorded.durationMs || holdMs) < MIN_VOICE_MS) return;
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
      receipt: "pending",
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
    form.append("clientLocalId", optimistic.id);
    if (quoted?.id) {
      form.append("replyToId", quoted.id);
      form.append("replyToName", quoted.name);
      form.append("replyToText", quoted.text);
    }
    if (isShadowDbEnabled()) {
      const fields: Record<string, string> = {
        durationMs: String(recorded.durationMs ?? 0),
        targetUserIds: JSON.stringify(isGroup ? groupMembers.filter((id) => id !== user?.id) : [userId]),
        kind: "voice",
        viewOnce: viewOnce ? "true" : "false",
      };
      if (isGroup) fields.channelId = userId;
      if (quoted?.id) {
        fields.replyToId = quoted.id;
        fields.replyToName = quoted.name;
        fields.replyToText = quoted.text;
      }
      const queued = await enqueueFileSend({
        localId: optimistic.id,
        peerId: userId,
        kind: "voice",
        uri: recorded.uri,
        name: "voice.m4a",
        type: "audio/m4a",
        fields,
      });
      if (queued) {
        void flushOutbox();
        return;
      }
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
      setError(isNoRecipientError(e) ? "" : (e as Error).message);
      setItems((current) => {
        const next = current.map((item) =>
          item.id === optimistic.id
            ? { ...item, receipt: mergeReceipt(item.receipt, isNoRecipientError(e) ? "sent" : "pending") || "pending" }
            : item,
        );
        seedHistoryCache(next);
        return next;
      });
    }
  }

  async function openCamera() {
    if (sending || recordingRef.current) return;
    setEmojiOpen(false);
    setCamOpen(true);
  }

  async function sendCapture(
    result: { uri: string; viewOnce: boolean; caption: string },
    takenOverride?: ChatCapture | null,
  ) {
    const taken = takenOverride || capture;
    setCapture(null);
    if (!taken || !token || !userId) return;
    const localUri = result.viewOnce ? result.uri : await keepLocalCapture(result.uri);
    const quoted = replyTo ? quotePreview(replyTo) : null;
    setReplyTo(null);
    setError("");
    const mediaText = taken.note ? encodeVideoNoteCaption(result.caption) : result.caption || null;
    const optimistic: HistoryItem = {
      id: `local-${Date.now()}`,
      senderName: user?.displayName || "",
      senderId: user?.id || "",
      originalText: mediaText,
      translatedText: mediaText,
      audioUrl: localUri,
      language: user?.speakLang || lang,
      createdAt: new Date().toISOString(),
      durationMs: taken.durationMs || null,
      mine: true,
      peerId: userId,
      peerAvatar: user?.avatarUrl,
      kind: taken.kind,
      viewOnce: result.viewOnce,
      replyToId: quoted?.id || null,
      replyToName: quoted?.name || null,
      replyToText: quoted?.text || null,
      receipt: "pending",
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
      uri: localUri,
      name: taken.kind === "image" ? "photo.jpg" : taken.name,
      type: taken.kind === "image" ? "image/jpeg" : taken.mime,
    } as unknown as Blob);
    form.append("kind", taken.kind);
    form.append("viewOnce", result.viewOnce ? "true" : "false");
    form.append("clientLocalId", optimistic.id);
    form.append("durationMs", String(taken.durationMs || 0));
    if (mediaText) form.append("originalText", mediaText);
    form.append("targetUserIds", JSON.stringify(isGroup ? groupMembers.filter((id) => id !== user?.id) : [userId]));
    if (isGroup) form.append("channelId", userId);
    if (quoted?.id) {
      form.append("replyToId", quoted.id);
      form.append("replyToName", quoted.name);
      form.append("replyToText", quoted.text);
    }
    if (isShadowDbEnabled()) {
      const fields: Record<string, string> = {
        kind: taken.kind,
        viewOnce: result.viewOnce ? "true" : "false",
        durationMs: String(taken.durationMs || 0),
        targetUserIds: JSON.stringify(isGroup ? groupMembers.filter((id) => id !== user?.id) : [userId]),
      };
      if (mediaText) fields.originalText = mediaText;
      if (isGroup) fields.channelId = userId;
      if (quoted?.id) {
        fields.replyToId = quoted.id;
        fields.replyToName = quoted.name;
        fields.replyToText = quoted.text;
      }
      const queued = await enqueueFileSend({
        localId: optimistic.id,
        peerId: userId,
        kind: taken.kind === "image" ? "image" : "video",
        uri: localUri,
        name: taken.kind === "image" ? "photo.jpg" : taken.name,
        type: taken.kind === "image" ? "image/jpeg" : taken.mime,
        fields,
      });
      if (queued) {
        void flushOutbox();
        return;
      }
    }
    try {
      const saved = await api<{ id?: string }>("/transmissions", { method: "POST", token, body: form, timeoutMs: 120000 });
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
      setError(isNoRecipientError(e) ? "" : (e as Error).message);
      setItems((current) => {
        const next = current.map((item) =>
          item.id === optimistic.id
            ? { ...item, receipt: mergeReceipt(item.receipt, isNoRecipientError(e) ? "sent" : "pending") || "pending" }
            : item,
        );
        seedHistoryCache(next);
        return next;
      });
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
    setItems((current) => {
      const next = current.map((row) =>
        txIdOf(row.id) === id ? { ...row, openedOnce: true, audioUrl: null } : row,
      );
      seedHistoryCache(next);
      return next;
    });
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
    const chronological: ChatRow[] = [];
    let lastDay = "";
    for (const item of displayedThread) {
      const day = dayKey(item.createdAt);
      if (day && day !== lastDay) {
        lastDay = day;
        chronological.push({ key: `day-${day}`, type: "day", label: dayLabel(item.createdAt) });
      }
      chronological.push({ key: item.id, type: "msg", item });
    }
    const groups: ChatRow[][] = [];
    let cur: ChatRow[] = [];
    for (const row of chronological) {
      if (row.type === "day") {
        if (cur.length) groups.push(cur);
        cur = [row];
      } else {
        cur.push(row);
      }
    }
    if (cur.length) groups.push(cur);
    const rows: ChatRow[] = [];
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i];
      const head = group[0]?.type === "day" ? group[0] : null;
      const msgs = head ? group.slice(1) : group;
      for (let j = msgs.length - 1; j >= 0; j -= 1) rows.push(msgs[j]);
      if (head) rows.push(head);
    }
    return rows;
  }, [displayedThread, lang, t]);

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
    const time = item.createdAt ? formatTime24(item.createdAt) : "";
    const picking = Boolean(selected[item.id]);
    const reaction = reactions[item.id] || reactions[txIdOf(item.id)] || "";
    const quotedName = item.replyToName || "";
    const quotedText = quotedDisplayText(item);
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
    const sharedContact = parseSharedContact(item.originalText) || parseSharedContact(item.translatedText);
    const sharedPlace = parsePlaceShare(item.originalText) || parsePlaceShare(item.translatedText);
    const note = kind === "video" && (isVideoNote(item.originalText) || isVideoNote(item.translatedText));
    const mediaCaption = item.openedOnce
      ? null
      : note
        ? videoNoteCaption(item.translatedText || item.originalText)
        : item.translatedText || item.originalText;
    const node =
      note ? (
        <View style={styles.reactHost}>
          <VideoNoteBubble
            uri={item.audioUrl}
            durationMs={item.durationMs}
            mine={mine}
            locked={Boolean(item.viewOnce && !mine && !item.openedOnce)}
            viewOnce={item.viewOnce}
            openedOnce={item.openedOnce}
            onceTitle={t("viewOnceCardTitle")}
            onceBody={t("viewOnceCardBody")}
            openedLabel={t("viewOnceOpened")}
            time={time}
            receipt={mine ? (item.openedOnce ? "read" : displayReceipt(item)) : undefined}
            selected={picking}
            selecting={selecting}
            quoteName={quotedName}
            quoteText={quotedText}
            rtl={rtl}
            caption={mediaCaption}
            onOpen={() => {
              onceRef.current = item;
              setOnceItem(item);
            }}
            onLongPress={() => beginSelect(item.id)}
            onSelect={() => toggleSelect(item.id)}
          />
          {reaction ? <ReactionChip emoji={reaction} mine={mine} /> : null}
        </View>
      ) : sharedContact ? (
        <Pressable onLongPress={() => beginSelect(item.id)} delayLongPress={280}>
          <View style={[styles.bubble, mine ? styles.mine : styles.theirs, styles.shareBubble, reaction ? styles.bubbleReact : null, reaction ? styles.reactVisible : null]}>
            <ContactShareCard
              contact={sharedContact}
              mine={mine}
              onAdd={() => void addToPhonebook(sharedContact)}
              onMessage={() => {
                if (!sharedContact.userId) return;
                router.navigate({
                  pathname: "/conversation/[userId]",
                  params: { userId: sharedContact.userId, name: sharedContact.name },
                });
              }}
              onOpenProfile={() => {
                if (!sharedContact.userId) {
                  Alert.alert("", t("callNotOnTalk"));
                  return;
                }
                router.navigate({
                  pathname: "/contact/[userId]",
                  params: {
                    userId: sharedContact.userId,
                    name: sharedContact.name,
                    phone: sharedContact.phone,
                    avatarUrl: sharedContact.avatar,
                  },
                });
              }}
            />
            {reaction ? <ReactionChip emoji={reaction} mine={mine} /> : null}
          </View>
        </Pressable>
      ) : sharedPlace ? (
        <View style={[styles.bubble, mine ? styles.mine : styles.theirs, styles.placeBubble, reaction ? styles.bubbleReact : null, reaction ? styles.reactVisible : null]}>
          <PlaceShareCard
            place={sharedPlace}
            mine={mine}
            avatarUrl={mine ? user?.avatarUrl : item.peerAvatar}
            avatarName={mine ? user?.displayName : item.senderName || peer.name}
            time={time}
            receipt={mine ? <ReceiptTicks receipt={displayReceipt(item)} /> : undefined}
            onLongPress={() => beginSelect(item.id)}
          />
          {reaction ? <ReactionChip emoji={reaction} mine={mine} /> : null}
        </View>
      ) : kind === "image" || kind === "video" ? (
        <View style={styles.reactHost}>
          <MediaBubble
            uri={item.audioUrl}
            kind={kind}
            durationMs={item.durationMs}
            mine={mine}
            locked={Boolean(item.viewOnce && !mine && !item.openedOnce)}
            viewOnce={item.viewOnce}
            openedOnce={item.openedOnce}
            onceTitle={t("viewOnceCardTitle")}
            onceBody={t("viewOnceCardBody")}
            openedLabel={t("viewOnceOpened")}
            time={time}
            receipt={mine ? (item.openedOnce ? "read" : displayReceipt(item)) : undefined}
            selected={picking}
            selecting={selecting}
            quoteName={quotedName}
            quoteText={quotedText}
            photoLabel={t("photoClip")}
            videoLabel={t("videoClip")}
            caption={mediaCaption}
            onOpen={() => {
              onceRef.current = item;
              setOnceItem(item);
            }}
            onLongPress={() => beginSelect(item.id)}
            onSelect={() => toggleSelect(item.id)}
          />
          {reaction ? <ReactionChip emoji={reaction} mine={mine} /> : null}
        </View>
      ) : kind === "voice" ? (
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
          receipt={mine ? displayReceipt(item) : undefined}
        />
      ) : (
        <Pressable
          onPress={() => {
            if (selecting) toggleSelect(item.id);
          }}
          onLongPress={() => beginSelect(item.id)}
          delayLongPress={280}
        >
          <View
            style={[
              styles.bubble,
              mine ? styles.mine : styles.theirs,
              rtl ? (mine ? styles.mineRtl : styles.theirsRtl) : null,
              reaction ? styles.bubbleReact : null,
            ]}
          >
            {quotedName || quotedText ? <QuoteBox name={quotedName} text={quotedText} compact rtl={rtl} /> : null}
            {messageText(item, mine) ? (
              <HighlightText
                text={messageText(item, mine)}
                query={searchQuery}
                style={[
                  styles.text,
                  mine ? styles.mineText : styles.theirText,
                  { textAlign: rtl ? "right" : "left", writingDirection: rtl ? "rtl" : "ltr" },
                ]}
              />
            ) : null}
            {time || mine || item.edited ? (
              <View style={styles.metaRow}>
                {item.edited ? (
                  <Text style={[styles.meta, mine ? styles.mineMeta : styles.theirMeta]}>{t("editedTag")}</Text>
                ) : null}
                {time ? <Text style={[styles.meta, mine ? styles.mineMeta : styles.theirMeta]}>{time}</Text> : null}
                {mine && failedIds[item.id] ? (
                  <Pressable hitSlop={8} onPress={() => retrySend(item.id)} style={styles.failRetry}>
                    <Text style={styles.failText}>{t("txFail")} ↻</Text>
                  </Pressable>
                ) : mine ? (
                  <ReceiptTicks receipt={displayReceipt(item)} />
                ) : null}
              </View>
            ) : null}
            {reaction ? <ReactionChip emoji={reaction} mine={mine} /> : null}
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
            direction: "ltr",
            // Deterministic side regardless of the device locale: in RTL (Hebrew)
            // my bubbles sit on the left and the peer on the right, like WhatsApp.
            justifyContent: mine !== rtl ? "flex-end" : "flex-start",
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

  async function addToPhonebook(shared?: { name: string; phone: string }) {
    const contact = contacts.find((row) => row.matchedUser?.id === userId);
    const name = shared?.name || peer.name;
    const phone = shared?.phone || peer.phone || contact?.matchedUser?.phoneE164 || contact?.phoneE164 || "";
    try {
      const Contacts = require("expo-contacts") as typeof import("expo-contacts");
      const perm = await Contacts.requestPermissionsAsync();
      if (!perm.granted) return;
      await Contacts.addContactAsync({
        name,
        contactType: Contacts.ContactTypes.Person,
        phoneNumbers: phone ? [{ label: "mobile", number: phone }] : [],
      });
      Alert.alert(t("contactAdded"));
    } catch {
      Alert.alert(t("addToContacts"), phone || name);
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
            onEdit={canEditSelected() ? editSelected : undefined}
            onDelete={deleteSelected}
            onCopy={() => void copySelected()}
            onForward={() => void forwardSelected()}
            onMore={() => Alert.alert("", "", [{ text: t("cancel") }])}
          />
        ) : (
        <ChatHeader
          name={peer.name}
          avatarUrl={peer.avatarUrl}
          hideAvatar={peer.hideAvatar}
          gender={peer.gender}
          online={peerOnline}
          typing={peerTyping}
          lastSeen={peerLastSeen}
          group={isGroup}
          onOpenProfile={() => {
            if (!userId) return;
            if (isGroup) {
              router.navigate({
                pathname: "/group/[channelId]",
                params: { channelId: userId, name: peer.name },
              });
              return;
            }
            const contact = contacts.find((row) => row.matchedUser?.id === userId);
            router.navigate({
              pathname: "/contact/[userId]",
              params: {
                userId,
                name: peer.name,
                avatarUrl: peer.avatarUrl || "",
                phone: peer.phone || contact?.matchedUser?.phoneE164 || contact?.phoneE164 || "",
                gender: peer.gender,
                localName: peer.name,
                appName: peer.talkName,
              },
            });
          }}
          onMenu={() => setMenuOpen(true)}
          onWalkie={() => {
            if (!userId) return;
            if (isGroup) {
              const ids = groupMembers.filter((id) => id && id !== user?.id);
              selectMany([
                {
                  id: userId,
                  name: peer.name,
                  photo: peer.avatarUrl,
                  gender: peer.gender,
                  isGroup: true,
                  memberIds: ids,
                },
              ]);
            } else {
              selectMany([{ id: userId, name: peer.name, photo: peer.avatarUrl, gender: peer.gender }]);
            }
            router.navigate("/home");
          }}
          onVideo={() => {
            if (!userId) return;
            if (isGroup) {
              startGroupOutgoing({
                channelId: userId,
                name: peer.name,
                avatarUrl: peer.avatarUrl,
                video: true,
                members: groupMembers
                  .filter((id) => id && id !== user?.id)
                  .map((id) => {
                    const person = contacts.find((row) => row.matchedUser?.id === id)?.matchedUser;
                    const snap = snapshots[id];
                    return {
                      userId: id,
                      name: person?.displayName || snap?.name || "",
                      avatarUrl: person?.avatarUrl || snap?.photo,
                    };
                  }),
              });
              return;
            }
            startOutgoing({
              userId,
              name: peer.name,
              phone: peer.phone,
              avatarUrl: peer.avatarUrl,
              gender: peer.gender,
              video: true,
            });
          }}
          onCall={() => {
            if (!userId) return;
            if (isGroup) {
              startGroupOutgoing({
                channelId: userId,
                name: peer.name,
                avatarUrl: peer.avatarUrl,
                members: groupMembers
                  .filter((id) => id && id !== user?.id)
                  .map((id) => {
                    const person = contacts.find((row) => row.matchedUser?.id === id)?.matchedUser;
                    const snap = snapshots[id];
                    return {
                      userId: id,
                      name: person?.displayName || snap?.name || "",
                      avatarUrl: person?.avatarUrl || snap?.photo,
                    };
                  }),
              });
              return;
            }
            startOutgoing({
              userId,
              name: peer.name,
              phone: peer.phone,
              avatarUrl: peer.avatarUrl,
              gender: peer.gender,
            });
          }}
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
              inverted
              onScrollToIndexFailed={(info) => {
                msgScroll.current?.scrollToOffset({
                  offset: Math.max(0, (info.averageItemLength || 96) * info.index),
                  animated: false,
                });
              }}
              onScroll={onThreadScroll}
              scrollEventThrottle={16}
              onContentSizeChange={() => stickBottom()}
              ListEmptyComponent={<Text style={styles.empty}>{t("noMessagesYet")}</Text>}
            />
            {awayFromBottom ? (
              <Pressable onPress={jumpToLatest} style={styles.jumpDown} hitSlop={8} accessibilityRole="button">
                <Ionicons name="chevron-down" size={22} color="#54656F" />
              </Pressable>
            ) : null}
          </View>
        </View>
        <View>
          <EmojiPicker
            visible={emojiOpen && !recording}
            onPick={(emoji) => {
              const next = `${draftRef.current}${emoji}`;
              draftRef.current = next;
              setDraft(next);
              if (!editing) pulseTyping(next);
            }}
            onPickSticker={(uri) => {
              setEmojiOpen(false);
              void sendCapture(
                { uri, viewOnce: false, caption: "" },
                {
                  uri,
                  kind: "image",
                  durationMs: 0,
                  mime: uri.toLowerCase().includes(".png") ? "image/png" : "image/jpeg",
                  name: uri.toLowerCase().includes(".png") ? "sticker.png" : "sticker.jpg",
                },
              );
            }}
            onPickGif={(uri) => {
              setEmojiOpen(false);
              void sendCapture(
                { uri, viewOnce: false, caption: "" },
                { uri, kind: "image", durationMs: 0, mime: "image/gif", name: "clip.gif" },
              );
            }}
          />
          <View style={styles.composer}>
            {holdUi || recording || voiceLocked ? (
              voiceLocked ? (
                <VoiceLockBar
                  durationMs={recMs}
                  paused={paused}
                  onPause={() => void pauseRec()}
                  onDelete={() => void deleteRec()}
                />
              ) : (
                <VoiceHoldBar durationMs={recMs} cancelArmed={recCancel} />
              )
            ) : (
              <View style={styles.pill}>
                {editing ? (
                  <View style={styles.editBanner}>
                    <Ionicons name="pencil" size={18} color="#00A884" />
                    <View style={styles.editBannerCopy}>
                      <Text style={[styles.editBannerTitle, { textAlign: align }]}>{t("editingMessage")}</Text>
                    </View>
                    <Pressable onPress={cancelEdit} hitSlop={8} style={styles.editBannerX}>
                      <Ionicons name="close" size={20} color="#54656F" />
                    </Pressable>
                  </View>
                ) : replyTo ? (
                  <QuoteBox
                    name={quotePreview(replyTo).name}
                    text={quoteViewText(replyTo)}
                    inset
                    rtl={rtl}
                    onClose={() => setReplyTo(null)}
                  />
                ) : null}
                <View style={styles.pillRow}>
                  <Animated.View
                    pointerEvents={hasDraft ? "none" : "auto"}
                    style={{
                      width: camSlide.interpolate({ inputRange: [0, 1], outputRange: [0, 38] }),
                      opacity: camSlide,
                      overflow: "hidden",
                    }}
                  >
                    <Pressable onPress={() => void openCamera()} hitSlop={6} style={styles.pillSideBtn}>
                      <Ionicons name="camera-outline" size={24} color="#54656F" />
                    </Pressable>
                  </Animated.View>
                  {editing ? null : (
                    <Pressable
                      onPress={() => {
                        setEmojiOpen(false);
                        setPinOpen(true);
                      }}
                      hitSlop={6}
                      style={styles.pillSideBtn}
                    >
                      <Ionicons name="attach" size={24} color="#54656F" />
                    </Pressable>
                  )}
                  <ComposerInput
                    inputRef={inputRef}
                    draftRef={draftRef}
                    external={draft}
                    rtl={rtl}
                    placeholder={t("typeMessage")}
                    onChangeText={(value) => {
                      setDraft(value);
                      if (!editing) pulseTyping(value);
                      if (emojiOpen && value.length === 0) setEmojiOpen(false);
                    }}
                    onFocus={() => setEmojiOpen(false)}
                  />
                  <Pressable
                    onPress={() => setEmojiOpen((open) => !open)}
                    hitSlop={8}
                    style={styles.emojiBtn}
                  >
                    <Ionicons name="happy-outline" size={26} color="#54656F" />
                  </Pressable>
                </View>
              </View>
            )}
            {voiceLocked ? (
              <Pressable
                onPress={() => void sendVoice(false)}
                style={styles.actionBtn}
                hitSlop={4}
              >
                <SendArrowIcon size={22} color="#FFFFFF" rtl={rtl} />
              </Pressable>
            ) : hasDraft || editing ? (
              <Pressable
                onPress={() => {
                  if (editing) void commitEdit();
                  else void sendText();
                }}
                disabled={hasDraft && (!draft.trim() || sending)}
                style={[styles.actionBtn, hasDraft && (!draft.trim() || sending) && styles.actionOff]}
                hitSlop={4}
              >
                {editing ? (
                  <Ionicons name="checkmark" size={28} color="#FFFFFF" />
                ) : (
                  <SendArrowIcon size={22} color="#FFFFFF" rtl={rtl} />
                )}
              </Pressable>
            ) : (
              <View style={styles.micCol} collapsable={false}>
                <View
                  collapsable={false}
                  onStartShouldSetResponder={() => true}
                  onMoveShouldSetResponder={() => true}
                  onResponderTerminationRequest={() => false}
                  onResponderGrant={onMicGrant}
                  onResponderMove={onMicMove}
                  onResponderRelease={() => void onMicRelease()}
                  onResponderTerminate={() => void onMicRelease()}
                  style={[styles.micHit, (holdUi || recording) && styles.micHitHold]}
                >
                  <View
                    style={[styles.lockRail, !(holdUi || recording) && styles.lockRailHidden]}
                    pointerEvents="none"
                  >
                    <View style={[styles.lockBubble, recCancel && styles.lockBubbleOff]}>
                      <Ionicons name="lock-open-outline" size={18} color="#FFFFFF" />
                    </View>
                  </View>
                  <View
                    pointerEvents="none"
                    style={[styles.actionBtn, (holdUi || recording) && styles.actionHeld]}
                  >
                    <MicIcon size={26} color="#FFFFFF" />
                  </View>
                </View>
              </View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
      {onceItem && itemKind(onceItem) === "voice" ? (
        <ViewOncePlayer
          visible
          uri={onceItem?.audioUrl || null}
          durationMs={onceItem?.durationMs || null}
          onClose={() => void closeOnce()}
        />
      ) : null}
      {onceItem &&
      (itemKind(onceItem) === "image" || itemKind(onceItem) === "video") &&
      !(isVideoNote(onceItem.originalText) || isVideoNote(onceItem.translatedText)) ? (
        <MediaViewer
          visible
          uri={onceItem?.audioUrl || null}
          kind={itemKind(onceItem) === "video" ? "video" : "image"}
          viewOnce={Boolean(onceItem?.viewOnce && !onceItem?.mine && onceItem?.senderId !== user?.id)}
          onClose={() => void closeOnce()}
        />
      ) : null}
      <ChatCamera
        visible={camOpen}
        peerName={peer.name}
        photoLabel={t("camPhoto")}
        videoLabel={t("camVideo")}
        noteLabel={t("camVideoNote")}
        captionPlaceholder={t("addCaption")}
        onClose={() => setCamOpen(false)}
        onCapture={(taken) => {
          setCamOpen(false);
          setCapture(taken);
        }}
        onSendNote={(taken, caption) => {
          setCamOpen(false);
          void sendCapture({ uri: taken.uri, viewOnce: false, caption }, taken);
        }}
      />
      <CapturePreview
        capture={capture}
        peerName={peer.name}
        onSend={(result) => void sendCapture(result)}
        onCancel={() => setCapture(null)}
      />
      <PinMenu
        visible={pinOpen}
        onClose={() => setPinOpen(false)}
        onContact={() => {
          setPinOpen(false);
          setContactPick(true);
        }}
        onLocation={() => {
          setPinOpen(false);
          void (async () => {
            if (!(await requestLocationAccess())) {
              Alert.alert("", t("locationOff"));
              return;
            }
            setLocationPick(true);
          })();
        }}
      />
      <PeoplePickSheet
        visible={contactPick}
        title={t("sendToTitle")}
        excludeId={user?.id}
        onClose={() => setContactPick(false)}
        onConfirm={(people) => void sendPickedContacts(people)}
        onAddGroup={() => {
          setContactPick(false);
          router.navigate("/group/new");
        }}
      />
      <LocationPickSheet
        visible={locationPick}
        onClose={() => setLocationPick(false)}
        onPickPlace={(place) => void sendPickedPlace(place)}
        onPickLive={(durationMs) => void sendLivePlace(durationMs)}
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
    minHeight: 52,
    flexDirection: "row",
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
  jumpDown: {
    position: "absolute",
    right: 10,
    bottom: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    zIndex: 20,
  },
  list: {
    paddingVertical: 10,
  },
  itemStack: {
    maxWidth: "90%",
    flexShrink: 1,
    marginHorizontal: 2,
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
  placeBubble: {
    overflow: "hidden",
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 2,
    maxWidth: "100%",
    alignSelf: "stretch",
    minWidth: 200,
  },
  shareBubble: {
    overflow: "hidden",
    paddingHorizontal: 0,
    paddingVertical: 0,
    maxWidth: "100%",
    alignSelf: "stretch",
    minWidth: 200,
  },
  bubbleReact: { paddingBottom: 14 },
  reactHost: { position: "relative", overflow: "visible" },
  reactVisible: { overflow: "visible" },
  mine: { backgroundColor: MINE_BG, borderTopRightRadius: 4 },
  mineRtl: { borderTopRightRadius: 12, borderTopLeftRadius: 4 },
  theirsRtl: { borderTopLeftRadius: 12, borderTopRightRadius: 4 },
  pickedRow: {
    backgroundColor: "rgba(17,27,33,0.08)",
    borderRadius: 8,
  },
  pickedBubble: { backgroundColor: "rgba(30,120,240,0.16)" },
  camBtn: {
    width: 40,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
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
  metaRow: { marginTop: 4, flexDirection: "row", alignItems: "center", alignSelf: "flex-end", zIndex: 11 },
  meta: { fontSize: 11, fontWeight: "600" },
  mineMeta: { color: "rgba(17,27,33,0.42)" },
  theirMeta: { color: "rgba(17,27,33,0.38)" },
  empty: { color: "rgba(17,27,33,0.45)", textAlign: "center", marginTop: 40 },
  error: { color: colors.red, marginBottom: 6 },
  failRetry: { flexDirection: "row", alignItems: "center", marginLeft: 6 },
  failText: { color: colors.red, fontSize: 11, fontWeight: "700" },
  dockBleed: { marginTop: 4 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(92,78,114,0.12)",
    backgroundColor: "#EFEAF6",
    overflow: "visible",
    zIndex: 20,
  },
  micCol: {
    width: 48,
    height: 48,
    alignItems: "flex-end",
    justifyContent: "flex-end",
    overflow: "visible",
    zIndex: 30,
  },
  micHit: {
    width: 48,
    height: 48,
    alignItems: "flex-end",
    justifyContent: "flex-end",
    overflow: "visible",
  },
  micHitHold: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 280,
    height: 170,
  },
  lockRail: {
    position: "absolute",
    right: 4,
    bottom: 56,
    alignItems: "center",
  },
  lockRailHidden: {
    opacity: 0,
  },
  lockBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#00A884",
    alignItems: "center",
    justifyContent: "center",
  },
  lockBubbleOff: {
    opacity: 0.35,
  },
  actionHeld: {
    transform: [{ scale: 1.08 }],
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
  editBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 10,
    marginTop: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(17,27,33,0.08)",
  },
  editBannerCopy: { flex: 1 },
  editBannerTitle: { color: "#00A884", fontSize: 13, fontWeight: "700" },
  editBannerX: { padding: 4 },
  pill: {
    flex: 1,
    flexDirection: "column",
    minHeight: 48,
    maxHeight: 300,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(17,27,33,0.08)",
    alignItems: "stretch",
    paddingLeft: 4,
    paddingRight: 2,
    paddingBottom: 2,
    overflow: "hidden",
  },
  pillRow: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "flex-end",
    minHeight: 48,
    gap: 2,
    paddingLeft: 2,
    paddingRight: 4,
  },
  pillSideBtn: {
    width: 36,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiBtn: {
    width: 32,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  inputWrap: {
    flex: 1,
    minHeight: INPUT_MIN,
    justifyContent: "flex-end",
  },
  fakePlaceholder: {
    position: "absolute",
    top: 0,
    bottom: 0,
    textAlignVertical: "center",
    color: "#111B21",
    fontSize: 16,
    lineHeight: 44,
  },
  fakePlaceholderRtl: { right: 2, left: 8, textAlign: "right" },
  fakePlaceholderLtr: { left: 2, right: 8, textAlign: "left" },
  input: {
    width: "100%",
    minHeight: INPUT_MIN,
    color: "#111B21",
    fontSize: 16,
    paddingHorizontal: 4,
    paddingVertical: 0,
  },
});
