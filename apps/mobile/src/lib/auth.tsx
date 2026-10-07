import { PublicUser, SOCKET_EVENTS } from "@talk/shared";
import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, isAuthFailure } from "./api";
import { ensureApiBase } from "./discover";
import { clearHistoryCache } from "./historyCache";
import { clearRecents } from "./recents";
import { clearTalkContactsCache } from "./syncContacts";
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

async function clearLocalSession() {
  disconnectSocket();
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}

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

      // Optimistic restore — stay signed in across app restarts without re-OTP.
      let cached: PublicUser | null = null;
      if (rawUser) {
        try {
          cached = JSON.parse(rawUser) as PublicUser;
          if (cached?.id) {
            setToken(stored);
            setUser(cached);
          }
        } catch {
          cached = null;
        }
      } else {
        setToken(stored);
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
        // Only wipe local session when the server explicitly replaced/invalidated it.
        // Network blips keep you signed in (WhatsApp-style).
        if (!offline && isAuthFailure(message)) {
          await clearLocalSession();
          setToken(null);
          setUser(null);
        } else if (cached?.id) {
          setToken(stored);
          setUser(cached);
          void ensureApiBase().then(() => connectSocket(stored)).catch(() => undefined);
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
        await clearLocalSession();
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
        const current = token;
        try {
          if (current) {
            await api("/auth/logout", { method: "POST", token: current });
          }
        } catch {
          // Still clear locally even if the server call fails.
        }
        await clearLocalSession();
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
