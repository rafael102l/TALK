import { SOCKET_EVENTS } from "@talk/shared";
import { AppState } from "react-native";
import { io, Socket } from "socket.io-client";
import { getApiBase } from "./api";
import { onApiBase } from "./discover";
import { bindLiveSocket } from "./liveTalk";
import { notePresence } from "./presence";

let socket: Socket | null = null;
let socketToken: string | null = null;
let socketBase: string | null = null;
/** True only after logout / session replace. A Render restart must not leave the phone offline. */
let stayDown = false;
const socketAuth = new WeakMap<Socket, string>();

export function socketAuthToken(sock: Socket) {
  return socketAuth.get(sock) ?? null;
}

export function connectSocket(token: string) {
  const base = getApiBase();
  if (socket && socketToken === token && socketBase === base) {
    socketAuth.set(socket, token);
    bindLiveSocket(socket);
    if (!socket.connected && !stayDown) socket.connect();
    else if (socket.connected) {
      socket.emit(SOCKET_EVENTS.PRESENCE_APP, { online: AppState.currentState === "active" });
    }
    return socket;
  }
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socketToken = token;
  socketBase = base;
  socket = io(base, {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 250,
    reconnectionDelayMax: 2000,
    timeout: 45000,
  });
  stayDown = false;
  socket.on("disconnect", (reason) => {
    console.log(`[call sock] disconnect ${reason}`);
  });
  socket.on("connect", () => {
    stayDown = false;
    console.log(`[call sock] connected sid=${socket?.id ?? "-"} base=${base}`);
    socket?.emit("presence:heartbeat");
    socket?.emit(SOCKET_EVENTS.PRESENCE_APP, { online: AppState.currentState === "active" });
  });
  socket.on("connect_error", (error) => {
    console.log(`[call sock] connect_error ${(error as Error).message} base=${base}`);
  });
  socket.on(SOCKET_EVENTS.PRESENCE, notePresence);
  socketAuth.set(socket, token);
  bindLiveSocket(socket);
  return socket;
}

/** Open the socket again after the app returns to the foreground. */
export function resumeSocket() {
  stayDown = false;
  if (socket && !socket.connected) socket.connect();
  return socket;
}

export function getSocket() {
  return socket;
}

export function ensureSocket(token: string) {
  return connectSocket(token);
}

onApiBase((url) => {
  if (socketToken && socketBase !== url) connectSocket(socketToken);
  void url;
});

setInterval(() => {
  if (!socket || !socketToken || stayDown || socket.connected) return;
  socket.connect();
}, 2000);

setInterval(() => {
  if (socket?.connected) socket.emit("presence:heartbeat");
}, 40000);

export function disconnectSocket() {
  stayDown = true;
  socket?.disconnect();
  socket = null;
  socketToken = null;
  socketBase = null;
}

export { SOCKET_EVENTS };
