import { PublicUser, SOCKET_EVENTS } from "@talk/shared";
import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { ensureApiBase } from "./discover";
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
      if (stored && rawUser) {
        try {
          const cached = JSON.parse(rawUser) as PublicUser;
          if (cached?.id) {
            setToken(stored);
            setUser(cached);
            setReady(true);
            void ensureApiBase().then(() => connectSocket(stored));
            void api<PublicUser>("/users/me", { token: stored })
              .then((me) => {
                setUser(me);
                void SecureStore.setItemAsync(USER_KEY, JSON.stringify(me));
              })
              .catch(() => undefined);
            return;
          }
        } catch {
          /* saved profile was unreadable — ask the server */
        }
      }
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
        if (!message.includes("אין חיבור")) {
          await SecureStore.deleteItemAsync(TOKEN_KEY);
          await SecureStore.deleteItemAsync(USER_KEY);
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
