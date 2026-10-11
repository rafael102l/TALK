import { PublicUser, SOCKET_EVENTS } from "@talk/shared";
import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, isAuthFailure } from "./api";
import { ensureApiBase } from "./discover";
import { clearHistoryCache } from "./historyCache";
import { clearRecents } from "./recents";
import { clearTalkContactsCache } from "./syncContacts";
import { connectSocket, disconnectSocket, ensureSocket, getSocket, socketAuthToken } from "./socket";

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

let sessionQueue: Promise<void> = Promise.resolve();

function runSession(task: () => Promise<void>) {
  const run = sessionQueue.then(task, task);
  sessionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function clearLocalSession() {
  await runSession(async () => {
    disconnectSocket();
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
  });
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

      let cached: PublicUser | null = null;
      if (rawUser) {
        try {
          const parsed = JSON.parse(rawUser) as PublicUser;
          if (parsed?.id) cached = parsed;
        } catch {
          cached = null;
        }
      }

      // Open from the phone immediately. A sleeping server must not hold the blue screen.
      if (cached) {
        setToken(stored);
        setUser(cached);
        setReady(true);
        void ensureApiBase()
          .then(() => connectSocket(stored))
          .catch(() => undefined);
        void refreshSession(stored);
        return;
      }

      setToken(stored);
      try {
        await ensureApiBase();
        const me = await api<PublicUser>("/users/me", { token: stored, timeoutMs: 8000, once: true });
        setUser(me);
        void SecureStore.setItemAsync(USER_KEY, JSON.stringify(me));
        connectSocket(stored);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (isAuthFailure(message)) {
          await clearLocalSession();
          setToken(null);
          setUser(null);
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  async function refreshSession(stored: string) {
    try {
      const me = await api<PublicUser>("/users/me", { token: stored, timeoutMs: 20000, once: true });
      setUser(me);
      void SecureStore.setItemAsync(USER_KEY, JSON.stringify(me));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!isAuthFailure(message)) return;
      await clearLocalSession();
      setToken(null);
      setUser(null);
    }
  }

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
      const authedAs = socketAuthToken(sock);
      void runSession(async () => {
        if (getSocket() !== sock) return;
        const current = await SecureStore.getItemAsync(TOKEN_KEY);
        if (getSocket() !== sock) return;
        if (!current || (authedAs && current !== authedAs)) return;
        try {
          // Same phone reconnecting still has a valid token. Only a real sign-out invalidates it.
          const me = await api<PublicUser>("/users/me", { token: current, timeoutMs: 15000, once: true });
          setUser(me);
          void SecureStore.setItemAsync(USER_KEY, JSON.stringify(me));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (!isAuthFailure(message)) return;
        }
        if (getSocket() !== sock) return;
        const still = await SecureStore.getItemAsync(TOKEN_KEY);
        if (still && still !== current) return;
        disconnectSocket();
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync(USER_KEY);
        setToken(null);
        setUser(null);
      });
    };
    sock.on(SOCKET_EVENTS.SESSION_REPLACED, onReplaced);
    return () => {
      sock.off(SOCKET_EVENTS.SESSION_REPLACED, onReplaced);
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
        await runSession(async () => {
          await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
          await SecureStore.setItemAsync(USER_KEY, JSON.stringify(nextUser));
          setToken(nextToken);
          setUser(nextUser);
        });
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
