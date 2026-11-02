import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { User } from "@prisma/client";
import type { Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";
import { CallRegistry } from "../realtime/call.registry";
import { PresenceService } from "../realtime/presence.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { adminTokenConfigured, adminTokensMatch } from "./admin.guard";

type AuthedSocket = Socket & { userId?: string; displayName?: string };

const EVENT_TAKE = 200;

@Injectable()
export class AdminService {
  private readonly log = new Logger(AdminService.name);

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

  async saveFeedback(user: User, text: string) {
    const body = text.trim().slice(0, 4000);
    if (!body) throw new BadRequestException("empty");
    const data = {
      userId: user.id,
      name: (user.displayName || "").trim(),
      phone: user.phoneE164 || "",
      text: body,
    };
    try {
      const row = await this.prisma.feedbackNote.create({ data, select: { id: true, createdAt: true } });
      this.log.log(`feedback saved user=${user.id}`);
      return row;
    } catch (error) {
      this.log.warn(`feedback create failed, ensuring table: ${(error as Error).message}`);
      await this.ensureFeedbackTable();
      const row = await this.prisma.feedbackNote.create({ data, select: { id: true, createdAt: true } });
      this.log.log(`feedback saved user=${user.id}`);
      return row;
    }
  }

  private async ensureFeedbackTable() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "FeedbackNote" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "name" TEXT NOT NULL DEFAULT '',
        "phone" TEXT NOT NULL DEFAULT '',
        "text" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "FeedbackNote_pkey" PRIMARY KEY ("id")
      )
    `);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "FeedbackNote_createdAt_idx" ON "FeedbackNote"("createdAt")`);
  }

  async snapshot() {
    const io = this.gateway.server;
    const sockets = io?.sockets?.sockets ? ([...io.sockets.sockets.values()] as AuthedSocket[]) : [];
    const connectedIds = [...new Set(sockets.map((sock) => sock.userId).filter(Boolean))] as string[];

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const channelRooms = this.readChannelRooms(io);
    const channelIds = channelRooms.map((room) => room.id);
    const [users, channels, peopleGroups, usersTotal, eventsLastHour, downloads, downloadsToday, downloadsWeek, inbox] =
      await Promise.all([
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
        this.prisma.transmission.groupBy({
          by: ["senderId"],
          _count: { id: true },
          _max: { createdAt: true },
          orderBy: { _max: { createdAt: "desc" } },
          take: 150,
        }),
        this.prisma.user.count(),
        this.prisma.transmission.count({ where: { createdAt: { gte: hourAgo } } }),
        this.prisma.user.findMany({
          orderBy: { createdAt: "desc" },
          take: 80,
          select: { id: true, displayName: true, phoneE164: true, createdAt: true },
        }),
        this.prisma.user.count({ where: { createdAt: { gte: startToday } } }),
        this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
        this.readInbox(),
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

    const senderIds = peopleGroups.map((row) => row.senderId);
    const senders = senderIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, displayName: true, phoneE164: true },
        })
      : [];
    const senderById = new Map(senders.map((row) => [row.id, row]));

    return {
      at: Date.now(),
      uptimeSec: Math.floor(process.uptime()),
      sockets: sockets.length,
      usersOnline: connected.length,
      usersTotal,
      roomsActive: rooms.filter((room) => room.connected > 0).length,
      callsLive: liveCalls.length,
      eventsLastHour,
      downloadsToday,
      downloadsWeek,
      inboxCount: inbox.length,
      connected,
      rooms,
      calls: liveCalls,
      downloads: downloads.map((row) => ({
        id: row.id,
        name: row.displayName || "—",
        phone: row.phoneE164,
        at: row.createdAt.toISOString(),
      })),
      inbox,
      people: peopleGroups.map((row) => {
        const sender = senderById.get(row.senderId);
        return {
          id: row.senderId,
          name: sender?.displayName || sender?.phoneE164 || "—",
          phone: sender?.phoneE164 || "",
          count: row._count.id,
          lastAt: row._max.createdAt?.toISOString() || "",
        };
      }),
    };
  }

  async eventsForUser(userId: string) {
    const id = userId.trim().slice(0, 40);
    const [user, rows] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        select: { id: true, displayName: true, phoneE164: true },
      }),
      this.prisma.transmission.findMany({
        where: { senderId: id },
        orderBy: { createdAt: "desc" },
        take: EVENT_TAKE,
        select: {
          id: true,
          kind: true,
          status: true,
          originalText: true,
          durationMs: true,
          createdAt: true,
          channel: { select: { name: true, type: true } },
          _count: { select: { targets: true } },
        },
      }),
    ]);
    return {
      id,
      name: user?.displayName || user?.phoneE164 || "—",
      phone: user?.phoneE164 || "",
      events: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        text: row.originalText || "",
        durationMs: row.durationMs,
        at: row.createdAt.toISOString(),
        channel: row.channel.name || row.channel.type,
        channelType: row.channel.type,
        targets: row._count.targets,
      })),
    };
  }

  private async readInbox() {
    try {
      const rows = await this.prisma.feedbackNote.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, name: true, phone: true, text: true, createdAt: true },
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name || "—",
        phone: row.phone,
        text: row.text,
        at: row.createdAt.toISOString(),
      }));
    } catch (error) {
      this.log.warn(`feedback inbox unavailable: ${(error as Error).message}`);
      return [];
    }
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
