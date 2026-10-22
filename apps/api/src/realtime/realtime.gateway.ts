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
import { LiveDubService } from "./live-dub.service";
import { toPublicUser } from "../users/user.mapper";
import { Server, Socket } from "socket.io";
import { loadChannelIds, loadUser } from "../auth/load-user";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload";
import { CallRegistry } from "./call.registry";
import { FloorService } from "./floor.service";
import { PresenceService } from "./presence.service";
import { PushService } from "../push/push.service";

type AuthedSocket = Socket & { userId?: string; displayName?: string; sessionVersion?: number };

@WebSocketGateway({ cors: { origin: true }, maxHttpBufferSize: 8 * 1024 * 1024 })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  /** One replay of missed clips per user. A reconnect loop was re-sending the same three every second. */
  private readonly lastReplayAt = new Map<string, number>();

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly floor: FloorService,
    private readonly storage: StorageService,
    private readonly liveDub: LiveDubService,
    private readonly calls: CallRegistry,
    private readonly push: PushService,
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
      const roomSize = this.roomCount(payload.sub);
      this.logger.log(`socket join user=${payload.sub} sid=${client.id} room=user:${payload.sub} n=${roomSize}`);
      void this.finishConnection(client, payload);
    } catch (error) {
      this.logger.debug(`Socket rejected: ${(error as Error).message}`);
      this.closeSocket(client);
    }
  }

  /**
   * Namespace disconnect. Closing the TCP socket (`disconnect(true)`) looks like a
   * dropped cable, so the phone reconnects about once a second and kicks this socket again.
   */
  private closeSocket(sock: Socket) {
    sock.disconnect(false);
  }

  private async finishConnection(client: AuthedSocket, payload: JwtPayload) {
    try {
      const fresh = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { sessionVersion: true },
      });
      if (!fresh || payload.sv !== fresh.sessionVersion) {
        if (client.connected) {
          client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
          this.closeSocket(client);
        }
        return;
      }
      const user = await loadUser(this.prisma, payload.sub);
      if (!user || !client.connected) return;
      client.join(`user:${user.id}`);
      client.displayName = user.displayName;
      client.sessionVersion = fresh.sessionVersion;
      await this.presence.setOnline(user.id, client.id);
      this.logger.log(`socket ready user=${user.id} sid=${client.id} room=${this.roomCount(user.id)}`);
      const channelIds = await loadChannelIds(this.prisma, user.id);
      for (const channelId of channelIds) client.join(`channel:${channelId}`);
      const chatOnline = this.presence.isChatOnline(user.id);
      if (chatOnline) {
        this.server.emit(SOCKET_EVENTS.PRESENCE, { userId: user.id, online: true });
      }
      this.flushMissedCalls(client);
      this.flushRingingCalls(client);
      this.scheduleReplay(user.id);
    } catch (error) {
      this.logger.debug(`Socket profile delayed: ${(error as Error).message}`);
    }
  }

  /** If the clip was saved while this phone was offline, hand it over once — not on every reconnect. */
  private scheduleReplay(userId: string) {
    const now = Date.now();
    if (now - (this.lastReplayAt.get(userId) ?? 0) < 60_000) return;
    this.lastReplayAt.set(userId, now);
    setTimeout(() => {
      const n = this.server?.sockets?.adapter.rooms.get(`user:${userId}`)?.size ?? 0;
      if (!n) return;
      void this.sendUnplayedWalkies(userId).catch((error: Error) => {
        this.logger.warn(`Walkie replay failed: ${error.message}`);
      });
      void this.sendMissedChat(userId).catch((error: Error) => {
        this.logger.warn(`Chat replay failed: ${error.message}`);
      });
    }, 800);
  }

  private async sendUnplayedWalkies(userId: string) {
    const since = new Date(Date.now() - 2 * 60 * 1000);
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
      include: { transmission: { include: { sender: true, renders: true } } },
      orderBy: { transmission: { createdAt: "asc" } },
      take: 3,
    });
    if (!rows.length) return;
    let delivered = 0;
    for (const row of rows) {
      const tx = row.transmission;
      const sender = toPublicUser(tx.sender);
      const sourceLang = (tx.sender.speakLang || tx.sender.listenLang || "he").slice(0, 2).toLowerCase();
      const hear = (row.language || sourceLang).slice(0, 2).toLowerCase();
      const sameLang = hear === sourceLang;
      const render = tx.renders.find((item) => item.language === hear);
      const audioUrl = sameLang
        ? tx.originalAudioUrl
          ? this.storage.publicUrl(tx.originalAudioUrl)
          : null
        : render?.audioUrl
          ? this.storage.publicUrl(render.audioUrl)
          : null;
      if (!sameLang && !audioUrl) continue;
      const payload = {
        transmissionId: tx.id,
        channelId: tx.channelId,
        senderId: tx.senderId,
        senderName: sender.displayName || tx.sender.phoneE164,
        language: hear,
        speakLang: sourceLang,
        mode: sender.plan === "PLUS" ? "plus" : "free",
        audioUrl,
        originalText: tx.originalText || "",
        translatedText: sameLang ? tx.originalText || "" : render?.translatedText || "",
        durationMs: tx.durationMs,
        usedOriginalVoice: sameLang,
        suppressOriginal: !sameLang,
        needsAccept: false,
        live: false,
        senderPhone: tx.sender.phoneE164,
        senderAvatarUrl: sender.avatarUrl,
        voiceGender: sender.voiceGender ?? "male",
        kind: "walkie" as const,
        viewOnce: false,
        readyAt: tx.createdAt.getTime(),
        releasedAt: tx.createdAt.getTime(),
      };
      if (!this.emitToUser(userId, SOCKET_EVENTS.TRANSMISSION_READY, payload, false)) break;
      delivered += 1;
    }
    if (delivered) this.logger.debug(`Walkie replay user=${userId} count=${delivered}`);
  }

  private async sendMissedChat(userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.transmissionTarget.findMany({
      where: {
        userId,
        playedAt: null,
        transmission: {
          senderId: { not: userId },
          kind: { in: ["text", "voice", "image", "video"] },
          status: "READY",
          createdAt: { gte: since },
        },
      },
      include: { transmission: { include: { sender: true, renders: true } } },
      orderBy: { transmission: { createdAt: "asc" } },
      take: 40,
    });
    if (!rows.length) return;
    let delivered = 0;
    for (const row of rows) {
      const tx = row.transmission;
      const sender = toPublicUser(tx.sender);
      const hear = (row.language || tx.sender.listenLang || "he").slice(0, 2).toLowerCase();
      const sourceLang = (tx.sender.speakLang || tx.sender.listenLang || "he").slice(0, 2).toLowerCase();
      const sameLang = hear === sourceLang;
      const render = tx.renders.find((item) => item.language === hear);
      const kind = (tx.kind === "voice" || tx.kind === "image" || tx.kind === "video" ? tx.kind : "text") as
        | "text"
        | "voice"
        | "image"
        | "video";
      const payload = {
        transmissionId: tx.id,
        channelId: tx.channelId,
        senderId: tx.senderId,
        senderName: sender.displayName || tx.sender.phoneE164,
        language: hear,
        speakLang: sourceLang,
        mode: sender.plan === "PLUS" ? "plus" : "free",
        audioUrl: kind === "text" ? null : this.storage.publicUrl(tx.originalAudioUrl),
        originalText: tx.originalText || "",
        translatedText: sameLang ? tx.originalText || "" : render?.translatedText || tx.originalText || "",
        durationMs: tx.durationMs,
        usedOriginalVoice: sameLang,
        needsAccept: false,
        live: false,
        senderPhone: tx.sender.phoneE164,
        senderAvatarUrl: sender.avatarUrl,
        voiceGender: sender.voiceGender ?? "male",
        kind,
        viewOnce: Boolean(tx.viewOnce),
        readyAt: tx.createdAt.getTime(),
        releasedAt: tx.createdAt.getTime(),
      };
      if (!this.emitToUser(userId, SOCKET_EVENTS.TRANSMISSION_READY, payload, false)) break;
      delivered += 1;
    }
    if (delivered) this.logger.log(`Chat replay user=${userId} count=${delivered}`);
  }

  async handleDisconnect(client: AuthedSocket) {
    this.liveDub.finish(client.id);
    if (!client.userId) return;
    const left = this.server.sockets.adapter.rooms.get(`user:${client.userId}`)?.size ?? 0;
    if (left > 0) return;
    const lastSeen = await this.presence.setOffline(client.userId);
    this.server.emit(SOCKET_EVENTS.PRESENCE, { userId: client.userId, online: false, lastSeen });
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
      this.closeSocket(sock);
    }
  }

  @SubscribeMessage(SOCKET_EVENTS.PRESENCE_APP)
  async appPresence(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { online?: boolean },
  ) {
    if (!client.userId) return { ok: false };
    const active = Boolean(body?.online);
    const lastSeen = await this.presence.setAppActive(client.userId, active);
    const online = this.presence.isChatOnline(client.userId);
    if (active && !online) return { ok: true };
    this.server.emit(SOCKET_EVENTS.PRESENCE, {
      userId: client.userId,
      online,
      lastSeen: lastSeen || undefined,
    });
    return { ok: true };
  }

  @SubscribeMessage("presence:heartbeat")
  async heartbeat(@ConnectedSocket() client: AuthedSocket) {
    if (client.userId) {
      if (!(await this.sessionStillValid(client))) {
        client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
        this.closeSocket(client);
        return { ok: false };
      }
      await this.presence.heartbeat(client.userId, client.id);
    }
    return { ok: true };
  }

  @SubscribeMessage(SOCKET_EVENTS.CHAT_TYPING)
  chatTyping(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { targetUserId?: string; typing?: boolean },
  ) {
    if (!client.userId || !body?.targetUserId) return { ok: false };
    this.emitToUser(
      body.targetUserId,
      SOCKET_EVENTS.CHAT_TYPING,
      { userId: client.userId, typing: Boolean(body.typing) },
      false,
    );
    return { ok: true };
  }

  @SubscribeMessage(SOCKET_EVENTS.CHAT_REACTION)
  chatReaction(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { targetUserId?: string; transmissionId?: string; emoji?: string | null },
  ) {
    if (!client.userId || !body?.targetUserId || !body.transmissionId) return { ok: false };
    this.emitToUser(
      body.targetUserId,
      SOCKET_EVENTS.CHAT_REACTION,
      { userId: client.userId, transmissionId: body.transmissionId, emoji: body.emoji || "" },
      true,
    );
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
      pressId?: string;
      speakLang?: string;
    },
  ) {
    if (!client.userId) return;
    // Named targets are already on the phone. Tell the other phone immediately — do not wait for the database.
    const named = [...new Set((body.targetUserIds ?? []).filter((id) => id && id !== client.userId))];
    const room = named.length
      ? { key: `targets:${[client.userId, ...named].sort().join(",")}`, listenerIds: named }
      : await this.floorRoom(client.userId, body);
    if (!room) return { ok: false, rooms: "" };
    client.join(`user:${client.userId}`);
    this.ensureDub();
    const sentGender =
      body.voiceGender === "female" || body.voiceGender === "child" || body.voiceGender === "male"
        ? body.voiceGender
        : "";
    this.liveDub.open(
      client.id,
      client.userId,
      room.listenerIds.filter((id) => id !== client.userId),
      typeof body.pressId === "string" ? body.pressId : "",
      true,
      sentGender,
    );
    const pressId = typeof body.pressId === "string" ? body.pressId : "";
    if (typeof body.speakLang === "string" && body.speakLang.trim()) {
      this.liveDub.setSpeakerLang(client.id, pressId, body.speakLang);
    }
    const gender = sentGender === "female" || sentGender === "child" ? sentGender : "male";
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
      this.closeSocket(client);
    });
    const peers = room.listenerIds.filter((id) => id !== client.userId);
    const rooms = peers.map((id) => `${id}:${this.roomCount(id)}`).join(",");
    return { ok: true, floorKey: room.key, rooms };
  }

  @SubscribeMessage(SOCKET_EVENTS.PTT_RELEASED)
  async pttReleased(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { channelId?: string; targetUserIds?: string[]; everyone?: boolean; pressId?: string },
  ) {
    if (!client.userId) return;
    this.liveDub.finish(client.id, typeof body.pressId === "string" ? body.pressId : "");
    if (!(await this.sessionStillValid(client))) {
      client.emit(SOCKET_EVENTS.SESSION_REPLACED, { reason: "single_session" });
      this.closeSocket(client);
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

  private audioIn = 0;
  private audioFwd = 0;
  private audioLogAt = 0;
  private audioDropAt = 0;

  @SubscribeMessage(SOCKET_EVENTS.PTT_CLIP)
  pttClip(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody()
    body: { targetUserIds?: string[]; wav?: string; pressId?: string; gender?: string; speakLang?: string; sourceLanguage?: string },
  ) {
    if (!client.userId || typeof body?.wav !== "string") return { ok: false, bytes: 0 };
    if (body.wav.length < 1024 || body.wav.length > 6_000_000) {
      this.logger.warn(`ptt clip drop size=${body.wav.length} user=${client.userId}`);
      return { ok: false, bytes: 0 };
    }
    const targets = [...new Set((body.targetUserIds ?? []).filter((id) => id && id !== client.userId))].slice(0, 32);
    if (!targets.length) return { ok: false, bytes: 0 };
    const wav = Buffer.from(body.wav, "base64");
    client.join(`user:${client.userId}`);
    this.ensureDub();
    const pressId = typeof body.pressId === "string" ? body.pressId : "";
    const gender = body.gender === "female" || body.gender === "child" ? "female" : body.gender === "male" ? "male" : "";
    this.liveDub.open(client.id, client.userId, targets, pressId, false, gender);
    if (gender) this.liveDub.setSpeakerGender(client.id, pressId, gender);
    const sourceLanguage = [body.sourceLanguage, body.speakLang].find((value) => typeof value === "string" && value.trim());
    if (sourceLanguage) this.liveDub.setSpeakerLang(client.id, pressId, sourceLanguage);
    const stored = this.liveDub.setClip(client.id, wav, pressId);
    this.logger.log(`ptt clip from=${client.userId} press=${pressId || "-"} bytes=${wav.length} stored=${stored} gender=${gender || "-"}`);
    return { ok: stored, bytes: wav.length };
  }

  @SubscribeMessage(SOCKET_EVENTS.PTT_AUDIO)
  pttAudio(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { targetUserIds?: string[]; pcm?: string; seq?: number; pressId?: string },
  ) {
    if (!client.userId || typeof body?.pcm !== "string") {
      this.logger.warn(`ptt audio drop bad-body user=${client.userId ?? "?"} type=${typeof body?.pcm}`);
      return { ok: false };
    }
    if (body.pcm.length < 8 || body.pcm.length > 16000) {
      this.logger.warn(`ptt audio drop size=${body.pcm.length} user=${client.userId}`);
      return { ok: false };
    }
    const targets = [...new Set((body.targetUserIds ?? []).filter((id) => id && id !== client.userId))].slice(0, 32);
    if (!targets.length) {
      this.logger.warn(`ptt audio drop no-targets user=${client.userId}`);
      return { ok: false };
    }
    client.join(`user:${client.userId}`);
    this.ensureDub();
    const framePress = typeof body.pressId === "string" ? body.pressId : "";
    if (!this.liveDub.owns(client.id, framePress)) {
      this.liveDub.push(client.id, Buffer.from(body.pcm, "base64"), framePress);
      return { ok: false, forwarded: 0, dub: 0, rooms: "" };
    }
    this.liveDub.open(client.id, client.userId, targets, framePress, false);
    const route = this.liveDub.route(client.id, targets);
    const pcm = Buffer.from(body.pcm, "base64");
    if (route.pending || route.dub) this.liveDub.push(client.id, pcm, framePress);
    const dub = route.dub;
    const payload = { speakerId: client.userId, pcm: body.pcm, seq: body.seq ?? 0 };
    let forwarded = 0;
    for (const userId of route.relay) {
      if (this.emitLive(userId, SOCKET_EVENTS.PTT_AUDIO, payload)) forwarded += 1;
      else this.noteAudioDrop(userId);
    }
    const rooms = targets.map((id) => `${id}:${this.roomCount(id)}`).join(",");
    this.audioIn += 1;
    this.audioFwd += forwarded;
    const now = Date.now();
    if (this.audioIn === 1 || now - this.audioLogAt >= 1000) {
      this.logger.log(
        `ptt audio from=${client.userId} in=${this.audioIn} fwd=${this.audioFwd} dub=${dub} seq=${body.seq ?? 0} bytes=${body.pcm.length} rooms=${rooms}`,
      );
      this.audioLogAt = now;
    }
    return { ok: forwarded > 0 || dub > 0, forwarded, dub, rooms };
  }

  private ensureDub() {
    this.liveDub.attach({
      caption: (userId, payload) => {
        this.emitLive(userId, SOCKET_EVENTS.PTT_CAPTION, payload);
      },
      lock: (userId, speakerId, translate) => {
        this.emitLive(userId, SOCKET_EVENTS.PTT_SPEAKING, {
          channelId: "live",
          speakerId,
          speakerName: "",
          translate,
        });
      },
      pcm: (userId, speakerId, pcm, seq) => {
        this.emitLive(userId, SOCKET_EVENTS.PTT_AUDIO, { speakerId, pcm, seq });
      },
    });
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

  private noteAudioDrop(userId: string) {
    const now = Date.now();
    if (now - this.audioDropAt < 1000) return;
    this.audioDropAt = now;
    this.logger.warn(`ptt audio drop no-socket user=${userId}`);
  }

  private roomCount(userId: string) {
    return this.server?.sockets?.adapter.rooms.get(`user:${userId}`)?.size ?? 0;
  }

  private emitLive(userId: string, event: string, payload: unknown): boolean {
    const room = `user:${userId}`;
    if (!this.server?.sockets) return false;
    if (this.roomCount(userId) > 0) {
      this.server.to(room).emit(event, payload);
      return true;
    }
    let sent = 0;
    for (const sock of this.server.sockets.sockets.values()) {
      const authed = sock as AuthedSocket;
      if (authed.userId !== userId) continue;
      authed.join(room);
      authed.emit(event, payload);
      sent += 1;
    }
    return sent > 0;
  }

  emitToUser(userId: string, event: string, payload: unknown, retry = true): boolean {
    const room = `user:${userId}`;
    if (!this.server?.sockets) {
      this.logger.debug(`Socket server not ready for ${event} user=${userId}`);
      return false;
    }
    const n = this.connectedCount(userId);
    if (!n) {
      this.logger.debug(`No live socket for ${event} user=${userId}`);
      if (
        retry &&
        (event === SOCKET_EVENTS.TRANSMISSION_READY ||
          event === SOCKET_EVENTS.CHAT_REACTION ||
          event === SOCKET_EVENTS.CHAT_RECEIPT ||
          event === "chat:receipt" ||
          event === SOCKET_EVENTS.TRANSMISSION_REMOVED ||
          event === SOCKET_EVENTS.END_CALL ||
          event === SOCKET_EVENTS.REJECT_CALL)
      ) {
        setTimeout(() => this.emitToUser(userId, event, payload, false), 2000);
        setTimeout(() => this.emitToUser(userId, event, payload, false), 8000);
      }
      return false;
    }
    this.server.to(room).emit(event, payload);
    return true;
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

  @SubscribeMessage(SOCKET_EVENTS.CALL_USER)
  async callUser(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { targetUserId?: string; callId?: string; video?: boolean },
  ) {
    if (!client.userId || !(await this.sessionStillValid(client))) return { ok: false };
    const targetUserId = (body?.targetUserId || "").slice(0, 80);
    const callId = (body?.callId || "").slice(0, 80);
    if (!targetUserId || !callId || targetUserId === client.userId) return { ok: false };
    if (this.calls.busy(client.userId) || this.calls.busy(targetUserId)) {
      client.emit(SOCKET_EVENTS.CALL_BUSY, { callId });
      return { ok: false, reason: "busy" };
    }
    const caller = await this.prisma.user.findUnique({
      where: { id: client.userId },
      select: { displayName: true, avatarUrl: true, voiceGender: true, phoneE164: true },
    });
    if (!caller) return { ok: false };
    const incoming = this.incomingBody(callId, client.userId, caller, Boolean(body?.video));
    const socketLive = this.connectedCount(targetUserId) > 0;
    this.logger.log(
      `call-user from=${client.userId} sid=${client.id} to=${targetUserId} callId=${callId} calleeSocket=${String(socketLive)} calleeRoom=${this.roomCount(targetUserId)}`,
    );
    if (!socketLive) void this.push.notifyIncomingCall(targetUserId, incoming);
    const timer = setTimeout(() => this.expireCall(callId), 45_000);
    this.calls.open({
      callId,
      callerId: client.userId,
      calleeId: targetUserId,
      callerName: incoming.callerName,
      callerPhone: incoming.callerPhone,
      callerAvatar: caller.avatarUrl,
      callerGender: caller.voiceGender || "male",
      video: Boolean(body?.video),
      accepted: false,
      timer,
    });
    this.emitToUser(targetUserId, SOCKET_EVENTS.INCOMING_CALL, incoming, false);
    this.logger.log(`call open id=${callId} from=${client.userId} to=${targetUserId} socket=${String(socketLive)}`);
    return { ok: true, callId };
  }

  @SubscribeMessage(SOCKET_EVENTS.ACCEPT_CALL)
  acceptCall(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: { callId?: string }) {
    const call = this.liveCallFor(client.userId, body?.callId);
    if (!call || call.calleeId !== client.userId) return { ok: false };
    call.accepted = true;
    if (call.timer) clearTimeout(call.timer);
    call.timer = undefined;
    this.emitToUser(call.callerId, SOCKET_EVENTS.ACCEPT_CALL, { callId: call.callId }, false);
    return { ok: true };
  }

  @SubscribeMessage(SOCKET_EVENTS.REJECT_CALL)
  rejectCall(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: { callId?: string }) {
    const call = this.liveCallFor(client.userId, body?.callId);
    if (!call) return { ok: false };
    const other = call.callerId === client.userId ? call.calleeId : call.callerId;
    this.calls.end(call.callId);
    this.logger.log(`call reject id=${call.callId} by=${client.userId} other=${other}`);
    this.emitToUser(other, SOCKET_EVENTS.REJECT_CALL, { callId: call.callId }, true);
    this.emitToUser(other, SOCKET_EVENTS.END_CALL, { callId: call.callId, reason: "cancelled" }, false);
    return { ok: true };
  }

  @SubscribeMessage(SOCKET_EVENTS.END_CALL)
  endCall(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { callId?: string; reason?: string },
  ) {
    const call = this.liveCallFor(client.userId, body?.callId) ?? this.calls.get((body?.callId || "").slice(0, 80));
    if (!call || (call.callerId !== client.userId && call.calleeId !== client.userId)) return { ok: false };
    const other = call.callerId === client.userId ? call.calleeId : call.callerId;
    const reason = call.accepted ? "ended" : body?.reason || "cancelled";
    this.calls.end(call.callId);
    this.logger.log(`call end id=${call.callId} by=${client.userId} other=${other}`);
    this.emitToUser(other, SOCKET_EVENTS.END_CALL, { callId: call.callId, reason }, true);
    this.emitToUser(other, SOCKET_EVENTS.REJECT_CALL, { callId: call.callId, reason }, false);
    return { ok: true };
  }

  @SubscribeMessage(SOCKET_EVENTS.CALL_OFFER)
  callOffer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { callId?: string; sdp?: string },
  ) {
    return this.relaySignal(client, body?.callId, SOCKET_EVENTS.CALL_OFFER, { sdp: body?.sdp || "" });
  }

  @SubscribeMessage(SOCKET_EVENTS.CALL_ANSWER)
  callAnswer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { callId?: string; sdp?: string },
  ) {
    return this.relaySignal(client, body?.callId, SOCKET_EVENTS.CALL_ANSWER, { sdp: body?.sdp || "" });
  }

  @SubscribeMessage(SOCKET_EVENTS.CALL_ICE)
  callIce(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { callId?: string; candidate?: unknown },
  ) {
    return this.relaySignal(client, body?.callId, SOCKET_EVENTS.CALL_ICE, { candidate: body?.candidate ?? null });
  }

  private relaySignal(client: AuthedSocket, callId: string | undefined, event: string, extra: object) {
    const call = this.liveCallFor(client.userId, callId);
    if (!call) return { ok: false };
    const other = call.callerId === client.userId ? call.calleeId : call.callerId;
    this.emitToUser(other, event, { callId: call.callId, ...extra }, false);
    return { ok: true };
  }

  private liveCallFor(userId: string | undefined, callId: string | undefined) {
    if (!userId || !callId) return undefined;
    const call = this.calls.get(callId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return undefined;
    return call;
  }

  private connectedCount(userId: string) {
    const room = this.server?.sockets?.adapter.rooms.get(`user:${userId}`);
    if (!room || !this.server?.sockets) return 0;
    let n = 0;
    for (const id of room) {
      if (this.server.sockets.sockets.get(id)?.connected) n += 1;
    }
    return n;
  }

  private flushMissedCalls(client: AuthedSocket) {
    if (!client.userId || !client.connected) return;
    const calls = this.calls.takeMissed(client.userId);
    if (!calls.length) return;
    client.emit(SOCKET_EVENTS.CALL_MISSED_SYNC, { calls });
    this.logger.log(`call missed sync user=${client.userId} n=${calls.length}`);
  }

  private flushRingingCalls(client: AuthedSocket) {
    if (!client.userId || !client.connected) return;
    const call = this.calls.busy(client.userId);
    if (!call || call.calleeId !== client.userId || call.accepted) return;
    client.emit(SOCKET_EVENTS.INCOMING_CALL, {
      callId: call.callId,
      callerName: call.callerName,
      callerPhone: call.callerPhone,
      video: Boolean(call.video),
      caller: {
        id: call.callerId,
        name: call.callerName,
        phone: call.callerPhone,
        avatarUrl: call.callerAvatar,
        gender: call.callerGender,
      },
    });
    this.logger.log(`call ringing sync user=${client.userId} id=${call.callId}`);
  }

  private incomingBody(
    callId: string,
    callerId: string,
    caller: { displayName: string | null; phoneE164: string; avatarUrl: string | null; voiceGender: string | null },
    video = false,
  ) {
    const callerName = caller.displayName || caller.phoneE164;
    const callerPhone = caller.phoneE164;
    return {
      callId,
      callerName,
      callerPhone,
      video,
      caller: {
        id: callerId,
        name: callerName,
        phone: callerPhone,
        avatarUrl: caller.avatarUrl,
        gender: caller.voiceGender || "male",
      },
    };
  }

  private markUnavailable(
    client: AuthedSocket,
    callId: string,
    targetUserId: string,
    caller: { displayName: string | null; phoneE164?: string | null; avatarUrl: string | null; voiceGender: string | null },
  ) {
    this.calls.rememberMissed(targetUserId, {
      callId,
      peerId: client.userId || "",
      peerName: caller.displayName || "",
      avatarUrl: caller.avatarUrl,
      gender: caller.voiceGender || "male",
      at: new Date().toISOString(),
    });
    this.calls.end(callId);
    client.emit(SOCKET_EVENTS.CALL_UNAVAILABLE, { callId, reason: "offline" });
    void this.push.notifyUsers([targetUserId], caller.displayName || caller.phoneE164 || "TALK", "שיחה שלא נענתה", {
      type: "missed-call",
      callId,
      callerId: client.userId || "",
      callerName: caller.displayName || "",
    });
    this.logger.warn(`call unavailable id=${callId} to=${targetUserId} no socket`);
  }

  private expireCall(callId: string) {
    const call = this.calls.get(callId);
    if (!call || call.accepted) return;
    this.calls.end(callId);
    this.emitToUser(call.callerId, SOCKET_EVENTS.END_CALL, { callId, reason: "missed" }, false);
    this.emitToUser(call.calleeId, SOCKET_EVENTS.END_CALL, { callId, reason: "missed" }, false);
    if (this.connectedCount(call.calleeId) === 0) void this.rememberExpiredMiss(call);
    this.logger.log(`call missed id=${callId}`);
  }

  private async rememberExpiredMiss(call: { callId: string; callerId: string; calleeId: string }) {
    const caller = await this.prisma.user.findUnique({
      where: { id: call.callerId },
      select: { displayName: true, avatarUrl: true, voiceGender: true },
    });
    this.calls.rememberMissed(call.calleeId, {
      callId: call.callId,
      peerId: call.callerId,
      peerName: caller?.displayName || "",
      avatarUrl: caller?.avatarUrl ?? null,
      gender: caller?.voiceGender || "male",
      at: new Date().toISOString(),
    });
  }

  private readToken(client: Socket) {
    const auth = client.handshake.auth as { token?: string };
    if (auth?.token) return auth.token.replace(/^Bearer\s+/i, "");
    const header = client.handshake.headers.authorization;
    if (header) return header.replace(/^Bearer\s+/i, "");
    throw new Error("missing token");
  }
}
