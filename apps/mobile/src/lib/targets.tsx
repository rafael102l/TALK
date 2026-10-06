import { MatchedContact, VoiceGender } from "@talk/shared";
import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { personLabel } from "./personLabel";

const ROSTER_KEY = "talk.roster";

function uniqueContacts(list: MatchedContact[]) {
  const seen = new Set<string>();
  return list.filter((contact) => {
    const key = contact.matchedUser?.id || contact.phoneE164 || contact.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type SelectedPerson = {
  id: string;
  name: string;
  photo?: string | null;
  gender?: VoiceGender;
};

type TargetsState = {
  contacts: MatchedContact[];
  setContacts: (contacts: MatchedContact[]) => void;
  selectedIds: string[];
  snapshots: Record<string, SelectedPerson>;
  everyone: boolean;
  toggle: (userId: string) => void;
  select: (userId: string, person?: SelectedPerson) => void;
  syncSelected: (ids: string[]) => void;
  setEveryone: (value: boolean) => void;
  clear: () => void;
};

const TargetsContext = createContext<TargetsState | null>(null);

export function TargetsProvider({ children }: { children: ReactNode }) {
  const [contacts, setContactsState] = useState<MatchedContact[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, SelectedPerson>>({});
  const [everyone, setEveryone] = useState(false);

  useEffect(() => {
    void SecureStore.deleteItemAsync(ROSTER_KEY).catch(() => undefined);
  }, []);

  const value = useMemo<TargetsState>(
    () => ({
      contacts,
      setContacts: (list) => setContactsState(uniqueContacts(list)),
      selectedIds,
      snapshots,
      everyone,
      setEveryone: (value) => {
        setEveryone(value);
        if (value) {
          const people = uniqueContacts(
            contacts.filter((c) => c.matchedUser && (c.status === "ACCEPTED" || !c.status)),
          );
          setSelectedIds([...new Set(people.map((c) => c.matchedUser!.id))]);
          setSnapshots((current) => {
            const next = { ...current };
            for (const contact of people) {
              const user = contact.matchedUser!;
              next[user.id] = {
                id: user.id,
                name: personLabel(user.displayName || contact.displayName, contact.phoneE164),
                photo: user.avatarUrl,
                gender: user.voiceGender ?? "male",
              };
            }
            return next;
          });
        } else {
          setSelectedIds([]);
        }
      },
      toggle: (userId) => {
        setEveryone(false);
        setSelectedIds((current) => {
          const next = current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId];
          return [...new Set(next)];
        });
      },
      select: (userId, person) => {
        if (!userId) return;
        setEveryone(false);
        setSelectedIds((current) => (current.includes(userId) ? current : [...new Set([...current, userId])]));
        if (person) {
          setSnapshots((current) => ({
            ...current,
            [userId]: { ...person, id: userId, name: personLabel(person.name, undefined) },
          }));
        }
      },
      syncSelected: (ids) => setSelectedIds([...new Set(ids)]),
      clear: () => {
        setEveryone(false);
        setSelectedIds([]);
      },
    }),
    [contacts, selectedIds, snapshots, everyone],
  );

  return <TargetsContext.Provider value={value}>{children}</TargetsContext.Provider>;
}

export function useTargets() {
  const ctx = useContext(TargetsContext);
  if (!ctx) throw new Error("useTargets outside provider");
  return ctx;
}
