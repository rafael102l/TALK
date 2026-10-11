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
import { StorageService } from "../storage/storage.service";
import { toPublicUser } from "../users/user.mapper";
import { Server, Socket } from "socket.io";
import { loadChannelIds, loadUser } from "../auth/load-user";
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
    private readonly storage: StorageService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    try {
      const token = this.readToken(client);
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      // Join before any database call. A slow database was dropping the phone,
      // so the recording was saved with nobody there to receive it.
      client.userId = payload.sub;
      client.displayName = payload.phone;
      client.sessionVersion = payload.sv;
      client.join(`user:${payload.sub}`);
      this.revokeUserSessions(payload.sub, client.id, false);
      const roomSize = this.server.sockets.adapter.rooms.get(`user:${payload.sub}`)?.size ?? 1;
      this.logger.log(`Socket online user=${payload.sub} room=user:${payload.sub} sockets=${roomSize}`);
      this.replayWalkies(payload.sub);
      void this.finishConnection(client, payload);
    } catch (error) {
      this.logger.warn(`Socket rejected: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  private async finishConnection(client: AuthedSocket, payload: JwtPayload) {
    try {
      const user = await loadUser(this.prisma, payload.sub);
      if (!user || payload.sv !== user.sessionVersion) {
        client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
        client.disconnect(true);
        return;
      }
      client.displayName = user.displayName;
      client.sessionVersion = user.sessionVersion;
      await this.presence.setOnline(user.id, client.id);
      const channelIds = await loadChannelIds(this.prisma, user.id);
      for (const channelId of channelIds) client.join(`channel:${channelId}`);
      this.server.emit(SOCKET_EVENTS.PRESENCE, { userId: user.id, online: true });
    } catch (error) {
      this.logger.warn(`Socket profile delayed: ${(error as Error).message}`);
    }
  }

  /** If the clip was saved while this phone was offline, hand it over once the socket is up. */
  private replayWalkies(userId: string) {
    setTimeout(() => {
      void this.sendUnplayedWalkies(userId).catch((error: Error) => {
        this.logger.warn(`Walkie replay failed: ${error.message}`);
      });
    }, 200);
  }

  private async sendUnplayedWalkies(userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.transmissionTarget.findMany({
      where: {
        userId,
        playedAt: null,
        transmission: {
          senderId: { not: userId },
          kind: "walkie",
          status: "READY",
          createdAt: { gte: since },
        },
      },
      include: { transmission: { include: { sender: true } } },
      orderBy: { transmission: { createdAt: "asc" } },
      take: 8,
    });
    if (!rows.length) return;
    for (const row of rows) {
      const tx = row.transmission;
      const sender = toPublicUser(tx.sender);
      const lang = row.language || sender.speakLang || "he";
      this.emitToUser(userId, SOCKET_EVENTS.TRANSMISSION_READY, {
        transmissionId: tx.id,
        channelId: tx.channelId,
        senderId: tx.senderId,
        senderName: sender.displayName || tx.sender.phoneE164,
        language: lang,
        speakLang: lang,
        mode: sender.plan === "PLUS" ? "plus" : "free",
        audioUrl: tx.originalAudioUrl ? this.storage.publicUrl(tx.originalAudioUrl) : null,
        originalText: "",
        translatedText: "",
        durationMs: tx.durationMs,
        usedOriginalVoice: true,
        needsAccept: false,
        live: false,
        senderPhone: tx.sender.phoneE164,
        senderAvatarUrl: sender.avatarUrl,
        voiceGender: sender.voiceGender ?? "male",
        kind: "walkie",
        viewOnce: false,
        readyAt: tx.createdAt.getTime(),
        releasedAt: tx.createdAt.getTime(),
      });
    }
    this.logger.log(`Walkie replay user=${userId} count=${rows.length}`);
  }

  async handleDisconnect(client: AuthedSocket) {
    if (!client.userId) return;
    const left = this.server.sockets.adapter.rooms.get(`user:${client.userId}`)?.size ?? 0;
    if (left > 0) return;
    await this.presence.setOffline(client.userId);
    this.server.emit(SOCKET_EVENTS.PRESENCE, { userId: client.userId, online: false });
  }

  /**
   * Disconnect every other live socket for this user.
   * notify=true only for a real logout or a new sign-in (session version changed).
   * A plain reconnect must not tell the phone to forget its saved login.
   */
  revokeUserSessions(userId: string, exceptSocketId?: string, notify = true) {
    if (!this.server?.sockets) return;
    const room = this.server.sockets.adapter.rooms.get(`user:${userId}`);
    if (!room?.size) return;
    for (const sid of [...room]) {
      if (exceptSocketId && sid === exceptSocketId) continue;
      const sock = this.server.sockets.sockets.get(sid) as AuthedSocket | undefined;
      if (!sock) continue;
      if (notify) sock.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
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
    @MessageBody()
    body: {
      channelId?: string;
      targetUserIds?: string[];
      everyone?: boolean;
      speakerName?: string;
      speakerAvatarUrl?: string | null;
      voiceGender?: "male" | "female" | "child";
    },
  ) {
    if (!client.userId) return;
    // Named targets are already on the phone. Tell the other phone immediately — do not wait for the database.
    const named = [...new Set((body.targetUserIds ?? []).filter((id) => id && id !== client.userId))];
    const room = named.length
      ? { key: `targets:${[client.userId, ...named].sort().join(",")}`, listenerIds: named }
      : await this.floorRoom(client.userId, body);
    if (!room) return { ok: false };
    const gender = body.voiceGender === "female" || body.voiceGender === "child" ? body.voiceGender : "male";
    const payload: PttSpeakingPayload = {
      channelId: room.key,
      speakerId: client.userId,
      speakerName: body.speakerName || client.displayName || "דובר",
      speakerAvatarUrl: body.speakerAvatarUrl ?? null,
      voiceGender: gender,
    };
    for (const userId of room.listenerIds) {
      if (userId === client.userId) continue;
      this.emitToUser(userId, SOCKET_EVENTS.PTT_SPEAKING, payload);
    }
    void this.sessionStillValid(client).then((ok) => {
      if (ok) return;
      client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
      client.disconnect(true);
    });
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
    if (!this.server?.sockets) return;
    this.server.in(`user:${userId}`).socketsJoin(`channel:${channelId}`);
  }

  emitToUser(userId: string, event: string, payload: unknown, retry = true) {
    const room = `user:${userId}`;
    if (!this.server?.sockets) {
      this.logger.warn(`Socket server not ready for ${event} user=${userId}`);
      return;
    }
    const n = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
    if (!n) {
      this.logger.warn(`No live socket for ${event} user=${userId}`);
      if (retry && event === SOCKET_EVENTS.TRANSMISSION_READY) {
        setTimeout(() => this.emitToUser(userId, event, payload, false), 1000);
      }
      return;
    }
    if (n > 1) {
      // Should not happen after single-session enforcement — keep only the newest.
      this.logger.warn(`Multiple sockets in ${room} (n=${n}) — dropping extras`);
      const ids = [...(this.server.sockets.adapter.rooms.get(room) ?? [])];
      const keep = ids[ids.length - 1];
      this.revokeUserSessions(userId, keep, false);
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
