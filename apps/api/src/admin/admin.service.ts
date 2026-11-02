import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";
import { CallRegistry } from "../realtime/call.registry";
import { PresenceService } from "../realtime/presence.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { adminTokenConfigured, adminTokensMatch } from "./admin.guard";

type AuthedSocket = Socket & { userId?: string; displayName?: string };

const EVENT_TAKE = 40;

@Injectable()
export class AdminService {
  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly presence: PresenceService,
    private readonly calls: CallRegistry,
    private readonly prisma: PrismaService,
  ) {}

  assertToken(given: string) {
    const expected = adminTokenConfigured();
    if (!expected) {
      throw new ServiceUnavailableException("ADMIN_DASHBOARD_TOKEN is not set");
    }
    const cleaned = given.trim().replace(/^["']|["']$/g, "").trim();
    if (!adminTokensMatch(cleaned, expected)) {
      throw new UnauthorizedException("Invalid admin token");
    }
  }

  async snapshot() {
    const io = this.gateway.server;
    const sockets = io?.sockets?.sockets ? ([...io.sockets.sockets.values()] as AuthedSocket[]) : [];
    const connectedIds = [...new Set(sockets.map((sock) => sock.userId).filter(Boolean))] as string[];

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const channelRooms = this.readChannelRooms(io);
    const channelIds = channelRooms.map((room) => room.id);
    const [users, channels, events, usersTotal, eventsLastHour] = await Promise.all([
      connectedIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: connectedIds } },
            select: { id: true, displayName: true, phoneE164: true, speakLang: true, listenLang: true },
          })
        : Promise.resolve([]),
      channelIds.length
        ? this.prisma.channel.findMany({
            where: { id: { in: channelIds } },
            select: { id: true, name: true, type: true, _count: { select: { members: true } } },
          })
        : Promise.resolve([]),
      this.prisma.transmission.findMany({
        orderBy: { createdAt: "desc" },
        take: EVENT_TAKE,
        select: {
          id: true,
          kind: true,
          status: true,
          originalText: true,
          durationMs: true,
          createdAt: true,
          sender: { select: { id: true, displayName: true, phoneE164: true } },
          channel: { select: { id: true, name: true, type: true } },
          _count: { select: { targets: true } },
        },
      }),
      this.prisma.user.count(),
      this.prisma.transmission.count({ where: { createdAt: { gte: hourAgo } } }),
    ]);

    const byUser = new Map(users.map((user) => [user.id, user]));
    const socketCounts = new Map<string, number>();
    for (const sock of sockets) {
      if (!sock.userId) continue;
      socketCounts.set(sock.userId, (socketCounts.get(sock.userId) ?? 0) + 1);
    }

    const connected = connectedIds.map((id) => {
      const user = byUser.get(id);
      return {
        id,
        name: user?.displayName || "—",
        phone: user?.phoneE164 || "",
        speakLang: user?.speakLang || "",
        listenLang: user?.listenLang || "",
        sockets: socketCounts.get(id) ?? 1,
        appOpen: this.presence.isChatOnline(id),
      };
    });

    const channelMeta = new Map(channels.map((row) => [row.id, row]));
    const rooms = channelRooms
      .map((room) => {
        const meta = channelMeta.get(room.id);
        return {
          id: room.id,
          name: meta?.name || room.id.slice(0, 8),
          type: meta?.type || "CHANNEL",
          connected: room.connected,
          members: meta?._count.members ?? room.connected,
        };
      })
      .sort((a, b) => b.connected - a.connected);

    const liveCalls = this.calls.listLive().map((call) => ({
      callId: call.callId,
      callerName: call.callerName,
      groupName: call.groupName || "",
      video: call.video,
      accepted: call.accepted,
      party: [...new Set([call.callerId, call.calleeId, ...call.invitedIds, ...call.joinedIds])].filter(Boolean).length,
      joined: call.joinedIds.length,
      openedAt: call.openedAt,
    }));

    return {
      at: Date.now(),
      uptimeSec: Math.floor(process.uptime()),
      sockets: sockets.length,
      usersOnline: connected.length,
      usersTotal,
      roomsActive: rooms.filter((room) => room.connected > 0).length,
      callsLive: liveCalls.length,
      eventsLastHour,
      connected,
      rooms,
      calls: liveCalls,
      events: events.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        text: (row.originalText || "").slice(0, 120),
        durationMs: row.durationMs,
        at: row.createdAt.toISOString(),
        sender: row.sender.displayName || row.sender.phoneE164,
        channel: row.channel.name || row.channel.type,
        channelType: row.channel.type,
        targets: row._count.targets,
      })),
    };
  }

  private readChannelRooms(io: RealtimeGateway["server"] | undefined) {
    const rooms = io?.sockets?.adapter?.rooms;
    if (!rooms) return [] as { id: string; connected: number }[];
    const out: { id: string; connected: number }[] = [];
    for (const [name, members] of rooms) {
      if (!name.startsWith("channel:")) continue;
      out.push({ id: name.slice("channel:".length), connected: members.size });
    }
    return out;
  }
}
