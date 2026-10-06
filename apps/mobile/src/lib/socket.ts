import { SOCKET_EVENTS } from "@talk/shared";
import { io, Socket } from "socket.io-client";
import { getApiBase } from "./api";
import { onApiBase } from "./discover";

let socket: Socket | null = null;
let socketToken: string | null = null;
let socketBase: string | null = null;

export function connectSocket(token: string) {
  const base = getApiBase();
  if (socket && socketToken === token && socketBase === base) {
    if (!socket.connected) socket.connect();
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
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 400,
    reconnectionDelayMax: 3000,
    timeout: 8000,
  });
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

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
  socketToken = null;
  socketBase = null;
}

export { SOCKET_EVENTS };
