import { PublicUser, SOCKET_EVENTS } from "@talk/shared";
import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { ensureApiBase } from "./discover";
import { clearHistoryCache } from "./historyCache";
import { clearRecents } from "./recents";
import { clearTalkContactsCache } from "./syncContacts";
import { AppState } from "react-native";
import { connectSocket, disconnectSocket, ensureSocket, getSocket } from "./socket";

const TOKEN_KEY = "talk.jwt";
const USER_KEY = "talk.user";

type AuthState = {
  ready: boolean;
  token: string | null;
  user: PublicUser | null;
  login: (token: string, user: PublicUser) => Promise<void>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: PublicUser) => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    (async () => {
      const [stored, rawUser] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ]);
      if (!stored) {
        setReady(true);
        return;
      }
      try {
        await ensureApiBase();
        const me = await api<PublicUser>("/users/me", { token: stored });
        setToken(stored);
        setUser(me);
        void SecureStore.setItemAsync(USER_KEY, JSON.stringify(me));
        connectSocket(stored);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const offline = message.includes("אין חיבור");
        // Stale JWT after Render DB reset / session replace — force clean login.
        if (!offline) {
          disconnectSocket();
          await SecureStore.deleteItemAsync(TOKEN_KEY);
          await SecureStore.deleteItemAsync(USER_KEY);
          setToken(null);
          setUser(null);
        } else if (rawUser) {
          try {
            const cached = JSON.parse(rawUser) as PublicUser;
            if (cached?.id) {
              setToken(stored);
              setUser(cached);
            }
          } catch {
            /* ignore bad cache */
          }
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && token) {
        void ensureApiBase().then(() => {
          const sock = ensureSocket(token);
          if (!sock.connected) sock.connect();
        });
      }
    });
    return () => sub.remove();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const sock = ensureSocket(token);
    const onReplaced = () => {
      void (async () => {
        disconnectSocket();
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync(USER_KEY);
        setToken(null);
        setUser(null);
      })();
    };
    sock.on(SOCKET_EVENTS.SESSION_REPLACED, onReplaced);
    return () => {
      getSocket()?.off(SOCKET_EVENTS.SESSION_REPLACED, onReplaced);
    };
  }, [token]);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      token,
      user,
      setUser,
      async login(nextToken, nextUser) {
        // Drop peer IDs/history from a previous server (e.g. LAN → Render).
        clearHistoryCache();
        clearTalkContactsCache();
        await clearRecents().catch(() => undefined);
        await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
        await SecureStore.setItemAsync(USER_KEY, JSON.stringify(nextUser));
        setToken(nextToken);
        setUser(nextUser);
        await ensureApiBase();
        connectSocket(nextToken);
      },
      async refresh() {
        if (!token) return;
        const me = await api<PublicUser>("/users/me", { token });
        setUser(me);
        void SecureStore.setItemAsync(USER_KEY, JSON.stringify(me));
      },
      async logout() {
        disconnectSocket();
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync(USER_KEY);
        setToken(null);
        setUser(null);
      },
    }),
    [ready, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
