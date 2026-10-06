import { guessE164, MatchedContact, PhoneLookupResult, PublicUser, VoiceGender } from "@talk/shared";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SearchIcon } from "../src/components/MirsIcons";
import { Avatar } from "../src/components/Avatar";
import { InviteSheet } from "../src/components/InviteSheet";
import { useI18n } from "../src/i18n";
import { api } from "../src/lib/api";
import { useAuth } from "../src/lib/auth";
import { inviteTargetFromQuery, type InviteTarget } from "../src/lib/inviteMessage";
import { clearRecents, loadRecents, pushRecent, type RecentSearch } from "../src/lib/recents";
import { autoSyncContacts, cachedTalkContacts } from "../src/lib/syncContacts";
import { personLabel } from "../src/lib/personLabel";
import { useTargets, type SelectedPerson } from "../src/lib/targets";
import { colors } from "../src/lib/theme";

function matchesQuery(name: string, phone: string | null | undefined, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const digits = q.replace(/\D/g, "");
  const nameHit = name.toLowerCase().includes(q);
  const phoneHit = digits.length >= 2 && (phone ?? "").replace(/\D/g, "").includes(digits);
  return nameHit || phoneHit;
}

function snapOf(
  user: { id: string; displayName?: string | null; avatarUrl?: string | null; voiceGender?: VoiceGender; phoneE164?: string },
  fallbackName?: string,
): SelectedPerson {
  return {
    id: user.id,
    name: personLabel(user.displayName || fallbackName, user.phoneE164),
    photo: user.avatarUrl,
    gender: user.voiceGender ?? "male",
  };
}

export default function SearchScreen() {
  const router = useRouter();
  const { token } = useAuth();
  const { t, align, row } = useI18n();
  const { contacts, setContacts, selectedIds, select } = useTargets();
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [found, setFound] = useState<PublicUser | null>(null);
  const [looking, setLooking] = useState(false);
  const [status, setStatus] = useState("");
  const [inviteTarget, setInviteTarget] = useState<InviteTarget | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [lookupSelf, setLookupSelf] = useState(false);
  const addedFor = useRef<string | null>(null);
  const picking = useRef(false);

  const goBoard = useCallback(() => {
    try {
      router.replace("/home");
    } catch {
      router.push("/home");
    }
  }, [router]);

  const putOnBoard = useCallback(
    (person: SelectedPerson) => {
      if (picking.current) return;
      picking.current = true;
      select(person.id, person);
      goBoard();
      setTimeout(() => {
        picking.current = false;
      }, 500);
    },
    [select, goBoard],
  );

  const addUser = useCallback(
    async (user: PublicUser, goHome: boolean) => {
      if (!token) return;
      select(user.id, snapOf(user));
      if (goHome) goBoard();
      try {
        const list = await api<MatchedContact[]>("/contacts/add", {
          method: "POST",
          token,
          timeoutMs: 8000,
          body: JSON.stringify({ phone: user.phoneE164 }),
        });
        setContacts(list.filter((c) => c.matchedUser && c.status !== "BLOCKED"));
        const rec = await pushRecent({
          userId: user.id,
          displayName: user.displayName || user.phoneE164,
          phoneE164: user.phoneE164,
          avatarUrl: user.avatarUrl,
        });
        setRecents(rec);
        if (!goHome) setStatus(t("addedWait"));
      } catch (e) {
        if (!goHome) setStatus((e as Error).message);
      }
    },
    [token, select, setContacts, goBoard, t],
  );
  const addUserRef = useRef(addUser);
  addUserRef.current = addUser;

  async function acceptUser(userId: string, person: SelectedPerson) {
    putOnBoard(person);
    if (!token) return;
    try {
      const list = await api<MatchedContact[]>("/contacts/accept", {
        method: "POST",
        token,
        timeoutMs: 8000,
        body: JSON.stringify({ userId }),
      });
      setContacts(list.filter((c) => c.matchedUser && c.status !== "BLOCKED"));
    } catch {
      /* already on the board */
    }
  }

  async function declineUser(userId: string) {
    if (!token) return;
    const list = await api<MatchedContact[]>("/contacts/block", {
      method: "POST",
      token,
      body: JSON.stringify({ userId }),
    });
    setContacts(list.filter((c) => c.matchedUser && c.status !== "BLOCKED"));
    setStatus(t("rejected"));
  }

  useFocusEffect(
    useCallback(() => {
      picking.current = false;
      void loadRecents().then(setRecents);
      const cached = cachedTalkContacts();
      if (cached.length) setContacts(cached);
      if (!token) return;
      void autoSyncContacts(token, false, setContacts, true).catch(() => undefined);
    }, [token, setContacts]),
  );

  const incoming = useMemo(() => {
    const seen = new Set<string>();
    return contacts.filter((c) => {
      if (!c.incoming || !c.matchedUser) return false;
      if (seen.has(c.matchedUser.id)) return false;
      seen.add(c.matchedUser.id);
      return true;
    });
  }, [contacts]);
  const talkMatches = useMemo(() => {
    const q = query.trim();
    const source = contacts.filter((c) => c.matchedUser && !c.incoming);
    const byId = new Map<string, (typeof source)[number]>();
    for (const contact of source) {
      const id = contact.matchedUser!.id;
      if (!byId.has(id)) byId.set(id, contact);
    }
    const unique = [...byId.values()];
    if (!q) return unique;
    return unique.filter((c) =>
      matchesQuery(`${c.matchedUser?.displayName ?? ""} ${c.displayName}`, c.phoneE164, q),
    );
  }, [contacts, query]);
  const talkUserIds = useMemo(() => new Set(talkMatches.map((c) => c.matchedUser!.id)), [talkMatches]);
  const recentOnly = useMemo(
    () => recents.filter((item, index) => recents.findIndex((row) => row.userId === item.userId) === index && !talkUserIds.has(item.userId)),
    [recents, talkUserIds],
  );

  useEffect(() => {
    const invite = inviteTargetFromQuery(query);
    setInviteTarget(invite);
    const e164 = guessE164(query);
    if (!e164 || !token) {
      setFound(null);
      setLooking(false);
      setLookupSelf(false);
      return;
    }

    let cancelled = false;
    setLooking(true);
    setLookupSelf(false);
    // Don't clear found until we know — avoids flicker; clear if number changed
    setFound(null);

    const timer = setTimeout(() => {
      void api<PhoneLookupResult>("/contacts/lookup", {
        method: "POST",
        token,
        timeoutMs: 4000,
        body: JSON.stringify({ phone: query }),
      })
        .then(async (result) => {
          if (cancelled) return;
          if (result.self) {
            setFound(null);
            setLookupSelf(true);
            return;
          }
          setLookupSelf(false);
          if (!result.user) {
            setFound(null);
            return;
          }
          setFound(result.user);
          if (addedFor.current === result.user.id) return;
          addedFor.current = result.user.id;
          try {
            await addUserRef.current(result.user, false);
          } catch {
            addedFor.current = null;
          }
        })
        .catch(() => {
          if (cancelled) return;
          setFound(null);
          setLookupSelf(false);
        })
        .finally(() => {
          if (!cancelled) setLooking(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLooking(false);
    };
  }, [query, token]);

  function openRecent(item: RecentSearch) {
    putOnBoard({
      id: item.userId,
      name: personLabel(item.displayName, item.phoneE164),
      photo: item.avatarUrl,
      gender: "male",
    });
    void pushRecent(item).then(setRecents);
  }

  const q = query.trim();
  // Invite as soon as the number is valid and TALK user was not found (don't wait on "looking").
  const canInvite = Boolean(inviteTarget && !found && !lookupSelf && q);

  return (
    <SafeAreaView style={styles.page}>
      <View style={[styles.top, { flexDirection: row }]}>
        <Pressable onPress={goBoard} style={styles.back} hitSlop={10}>
          <Text style={styles.backText}>{t("back")}</Text>
        </Pressable>
        <View style={styles.searchBox}>
          <SearchIcon size={18} />
          <TextInput
            style={[styles.input, { textAlign: align }]}
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setStatus("");
              setInviteOpen(false);
              if (!guessE164(value)) addedFor.current = null;
            }}
            placeholder={t("searchPlaceholder")}
            placeholderTextColor={colors.muted}
            autoCorrect={false}
            keyboardType="default"
          />
        </View>
      </View>

      {looking ? <Text style={[styles.hint, { textAlign: align }]}>{t("looking")}</Text> : null}
      {status ? <Text style={[styles.status, { textAlign: align }]}>{status}</Text> : null}

      <ScrollView keyboardShouldPersistTaps="always" contentContainerStyle={styles.list}>
        {!q ? (
          <>
            {incoming.length ? (
              <Text style={[styles.section, { textAlign: align }]}>{t("requests")}</Text>
            ) : null}
            {incoming.map((contact) => {
              const user = contact.matchedUser!;
              const label = personLabel(user.displayName || contact.displayName, user.phoneE164);
              return (
                <PersonRow
                  key={user.id}
                  name={label}
                  meta={t("wantsSend")}
                  avatarUrl={user.avatarUrl}
                  action={t("accept")}
                  secondary={t("decline")}
                  row={row}
                  align={align}
                  onPress={() => void acceptUser(user.id, snapOf(user, contact.displayName))}
                  onSecondary={() => void declineUser(user.id)}
                />
              );
            })}
            <View style={[styles.sectionRow, { flexDirection: row }]}>
              <Text style={[styles.section, { textAlign: align }]}>{t("recents")}</Text>
              {recentOnly.length ? (
                <Pressable onPress={() => void clearRecents().then(() => setRecents([]))}>
                  <Text style={styles.clear}>{t("clear")}</Text>
                </Pressable>
              ) : null}
            </View>
            {recentOnly.map((item) => (
              <PersonRow
                key={item.userId}
                name={personLabel(item.displayName, item.phoneE164)}
                meta=""
                avatarUrl={item.avatarUrl}
                on={selectedIds.includes(item.userId)}
                action={t("selected")}
                row={row}
                align={align}
                onPress={() => openRecent(item)}
              />
            ))}
            {!recentOnly.length && !talkMatches.length && !incoming.length ? (
              <Text style={styles.empty}>{t("emptyPeople")}</Text>
            ) : null}
            {talkMatches.length ? (
              <Text style={[styles.section, { textAlign: align }]}>{t("inTalk")}</Text>
            ) : null}
            {talkMatches.map((contact) => {
              const user = contact.matchedUser!;
              const label = personLabel(user.displayName || contact.displayName, contact.phoneE164);
              return (
                <PersonRow
                  key={user.id}
                  name={label}
                  meta=""
                  avatarUrl={user.avatarUrl}
                  on={selectedIds.includes(user.id)}
                  action={selectedIds.includes(user.id) ? t("selected") : t("add")}
                  row={row}
                  align={align}
                  onPress={() => putOnBoard(snapOf(user, contact.displayName))}
                />
              );
            })}
          </>
        ) : (
          <>
            {canInvite && inviteTarget ? (
              <>
                <Text style={[styles.section, { textAlign: align }]}>{t("notInContacts")}</Text>
                <PersonRow
                  name={inviteTarget.display}
                  meta=""
                  avatarUrl={null}
                  action={t("invite")}
                  row={row}
                  align={align}
                  onPress={() => setInviteOpen(true)}
                />
              </>
            ) : null}
            {found ? (
              <PersonRow
                name={personLabel(found.displayName, found.phoneE164)}
                meta=""
                avatarUrl={found.avatarUrl}
                on={selectedIds.includes(found.id)}
                action={selectedIds.includes(found.id) ? t("selected") : t("add")}
                row={row}
                align={align}
                onPress={() => void addUser(found, true)}
              />
            ) : null}
            {talkMatches.map((contact) => {
              const user = contact.matchedUser!;
              if (found && user.id === found.id) return null;
              const label = personLabel(user.displayName || contact.displayName, contact.phoneE164);
              return (
                <PersonRow
                  key={user.id}
                  name={label}
                  meta=""
                  avatarUrl={user.avatarUrl}
                  on={selectedIds.includes(user.id)}
                  action={selectedIds.includes(user.id) ? t("selected") : t("add")}
                  row={row}
                  align={align}
                  onPress={() => putOnBoard(snapOf(user, contact.displayName))}
                />
              );
            })}
            {!looking && !found && !talkMatches.length && !canInvite ? (
              <Text style={styles.empty}>{t("nobody")}</Text>
            ) : null}
          </>
        )}
      </ScrollView>
      <InviteSheet target={inviteOpen ? inviteTarget : null} onClose={() => setInviteOpen(false)} />
    </SafeAreaView>
  );
}

function PersonRow({
  name,
  meta,
  avatarUrl,
  on,
  action,
  secondary,
  row,
  align,
  onPress,
  onSecondary,
}: {
  name: string;
  meta: string;
  avatarUrl?: string | null;
  on?: boolean;
  action: string;
  secondary?: string;
  row: "row" | "row-reverse";
  align: "left" | "right";
  onPress: () => void;
  onSecondary?: () => void;
}) {
  return (
    <Pressable
      style={[styles.row, { flexDirection: row }, on && styles.rowOn]}
      onPress={onPress}
      delayPressIn={0}
      android_ripple={{ color: "rgba(255,255,255,0.18)" }}
    >
      <Avatar uri={avatarUrl} name={name} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.name, { textAlign: align }]}>{name}</Text>
        {meta ? <Text style={[styles.meta, { textAlign: align }]}>{meta}</Text> : null}
      </View>
      {secondary && onSecondary ? (
        <Pressable onPress={onSecondary} hitSlop={8}>
          <Text style={styles.decline}>{secondary}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.pick}>{action}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  top: { alignItems: "center", gap: 8, marginBottom: 10 },
  back: {
    borderWidth: 2,
    borderColor: colors.ring,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backText: { color: colors.ring, fontWeight: "700" },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 2,
    borderColor: colors.ring,
    borderRadius: 22,
    paddingHorizontal: 12,
    backgroundColor: "rgba(0,0,0,0.15)",
  },
  input: { flex: 1, color: colors.text, fontSize: 18, paddingVertical: 10 },
  hint: { color: colors.muted, marginBottom: 6 },
  status: { color: colors.ring, fontWeight: "700", marginBottom: 6 },
  list: { gap: 8, paddingBottom: 32 },
  sectionRow: { justifyContent: "space-between", alignItems: "center" },
  section: { color: colors.ring, fontWeight: "800", marginTop: 8 },
  clear: { color: colors.muted, fontWeight: "700" },
  empty: { color: colors.muted, textAlign: "center", marginTop: 20, lineHeight: 22 },
  row: {
    alignItems: "center",
    gap: 12,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.4)",
    borderRadius: 18,
    padding: 12,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  rowOn: { borderColor: colors.ring, backgroundColor: "rgba(255,255,255,0.16)" },
  name: { color: colors.text, fontSize: 16, fontWeight: "800" },
  meta: { color: colors.muted, marginTop: 3 },
  pick: { color: colors.ring, fontWeight: "800" },
  decline: { color: colors.muted, fontWeight: "700", marginLeft: 8 },
});
