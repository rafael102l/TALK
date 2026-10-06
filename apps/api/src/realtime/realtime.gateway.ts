import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { PttSpeakingPayload, SOCKET_EVENTS } from "@talk/shared";
import { toPublicUser } from "../users/user.mapper";
import { Server, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload";
import { FloorService } from "./floor.service";
import { PresenceService } from "./presence.service";

type AuthedSocket = Socket & { userId?: string; displayName?: string; sessionVersion?: number };

@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly floor: FloorService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    try {
      const token = this.readToken(client);
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new Error("no user");
      if (typeof payload.sv !== "number" || payload.sv !== user.sessionVersion) {
        throw new Error("session replaced");
      }
      client.userId = user.id;
      client.displayName = user.displayName;
      client.sessionVersion = user.sessionVersion;
      // Join first so a forced disconnect of older sockets won't clear presence.
      client.join(`user:${user.id}`);
      this.revokeUserSessions(user.id, client.id);
      await this.presence.setOnline(user.id, client.id);
      const memberships = await this.prisma.channelMember.findMany({
        where: { userId: user.id },
        select: { channelId: true },
      });
      for (const m of memberships) client.join(`channel:${m.channelId}`);
      const roomSize = this.server.sockets.adapter.rooms.get(`user:${user.id}`)?.size ?? 1;
      this.logger.log(
        `Socket online user=${user.displayName || user.id} room=user:${user.id} sockets=${roomSize}`,
      );
      this.server.emit(SOCKET_EVENTS.PRESENCE, { userId: user.id, online: true });
    } catch (error) {
      this.logger.warn(`Socket rejected: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AuthedSocket) {
    if (!client.userId) return;
    const left = this.server.sockets.adapter.rooms.get(`user:${client.userId}`)?.size ?? 0;
    if (left > 0) return;
    await this.presence.setOffline(client.userId);
    this.server.emit(SOCKET_EVENTS.PRESENCE, { userId: client.userId, online: false });
  }

  /** Disconnect every live socket for this user (optionally keep one). */
  revokeUserSessions(userId: string, exceptSocketId?: string) {
    if (!this.server?.sockets) return;
    const room = this.server.sockets.adapter.rooms.get(`user:${userId}`);
    if (!room?.size) return;
    for (const sid of [...room]) {
      if (exceptSocketId && sid === exceptSocketId) continue;
      const sock = this.server.sockets.sockets.get(sid) as AuthedSocket | undefined;
      if (!sock) continue;
      sock.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
      sock.disconnect(true);
    }
  }

  @SubscribeMessage("presence:heartbeat")
  async heartbeat(@ConnectedSocket() client: AuthedSocket) {
    if (client.userId) {
      if (!(await this.sessionStillValid(client))) {
        client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
        client.disconnect(true);
        return { ok: false };
      }
      await this.presence.heartbeat(client.userId, client.id);
    }
    return { ok: true };
  }

  @SubscribeMessage(SOCKET_EVENTS.PTT_START)
  async pttStart(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { channelId?: string; targetUserIds?: string[]; everyone?: boolean },
  ) {
    if (!client.userId) return;
    if (!(await this.sessionStillValid(client))) {
      client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
      client.disconnect(true);
      return { ok: false };
    }
    const room = await this.floorRoom(client.userId, body);
    if (!room) return { ok: false };
    const speaker = await this.prisma.user.findUnique({ where: { id: client.userId } });
    const pub = speaker ? toPublicUser(speaker) : null;
    const payload: PttSpeakingPayload = {
      channelId: room.key,
      speakerId: client.userId,
      speakerName: pub?.displayName || client.displayName || "דובר",
      speakerAvatarUrl: pub?.avatarUrl ?? null,
      voiceGender: pub?.voiceGender ?? "male",
    };
    for (const userId of room.listenerIds) {
      if (userId === client.userId) continue;
      this.emitToUser(userId, SOCKET_EVENTS.PTT_SPEAKING, payload);
    }
    return { ok: true, floorKey: room.key };
  }

  @SubscribeMessage(SOCKET_EVENTS.PTT_RELEASED)
  async pttReleased(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { channelId?: string; targetUserIds?: string[]; everyone?: boolean },
  ) {
    if (!client.userId) return;
    if (!(await this.sessionStillValid(client))) {
      client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
      client.disconnect(true);
      return { ok: false };
    }
    const room = await this.floorRoom(client.userId, body);
    if (!room) return;
    await this.floor.release(room.key, client.userId);
    for (const userId of room.listenerIds) {
      if (userId === client.userId) continue;
      this.emitToUser(userId, SOCKET_EVENTS.PTT_RELEASED, {
        channelId: room.key,
        speakerId: client.userId,
      });
    }
    return { ok: true };
  }

  private async floorRoom(
    senderId: string,
    body: { channelId?: string; targetUserIds?: string[]; everyone?: boolean },
  ) {
    if (body.everyone) {
      const matches = await this.prisma.contact.findMany({
        where: { ownerId: senderId, matchedUserId: { not: null } },
        select: { matchedUserId: true },
      });
      const listenerIds = matches
        .map((m) => m.matchedUserId)
        .filter((id): id is string => Boolean(id));
      return { key: `everyone:${senderId}`, listenerIds: [...listenerIds, senderId] };
    }
    if (body.targetUserIds?.length) {
      const listenerIds = [...new Set(body.targetUserIds.filter((id) => id !== senderId))];
      const key = `targets:${[senderId, ...listenerIds].sort().join(",")}`;
      return { key, listenerIds: [...listenerIds, senderId] };
    }
    if (body.channelId && body.channelId !== "pending") {
      const member = await this.prisma.channelMember.findUnique({
        where: { channelId_userId: { channelId: body.channelId, userId: senderId } },
      });
      if (!member) return null;
      const members = await this.prisma.channelMember.findMany({
        where: { channelId: body.channelId },
      });
      return { key: body.channelId, listenerIds: members.map((m) => m.userId) };
    }
    return null;
  }

  joinChannel(userId: string, channelId: string) {
    this.server.in(`user:${userId}`).socketsJoin(`channel:${channelId}`);
  }

  emitToUser(userId: string, event: string, payload: unknown) {
    const room = `user:${userId}`;
    const n = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
    if (!n) {
      this.logger.warn(`No live socket for ${event} user=${userId}`);
      return;
    }
    if (n > 1) {
      // Should not happen after single-session enforcement — keep only the newest.
      this.logger.warn(`Multiple sockets in ${room} (n=${n}) — revoking extras`);
      const ids = [...(this.server.sockets.adapter.rooms.get(room) ?? [])];
      const keep = ids[ids.length - 1];
      this.revokeUserSessions(userId, keep);
    }
    this.server.to(room).emit(event, payload);
  }

  emitToChannel(channelId: string, event: string, payload: unknown) {
    this.server.to(`channel:${channelId}`).emit(event, payload);
  }

  private async sessionStillValid(client: AuthedSocket) {
    if (!client.userId || typeof client.sessionVersion !== "number") return false;
    const user = await this.prisma.user.findUnique({
      where: { id: client.userId },
      select: { sessionVersion: true },
    });
    return Boolean(user && user.sessionVersion === client.sessionVersion);
  }

  private readToken(client: Socket) {
    const auth = client.handshake.auth as { token?: string };
    if (auth?.token) return auth.token.replace(/^Bearer\s+/i, "");
    const header = client.handshake.headers.authorization;
    if (header) return header.replace(/^Bearer\s+/i, "");
    throw new Error("missing token");
  }
}
