import { PttSpeakingPayload, TransmissionReadyPayload } from "@talk/shared";
import { useFocusEffect, usePathname, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IncomingOverlay } from "../../src/components/IncomingOverlay";
import { LabeledAction } from "../../src/components/MirsControls";
import { SelectedRoster, type RosterPerson } from "../../src/components/SelectedRoster";
import {
  HistoryIcon,
  PeopleIcon,
  SearchIcon,
  SpeakerIcon,
} from "../../src/components/MirsIcons";
import { PttButton } from "../../src/components/PttButton";
import { useI18n } from "../../src/i18n";
import { api } from "../../src/lib/api";
import { startRecording, stopPlayback, stopRecording, setLoudSpeaker } from "../../src/lib/audio";
import { useAuth } from "../../src/lib/auth";
import { clockLog } from "../../src/lib/clock";
import { holdDiscovery } from "../../src/lib/discover";
import { MAX_PTT_MS } from "../../src/lib/config";
import { registerPushToken, attachNotificationListeners, takeLastNotification } from "../../src/lib/notifications";
import { playReceived } from "../../src/lib/receive";
import { stopRobot } from "../../src/lib/onDeviceAi";
import { SOCKET_EVENTS, ensureSocket, getSocket } from "../../src/lib/socket";
import { cachedTalkContacts, fetchTalkContacts } from "../../src/lib/syncContacts";
import { useTargets } from "../../src/lib/targets";
import { colors } from "../../src/lib/theme";
import { fetchUnread, isInboxMessage, markPeerTextRead } from "../../src/lib/unread";
import { enqueueVoice, loadPendingVoice, takePendingVoice } from "../../src/lib/pendingVoice";
import { isInPhoneCall, subscribePhoneCall } from "../../src/lib/phoneCall";
import { playWalkieExclusive } from "../../src/lib/walkiePlay";
import { subscribeIncomingPush } from "../../src/lib/incomingPush";
import { personLabel } from "../../src/lib/personLabel";
import { fetchOnlineIds } from "../../src/lib/presence";
import { prefetchHistory } from "../../src/lib/historyCache";

function incomingLabel(payload: TransmissionReadyPayload, _known: boolean) {
  return personLabel(payload.senderName, payload.senderPhone);
}

/** Language the user wants to HEAR — listenLang first, then speakLang. */
function hearLang(
  me?: { listenLang?: string | null; speakLang?: string | null } | null,
  fallback = "",
) {
  return me?.listenLang || me?.speakLang || fallback;
}

export default function HomeScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const { token, user, logout } = useAuth();
  const { t, align } = useI18n();
  const { selectedIds, everyone, contacts, setContacts, toggle, setEveryone, syncSelected, snapshots, select } = useTargets();
  const [talking, setTalking] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [written, setWritten] = useState("");
  const [incoming, setIncoming] = useState<TransmissionReadyPayload | null>(null);
  const [liveSpeaker, setLiveSpeaker] = useState<RosterPerson | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [recordingFromId, setRecordingFromId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [pendingBySender, setPendingBySender] = useState<Record<string, TransmissionReadyPayload[]>>({});
  const [onlineMap, setOnlineMap] = useState<Record<string, boolean>>({});
  const [sessionUnlocked, setSessionUnlocked] = useState<Record<string, boolean>>({});
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const talkingRef = useRef(false);
  const wantEndRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBySenderRef = useRef<Record<string, TransmissionReadyPayload[]>>({});
  const sessionUnlockedRef = useRef<Record<string, boolean>>({});
  const mutedRef = useRef<Record<string, boolean>>({});
  const onReadyRef = useRef<(payload: TransmissionReadyPayload) => void>(() => undefined);
  const queueWaitingRef = useRef<(payload: TransmissionReadyPayload) => void>(() => undefined);
  const hearOneRef = useRef<(payload: TransmissionReadyPayload) => Promise<void>>(async () => undefined);
  const heardIdsRef = useRef(new Set<string>());
  const sendingIds = useRef<string[]>([]);
  const clockRef = useRef<{ press: number; release?: number } | null>(null);
  const playCtx = useRef({
    token,
    user,
    t,
    contacts,
    pathname,
    select,
    focusedId,
    selectedIds,
  });
  playCtx.current = { token, user, t, contacts, pathname, select, focusedId, selectedIds };
  pendingBySenderRef.current = pendingBySender;
  sessionUnlockedRef.current = sessionUnlocked;
  mutedRef.current = muted;

  const pendingSenderIds = useMemo(() => Object.keys(pendingBySender).filter((id) => pendingBySender[id]?.length), [pendingBySender]);
  const pendingCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const id of pendingSenderIds) map[id] = pendingBySender[id]?.length ?? 0;
    return map;
  }, [pendingBySender, pendingSenderIds]);

  const talkPeople = useMemo(
    () => contacts.filter((c) => c.matchedUser && c.status !== "BLOCKED"),
    [contacts],
  );

  const listedPeople = useMemo(() => {
    if (everyone) {
      return talkPeople.filter((c) => c.status === "ACCEPTED" || !c.status);
    }
    return selectedIds
      .map((id) => talkPeople.find((c) => c.matchedUser?.id === id) ?? null)
      .filter((c): c is (typeof talkPeople)[number] => Boolean(c));
  }, [talkPeople, selectedIds, everyone]);

  const listedIds = useMemo(() => {
    const fromEveryone = listedPeople.map((p) => p.matchedUser!.id);
    const ids = everyone
      ? fromEveryone.length
        ? fromEveryone
        : [...selectedIds]
      : [...selectedIds];
    if (liveSpeaker?.id && speakingId === liveSpeaker.id) ids.unshift(liveSpeaker.id);
    for (const id of pendingSenderIds) ids.unshift(id);
    return [...new Set(ids)];
  }, [everyone, listedPeople, selectedIds, liveSpeaker, pendingSenderIds, speakingId]);
  const talkIds = useMemo(() => {
    const board = everyone
      ? listedPeople.map((p) => p.matchedUser!.id)
      : [...selectedIds];
    const ids = board.length ? board : [...selectedIds];
    if (focusedId && ids.includes(focusedId)) return [focusedId];
    return [...new Set(ids)];
  }, [everyone, listedPeople, selectedIds, focusedId]);
  const listedLen = useRef(0);
  useEffect(() => {
    const n = listedIds.length;
    const pendingIds = new Set(pendingSenderIds);
    if (n <= 1) {
      const only = listedIds[0] ?? null;
      if (only && pendingIds.has(only)) {
        setFocusedId(null);
      } else {
        setFocusedId((current) => (current === only ? current : only));
        // Do NOT auto-unlock: first walkie must wait for a tap (badge), even if alone on board.
      }
    } else if (listedLen.current <= 1) {
      setFocusedId(null);
    } else {
      setFocusedId((current) => (current && listedIds.includes(current) ? current : null));
    }
    listedLen.current = n;
  }, [listedIds, pendingSenderIds]);

  useEffect(() => {
    if (!everyone) return;
    const ids = talkPeople
      .filter((c) => c.status === "ACCEPTED" || !c.status)
      .map((c) => c.matchedUser!.id);
    if (!ids.length) return;
    // Avoid sync loops: only write when the board actually changed.
    if (ids.length === selectedIds.length && ids.every((id) => selectedIds.includes(id))) return;
    syncSelected(ids);
    // selectedIds intentionally omitted from deps — syncSelected updates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyone, talkPeople, syncSelected]);

  useFocusEffect(
    useCallback(() => {
      const cached = cachedTalkContacts();
      if (cached.length) setContacts(cached);
    }, [setContacts]),
  );

  useEffect(() => {
    if (!token) return;
    void registerPushToken(token).catch(() => undefined);
    prefetchHistory(token);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const socket = ensureSocket(token);
    const onSpeaking = (payload: PttSpeakingPayload) => {
      if (payload.speakerId === playCtx.current.user?.id) return;
      // Cyan pulse while they hold PTT — green only during playback (speakingId).
      setRecordingFromId(payload.speakerId);
      setOnlineMap((current) => ({ ...current, [payload.speakerId]: true }));
      const fromContacts = playCtx.current.contacts.find((c) => c.matchedUser?.id === payload.speakerId)?.matchedUser;
      setLiveSpeaker({
        id: payload.speakerId,
        name: payload.speakerName,
        photo: payload.speakerAvatarUrl ?? fromContacts?.avatarUrl ?? null,
        gender: payload.voiceGender ?? fromContacts?.voiceGender ?? "male",
      });
      setBusyName(payload.speakerName);
      if (!pendingBySenderRef.current[payload.speakerId]?.length) {
        pinSender({
          senderId: payload.speakerId,
          senderName: payload.speakerName,
          senderAvatarUrl: payload.speakerAvatarUrl,
          voiceGender: payload.voiceGender,
          senderPhone: "",
        });
      }
      if (speakClear.current) clearTimeout(speakClear.current);
    };
    const onReleased = (payload?: { speakerId?: string }) => {
      setBusyName(null);
      setRecordingFromId((current) => {
        if (payload?.speakerId && current !== payload.speakerId) return current;
        return null;
      });
    };
    const onBusy = (payload: { speakerName: string }) => {
      setBusyName(payload.speakerName);
      // No bottom status on receiver for remote floor — pulse is enough.
      void payload;
    };
    const onReady = async (payload: TransmissionReadyPayload) => {
      clockLog("recv", { kind: payload.kind || "walkie" });
      const { token: tok, user: me, t: tr, pathname: path } = playCtx.current;
      if (payload.senderId === me?.id) {
        setStatus(tr("delivered"));
        const line = (payload.translatedText || "").trim();
        if (line) setWritten(line);
        return;
      }
      if (isInboxMessage(payload)) {
        const viewing = path.includes(`/conversation/`) && path.includes(payload.senderId);
        if (viewing && tok) {
          void markPeerTextRead(tok, payload.senderId)
            .then(() => fetchUnread(tok))
            .then((info) => setUnreadTotal(info.total))
            .catch(() => undefined);
        } else {
          setUnreadTotal((n) => n + 1);
          setStatus(tr("newMessageWaiting"));
          if (tok) {
            void fetchUnread(tok)
              .then((info) => setUnreadTotal((n) => Math.max(n, info.total)))
              .catch(() => undefined);
          }
        }
        return;
      }
      const walkie = (payload.kind || "walkie") === "walkie";
      const onTalk = path === "/home" || path === "/" || path.endsWith("/home");
      if (walkie && (AppState.currentState !== "active" || !onTalk)) {
        queueWaiting(payload);
        return;
      }
      const onBoard =
        playCtx.current.selectedIds.includes(payload.senderId) ||
        playCtx.current.focusedId === payload.senderId;
      const alreadyOpen = Boolean(sessionUnlockedRef.current[payload.senderId]) && onBoard;
      const mutedSender = Boolean(mutedRef.current[payload.senderId]);
      if (
        walkie &&
        (AppState.currentState !== "active" || !alreadyOpen || mutedSender || (await isInPhoneCall()))
      ) {
        queueWaiting(payload);
        return;
      }
      if (walkie) {
        sessionUnlockedRef.current = { ...sessionUnlockedRef.current, [payload.senderId]: true };
        setSessionUnlocked((current) => ({ ...current, [payload.senderId]: true }));
        dropPending(payload.senderId);
      }
      pinSender(payload);
      select(payload.senderId, {
        id: payload.senderId,
        name: payload.senderName,
        photo: payload.senderAvatarUrl,
        gender: payload.voiceGender ?? "male",
      });
      const playVoice = async (cancelled: () => boolean) => {
        if (cancelled()) return;
        setRecordingFromId(null);
        setSpeakingId(payload.senderId);
        setOnlineMap((current) => ({ ...current, [payload.senderId]: true }));
        setLiveSpeaker({
          id: payload.senderId,
          name: payload.senderName,
          photo: payload.senderAvatarUrl ?? null,
          gender: payload.voiceGender ?? "male",
        });
        const line = (payload.translatedText || payload.originalText || "").trim();
        if (line) setWritten(line);
        setStatus("");
        try {
          await playReceived(payload, hearLang(me, payload.language), tok);
          if (cancelled()) return;
          if (tok) {
            void api(`/transmissions/${payload.transmissionId}/played`, { method: "POST", token: tok });
          }
        } catch {
          if (cancelled()) return;
          await enqueueVoice(payload);
          setStatus(tr("willPlayAfterCall"));
        } finally {
          if (!cancelled()) {
            if (speakClear.current) clearTimeout(speakClear.current);
            setSpeakingId(null);
          }
        }
      };
      await playWalkieExclusive(async (cancelled) => {
        if (cancelled()) {
          queueWaitingRef.current(payload);
          return;
        }
        await playVoice(cancelled);
      });
    };
    onReadyRef.current = onReady;
    const onProcessing = (payload?: { senderId?: string }) => {
      // Recording / translating / sent — sender device only.
      const me = playCtx.current.user?.id;
      if (payload?.senderId && me && payload.senderId !== me) return;
      if (!talkingRef.current && !sendingIds.current.length) return;
      setStatus(playCtx.current.t("translating"));
    };
    const onContactChange = () => {
      const tok = playCtx.current.token;
      if (tok) void fetchTalkContacts(tok).then(setContacts).catch(() => undefined);
    };
    socket.on(SOCKET_EVENTS.PTT_SPEAKING, onSpeaking);
    socket.on(SOCKET_EVENTS.PTT_RELEASED, onReleased);
    socket.on(SOCKET_EVENTS.PTT_FLOOR_BUSY, onBusy);
    socket.on(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
    socket.on(SOCKET_EVENTS.TRANSMISSION_REMOVED, () => {
      const tok = playCtx.current.token;
      if (tok) void fetchUnread(tok).then((info) => setUnreadTotal(info.total)).catch(() => undefined);
    });
    socket.on(SOCKET_EVENTS.TRANSMISSION_PROCESSING, onProcessing);
    socket.on(SOCKET_EVENTS.TRANSMISSION_FAILED, (payload?: { senderId?: string }) => {
      const me = playCtx.current.user?.id;
      if (payload?.senderId && me && payload.senderId !== me) return;
      if (!talkingRef.current && !sendingIds.current.length) return;
      setStatus(playCtx.current.t("txFail"));
    });
    socket.on(SOCKET_EVENTS.CONTACT_REQUEST, onContactChange);
    socket.on(SOCKET_EVENTS.CONTACT_ACCEPTED, onContactChange);
    const onPresence = (payload: { userId?: string; online?: boolean }) => {
      if (!payload.userId) return;
      setOnlineMap((current) => ({ ...current, [payload.userId!]: Boolean(payload.online) }));
    };
    socket.on(SOCKET_EVENTS.PRESENCE, onPresence);
    return () => {
      socket.off(SOCKET_EVENTS.PTT_SPEAKING, onSpeaking);
      socket.off(SOCKET_EVENTS.PTT_RELEASED, onReleased);
      socket.off(SOCKET_EVENTS.PTT_FLOOR_BUSY, onBusy);
      socket.off(SOCKET_EVENTS.TRANSMISSION_READY, onReady);
      socket.off(SOCKET_EVENTS.TRANSMISSION_REMOVED);
      socket.off(SOCKET_EVENTS.TRANSMISSION_PROCESSING, onProcessing);
      socket.off(SOCKET_EVENTS.TRANSMISSION_FAILED);
      socket.off(SOCKET_EVENTS.CONTACT_REQUEST, onContactChange);
      socket.off(SOCKET_EVENTS.CONTACT_ACCEPTED, onContactChange);
      socket.off(SOCKET_EVENTS.PRESENCE, onPresence);
    };
  }, [token, setContacts]);

  useEffect(() => {
    void loadPendingVoice();
    const flush = async () => {
      if (await isInPhoneCall()) return;
      const pending = await takePendingVoice();
      for (const row of pending) queueWaitingRef.current(row);
    };
    const unsubCall = subscribePhoneCall((inCall) => {
      if (!inCall) void flush();
    });
    const subApp = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void flush();
      const tok = playCtx.current.token;
      if (!tok) return;
      const sock = ensureSocket(tok);
      if (!sock.connected) sock.connect();
    });
    return () => {
      unsubCall();
      subApp.remove();
    };
  }, []);

  function walkieStampSort(payload: TransmissionReadyPayload) {
    return Number(payload.readyAt || payload.releasedAt || 0);
  }

  useEffect(() => {
    attachNotificationListeners();
    const unsub = subscribeIncomingPush((payload, opened) => {
      if (opened) {
        void hearOneRef.current(payload);
        return;
      }
      queueWaitingRef.current(payload);
    });
    void takeLastNotification().then((payload) => {
      if (payload) void hearOneRef.current(payload);
    });
    return unsub;
  }, []);

  function pinSender(person: {
    senderId: string;
    senderName?: string | null;
    senderPhone?: string | null;
    senderAvatarUrl?: string | null;
    voiceGender?: "male" | "female" | "child";
  }) {
    const { contacts: list } = playCtx.current;
    const known = list.some((c) => c.matchedUser?.id === person.senderId && c.status === "ACCEPTED");
    const label = incomingLabel(
      {
        senderName: person.senderName || "",
        senderPhone: person.senderPhone || "",
      } as TransmissionReadyPayload,
      known,
    );
    setLiveSpeaker((current) =>
      current?.id === person.senderId
        ? current
        : {
            id: person.senderId,
            name: label || person.senderName || "",
            photo: person.senderAvatarUrl ?? null,
            gender: person.voiceGender ?? "male",
          },
    );
  }

  function openTalk(senderId: string) {
    const onBoard =
      playCtx.current.selectedIds.includes(senderId) || playCtx.current.focusedId === senderId;
    return Boolean(sessionUnlockedRef.current[senderId]) && onBoard && !mutedRef.current[senderId];
  }

  function dropPending(senderId: string) {
    if (!pendingBySenderRef.current[senderId]?.length) return;
    const next = { ...pendingBySenderRef.current };
    delete next[senderId];
    pendingBySenderRef.current = next;
    setPendingBySender(next);
  }

  function queueWaiting(payload: TransmissionReadyPayload) {
    // Never silent-drop. Keep every clip until the user taps the avatar badge.
    if (payload.transmissionId && heardIdsRef.current.has(payload.transmissionId)) return;
    const { t: tr, select: selectPeer } = playCtx.current;
    const label = incomingLabel(payload, false);
    let count = 1;
    setOnlineMap((current) => ({ ...current, [payload.senderId]: true }));
    setPendingBySender((current) => {
      const list = current[payload.senderId] ?? [];
      if (list.some((row) => row.transmissionId === payload.transmissionId)) {
        count = list.length;
        return current;
      }
      const next = [...list, payload].sort(
        (a, b) => walkieStampSort(a) - walkieStampSort(b),
      );
      count = next.length;
      const stored = { ...current, [payload.senderId]: next };
      pendingBySenderRef.current = stored;
      return stored;
    });
    // Put them on the board immediately with the badge — even if not in selectedIds yet.
    selectPeer(payload.senderId, {
      id: payload.senderId,
      name: label || payload.senderName || "",
      photo: payload.senderAvatarUrl,
      gender: payload.voiceGender ?? "male",
    });
    pinSender(payload);
    setLiveSpeaker({
      id: payload.senderId,
      name: label || payload.senderName || "",
      photo: payload.senderAvatarUrl ?? null,
      gender: payload.voiceGender ?? "male",
      pendingCount: count,
    });
    setStatus(tr("voicesWaiting", { count: String(count) }));
    if (payload.audioUrl) {
      void fetch(payload.audioUrl).catch(() => undefined);
    }
  }
  queueWaitingRef.current = queueWaiting;

  async function hearPendingQueue(senderId: string) {
    const queue = pendingBySenderRef.current[senderId] ?? [];
    const payload = queue[0];
    if (!payload) return;
    const rest = queue.slice(1);
    const stored = { ...pendingBySenderRef.current };
    if (rest.length) stored[senderId] = rest;
    else delete stored[senderId];
    pendingBySenderRef.current = stored;
    setPendingBySender(stored);
    await playOne(payload);
  }

  async function playOne(payload: TransmissionReadyPayload) {
    if (payload.transmissionId) heardIdsRef.current.add(payload.transmissionId);
    const { token: tok, user: me, t: tr } = playCtx.current;
    sessionUnlockedRef.current = { ...sessionUnlockedRef.current, [payload.senderId]: true };
    setSessionUnlocked((current) => ({ ...current, [payload.senderId]: true }));
    const label = incomingLabel(payload, true);
    select(payload.senderId, {
      id: payload.senderId,
      name: label,
      photo: payload.senderAvatarUrl,
      gender: payload.voiceGender ?? "male",
    });
    setFocusedId(payload.senderId);
    setSpeakingId(payload.senderId);
    setLiveSpeaker({
      id: payload.senderId,
      name: label,
      photo: payload.senderAvatarUrl ?? null,
      gender: payload.voiceGender ?? "male",
      pendingCount: pendingBySenderRef.current[payload.senderId]?.length ?? 0,
    });
    const line = (payload.translatedText || payload.originalText || "").trim();
    if (line) setWritten(line);
    setStatus("");
    try {
      await playWalkieExclusive(async (cancelled) => {
        if (cancelled()) return;
        await playReceived(payload, hearLang(me, payload.language), tok);
        if (cancelled()) return;
        if (tok && payload.transmissionId) {
          void api(`/transmissions/${payload.transmissionId}/played`, { method: "POST", token: tok });
        }
      });
    } catch {
      setStatus(tr("playFail"));
    } finally {
      setSpeakingId(null);
      // Keep remaining queued clips + badge count (hearPendingQueue already removed the one played).
      const left = pendingBySenderRef.current[payload.senderId]?.length ?? 0;
      setLiveSpeaker((current) =>
        current?.id === payload.senderId ? { ...current, pendingCount: left } : current,
      );
      if (left > 0) setStatus(tr("voicesWaiting", { count: String(left) }));
    }
  }

  async function hearNotified(payload: TransmissionReadyPayload) {
    const list = pendingBySenderRef.current[payload.senderId] ?? [];
    const rest = list.filter((row) => row.transmissionId !== payload.transmissionId);
    if (rest.length !== list.length) {
      const stored = { ...pendingBySenderRef.current };
      if (rest.length) stored[payload.senderId] = rest;
      else delete stored[payload.senderId];
      pendingBySenderRef.current = stored;
      setPendingBySender(stored);
    }
    await playOne(payload);
  }
  hearOneRef.current = hearNotified;

  async function begin() {
    if (talkingRef.current) return;
    const ids = talkIds;
    if (!ids.length) {
      setStatus(t("pickPeople"));
      return;
    }
    try {
      wantEndRef.current = false;
      talkingRef.current = true;
      holdDiscovery(true);
      sendingIds.current = ids;
      setTalking(true);
      setStatus(t("tx"));
      clockRef.current = { press: Date.now() };
      await startRecording();
      if (wantEndRef.current) {
        await end();
        return;
      }
      const unlocked = { ...sessionUnlockedRef.current };
      for (const id of sendingIds.current) unlocked[id] = true;
      sessionUnlockedRef.current = unlocked;
      setSessionUnlocked(unlocked);
      getSocket()?.emit(SOCKET_EVENTS.PTT_START, { targetUserIds: sendingIds.current });
      timer.current = setTimeout(() => void end(), MAX_PTT_MS);
    } catch (e) {
      talkingRef.current = false;
      holdDiscovery(false);
      setTalking(false);
      clockRef.current = null;
      const msg = (e as Error).message || "";
      if (/permission|denied|not granted|מיקרופון|microphone/i.test(msg)) {
        setStatus(msg);
      } else if (!sendingIds.current.length) {
        setStatus(t("pickPeople"));
      } else {
        setStatus(msg || t("txFail"));
      }
    }
  }

  async function end() {
    wantEndRef.current = true;
    if (!talkingRef.current) return;
    talkingRef.current = false;
    holdDiscovery(false);
    if (timer.current) clearTimeout(timer.current);
    setTalking(false);
    setStatus(t("sent"));
    const release = Date.now();
    const holdMs = clockRef.current ? release - clockRef.current.press : 0;
    if (clockRef.current) clockRef.current.release = release;
    clockLog("release", { holdMs });
    const ids = sendingIds.current.length ? sendingIds.current : talkIds;
    getSocket()?.emit(SOCKET_EVENTS.PTT_RELEASED, { targetUserIds: ids });
    let recorded: { uri: string; durationMs: number; peakDb: number } | null = null;
    try {
      recorded = await stopRecording();
    } catch (e) {
      setStatus((e as Error).message || t("txFail"));
      return;
    }
    if (!recorded?.uri || !token) {
      setStatus(t("txFail"));
      return;
    }
    if ((recorded.durationMs ?? 0) < 500) {
      setStatus(t("tooShort"));
      return;
    }
    if (typeof recorded.peakDb === "number" && recorded.peakDb > -159 && recorded.peakDb < -45) {
      setStatus(t("tooShort"));
      return;
    }
    void sendWalkie(recorded, ids, release);
  }

  async function sendWalkie(
    recorded: { uri: string; durationMs: number; peakDb: number },
    ids: string[],
    release: number,
  ) {
    const holdMs = clockRef.current?.press ? release - clockRef.current.press : 0;
    const wav = recorded.uri.toLowerCase().includes(".wav") || recorded.uri.toLowerCase().includes(".caf");
    const form = new FormData();
    form.append("audio", {
      uri: recorded.uri,
      name: wav ? "ptt.wav" : "ptt.m4a",
      type: wav ? "audio/wav" : "audio/m4a",
    } as unknown as Blob);
    form.append("durationMs", String(recorded.durationMs ?? 0));
    form.append("targetUserIds", JSON.stringify(ids));
    form.append("kind", "walkie");
    form.append("releasedAt", String(release));
    try {
      const uploadMark = Date.now();
      await api("/transmissions", { method: "POST", token, body: form });
      clockLog("upload", { uploadMs: Date.now() - uploadMark, holdMs });
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <IncomingOverlay
        payload={incoming}
        onClose={() => {
          setIncoming(null);
          void stopRobot();
          void stopPlayback();
        }}
        onAccept={() => {
          void (async () => {
            if (!incoming || !token) return;
            const payload = incoming;
            setIncoming(null);
            setSessionUnlocked((current) => ({ ...current, [payload.senderId]: true }));
            void api<typeof contacts>("/contacts/accept", {
              method: "POST",
              token,
              body: JSON.stringify({ userId: payload.senderId }),
            })
              .then((list) => setContacts(list.filter((c) => c.matchedUser)))
              .catch(() => undefined);
            try {
              await playReceived(payload, hearLang(user, payload.language), token);
            } catch {
              setStatus(t("acceptFail"));
            }
          })();
        }}
        onDecline={() => {
          void (async () => {
            if (!incoming || !token) return;
            try {
              const list = await api<typeof contacts>("/contacts/block", {
                method: "POST",
                token,
                body: JSON.stringify({ userId: incoming.senderId }),
              });
              setContacts(list.filter((c) => c.matchedUser));
            } catch {
              // ignore
            }
            setIncoming(null);
            void stopRobot();
            void stopPlayback();
          })();
        }}
      />

      <View style={styles.topBar}>
        <Pressable onPress={() => router.push("/search")} style={styles.searchBtn} hitSlop={12}>
          <SearchIcon size={20} />
        </Pressable>
        <Text style={styles.logo}>TALK</Text>
        <Pressable onPress={() => setMenu(true)} style={styles.hamburger} hitSlop={12}>
          <View style={styles.hamLine} />
          <View style={styles.hamLine} />
          <View style={styles.hamLine} />
        </Pressable>
      </View>

      <View style={styles.stage} pointerEvents="box-none">
        <PttButton
          talking={talking}
          onPressIn={() => void begin()}
          onPressOut={() => void end()}
        />
        <SelectedRoster
          speakingId={speakingId}
          focusedId={focusedId}
          activeTalkId={talking ? focusedId || talkIds[0] || null : recordingFromId}
          pendingId={pendingSenderIds[0] ?? null}
          onlineIds={onlineMap}
          people={(() => {
            const list = listedIds.map((id) => {
              const person = talkPeople.find((c) => c.matchedUser?.id === id);
              const snap = snapshots[id];
              const pending = pendingBySender[id]?.[0];
              return {
                id,
                name: personLabel(
                  person?.displayName ||
                    snap?.name ||
                    person?.matchedUser?.displayName ||
                    pending?.senderName ||
                    "",
                  person?.phoneE164 || pending?.senderPhone,
                ),
                photo: person?.matchedUser?.avatarUrl ?? snap?.photo ?? pending?.senderAvatarUrl,
                gender: person?.matchedUser?.voiceGender ?? snap?.gender ?? pending?.voiceGender ?? "male",
                // Always show the real waiting count — never hide the badge behind openTalk.
                pendingCount: pendingCounts[id] ?? 0,
              };
            });
            if (liveSpeaker && !list.some((person) => person.id === liveSpeaker.id)) {
              return [
                {
                  ...liveSpeaker,
                  pendingCount: pendingCounts[liveSpeaker.id] ?? liveSpeaker.pendingCount ?? 0,
                },
                ...list,
              ];
            }
            return list;
          })()}
          onFocus={(id) => {
            if (token) {
              void fetchOnlineIds(token, [id])
                .then((online) => {
                  setOnlineMap((current) => ({ ...current, [id]: online.has(id) }));
                })
                .catch(() => undefined);
            }
            if (!openTalk(id) && pendingBySenderRef.current[id]?.length) {
              void hearPendingQueue(id);
              return;
            }
            sessionUnlockedRef.current = { ...sessionUnlockedRef.current, [id]: true };
            setSessionUnlocked((current) => ({ ...current, [id]: true }));
            setFocusedId(id);
          }}
          mutedIds={muted}
          onToggleMute={(id) => {
            const next = { ...mutedRef.current, [id]: !mutedRef.current[id] };
            if (!next[id]) delete next[id];
            mutedRef.current = next;
            setMuted(next);
            if (!next[id]) {
              sessionUnlockedRef.current = { ...sessionUnlockedRef.current, [id]: true };
              setSessionUnlocked((current) => ({ ...current, [id]: true }));
            }
          }}
          onRemove={(id) => {
            const unlocked = { ...sessionUnlockedRef.current };
            delete unlocked[id];
            sessionUnlockedRef.current = unlocked;
            setSessionUnlocked(unlocked);
            const quiet = { ...mutedRef.current };
            delete quiet[id];
            mutedRef.current = quiet;
            setMuted(quiet);
            const pending = { ...pendingBySenderRef.current };
            delete pending[id];
            pendingBySenderRef.current = pending;
            setPendingBySender(pending);
            if (focusedId === id) setFocusedId(null);
            if (liveSpeaker?.id === id) {
              setLiveSpeaker(null);
              setSpeakingId(null);
            }
            if (everyone) {
              setEveryone(false);
              syncSelected(listedIds.filter((item) => item !== id));
            } else if (selectedIds.includes(id)) {
              toggle(id);
            }
          }}
        />
      </View>

      {written ? <Text style={styles.written}>{written}</Text> : null}
      {busyName ? (
        <Text style={styles.status}>{t("speaking", { name: busyName })}</Text>
      ) : (
        <Text style={status || unreadTotal ? styles.status : styles.hint}>
          {status || (unreadTotal ? t("newMessageWaiting") : t("holdMic"))}
        </Text>
      )}

      <View style={styles.bottomBar}>
        <LabeledAction size={58} label={t("people")} onPress={() => router.push("/search")}>
          <PeopleIcon size={26} />
        </LabeledAction>
        <LabeledAction size={58} label={t("everyone")} active={everyone} onPress={() => setEveryone(!everyone)} />
        <LabeledAction
          size={58}
          label={t("messages")}
          badge={unreadTotal}
          onPress={() => {
            if (token) prefetchHistory(token);
            router.push("/history");
          }}
        >
          <HistoryIcon size={24} />
        </LabeledAction>
        <LabeledAction
          size={58}
          label={speakerOn ? t("speaker") : t("quiet")}
          active={speakerOn}
          onPress={() => {
            setSpeakerOn((on) => {
              const next = !on;
              void setLoudSpeaker(next);
              return next;
            });
          }}
        >
          <SpeakerIcon size={24} color={speakerOn ? "#FFFFFF" : "#B8D4FF"} />
        </LabeledAction>
      </View>

      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenu(false)}>
          <View style={styles.menu}>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                router.push("/settings");
              }}
            >
              <Text style={[styles.menuText, { textAlign: align }]}>{t("settings")}</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                router.push("/history");
              }}
            >
              <Text style={[styles.menuText, { textAlign: align }]}>{t("history")}</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenu(false);
                router.push("/search");
              }}
            >
              <Text style={[styles.menuText, { textAlign: align }]}>{t("searchPeople")}</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={async () => {
                setMenu(false);
                await logout();
                router.replace("/login");
              }}
            >
              <Text style={[styles.menuText, { color: colors.red, textAlign: align }]}>{t("logout")}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16, overflow: "visible" },
  topBar: {
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    direction: "ltr",
  },
  logo: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 3,
  },
  searchBtn: {
    position: "absolute",
    left: 0,
    top: 6,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2.2,
    borderColor: colors.ring,
    alignItems: "center",
    justifyContent: "center",
  },
  hamburger: {
    position: "absolute",
    right: 0,
    top: 8,
    width: 40,
    height: 36,
    justifyContent: "center",
    alignItems: "flex-end",
    gap: 5,
  },
  hamLine: { width: 26, height: 3, backgroundColor: colors.ring, borderRadius: 2 },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    position: "relative",
    direction: "ltr",
  },
  bottomBar: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "flex-start",
    paddingTop: 12,
    paddingBottom: 6,
    overflow: "visible",
    direction: "ltr",
    zIndex: 8,
  },
  status: { color: colors.ring, textAlign: "center", fontSize: 15, fontWeight: "700", marginBottom: 8 },
  written: {
    color: colors.text,
    textAlign: "center",
    fontSize: 20,
    fontWeight: "800",
    marginHorizontal: 24,
    marginBottom: 10,
    lineHeight: 28,
  },
  hint: { color: colors.muted, textAlign: "center", fontSize: 14, marginBottom: 8 },
  menuBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-start",
    alignItems: "flex-end",
  },
  menu: {
    marginTop: 56,
    marginEnd: 12,
    backgroundColor: colors.bgDeep,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.ring,
    minWidth: 180,
    overflow: "hidden",
  },
  menuItem: { paddingVertical: 14, paddingHorizontal: 18 },
  menuText: { color: colors.ring, fontSize: 16, fontWeight: "700" },
});
