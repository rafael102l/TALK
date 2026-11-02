import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { User } from "@prisma/client";
import type { Socket } from "socket.io";
import { forgetUser } from "../auth/load-user";
import { PrismaService } from "../prisma/prisma.service";
import { CallRegistry } from "../realtime/call.registry";
import { PresenceService } from "../realtime/presence.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { CreateReportDto } from "./admin.dto";
import { adminTokenConfigured, adminTokensMatch } from "./admin.guard";
import {
  clearIncidents,
  listIncidents,
  openSecurityIncidentCount,
  openServerIncidentCount,
  pushIncident,
} from "./error-bus";

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
      pushIncident({
        kind: "security",
        status: 401,
        path: "/admin/session",
        method: "POST",
        message: "ניסיון כניסה לדשבורד עם טוקן שגוי",
      });
      throw new UnauthorizedException("Invalid admin token");
    }
  }

  async ensureSchema() {
    try {
      await this.ensureBanColumn();
      await this.ensureFeedbackTable();
      await this.ensureReportTable();
    } catch (error) {
      this.log.warn(`admin schema ensure failed: ${(error as Error).message}`);
      pushIncident({
        kind: "db",
        status: 500,
        path: "/admin/schema",
        method: "BOOT",
        message: "סנכרון סכמת אדמין נכשל",
        detail: (error as Error).message,
      });
    }
  }

  clearErrorLog() {
    clearIncidents();
    return { ok: true };
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
    const dbProbe = await this.probeDatabase();
    const [users, channels, peopleGroups, usersTotal, eventsLastHour, downloads, downloadsToday, downloadsWeek, inbox, reports] =
      await Promise.all([
        connectedIds.length
          ? this.prisma.user.findMany({
              where: { id: { in: connectedIds } },
              select: { id: true, displayName: true, phoneE164: true, speakLang: true, listenLang: true },
            }).catch((error) => {
              this.noteSnapshotFailure("connected users", error);
              return [];
            })
          : Promise.resolve([]),
        channelIds.length
          ? this.prisma.channel.findMany({
              where: { id: { in: channelIds } },
              select: { id: true, name: true, type: true, _count: { select: { members: true } } },
            }).catch((error) => {
              this.noteSnapshotFailure("channels", error);
              return [];
            })
          : Promise.resolve([]),
        this.prisma.transmission.groupBy({
          by: ["senderId"],
          _count: { id: true },
          _max: { createdAt: true },
          orderBy: { _max: { createdAt: "desc" } },
          take: 150,
        }).catch((error) => {
          this.noteSnapshotFailure("people groups", error);
          return [];
        }),
        this.prisma.user.count().catch((error) => {
          this.noteSnapshotFailure("usersTotal", error);
          return 0;
        }),
        this.prisma.transmission.count({ where: { createdAt: { gte: hourAgo } } }).catch((error) => {
          this.noteSnapshotFailure("eventsLastHour", error);
          return 0;
        }),
        this.prisma.user.findMany({
          orderBy: { createdAt: "desc" },
          take: 80,
          select: { id: true, displayName: true, phoneE164: true, createdAt: true },
        }).catch((error) => {
          this.noteSnapshotFailure("downloads list", error);
          return [];
        }),
        this.prisma.user.count({ where: { createdAt: { gte: startToday } } }).catch((error) => {
          this.noteSnapshotFailure("downloadsToday", error);
          return 0;
        }),
        this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }).catch((error) => {
          this.noteSnapshotFailure("downloadsWeek", error);
          return 0;
        }),
        this.readInbox(),
        this.readReports(),
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

    const incidents = listIncidents(60);
    const serverOpen = openServerIncidentCount();
    const securityFindings = this.securityFindings(dbProbe.ok);
    const securityOpen = securityFindings.length + openSecurityIncidentCount();
    const healthIssues = [
      ...(dbProbe.ok ? [] : ["אין חיבור תקין למסד הנתונים"]),
      ...(serverOpen ? [`${serverOpen} שגיאות שרת ב־15 הדקות האחרונות`] : []),
      ...(!io ? ["סוקט־איו לא מוכן"] : []),
    ];

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
      reportsCount: reports.length,
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
      reports,
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
      health: {
        ok: healthIssues.length === 0,
        dbOk: dbProbe.ok,
        dbMs: dbProbe.ms,
        openErrors: serverOpen,
        issues: healthIssues,
      },
      security: {
        ok: securityOpen === 0,
        openFindings: securityOpen,
        findings: securityFindings,
      },
      incidents,
    };
  }

  private noteSnapshotFailure(label: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    this.log.warn(`snapshot ${label} failed: ${detail}`);
    pushIncident({
      kind: "db",
      status: 500,
      path: "/admin/api/snapshot",
      method: "GET",
      message: `כשל בטעינת ${label}`,
      detail,
    });
  }

  private async probeDatabase() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, ms: Date.now() - started };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      pushIncident({
        kind: "db",
        status: 500,
        path: "/admin/api/snapshot",
        method: "GET",
        message: "בדיקת מסד הנתונים נכשלה",
        detail,
      });
      return { ok: false, ms: Date.now() - started };
    }
  }

  private securityFindings(dbOk: boolean) {
    const findings: string[] = [];
    const jwt = (process.env.JWT_SECRET || "").trim();
    if (!jwt || jwt === "talk-dev-jwt-secret-change-in-production") {
      findings.push("JWT_SECRET חסר או נשאר על ערך פיתוח ברירת־מחדל");
    }
    const salt = (process.env.CONTACT_HASH_SALT || "").trim();
    if (!salt || salt === "talk-contact-salt-dev") {
      findings.push("CONTACT_HASH_SALT חסר או נשאר על ערך פיתוח — /meta חושף salt חלש");
    }
    if (!adminTokenConfigured()) {
      findings.push("ADMIN_DASHBOARD_TOKEN לא מוגדר — הדשבורד חשוף לתצורה שגויה");
    }
    const dbUrl = process.env.DATABASE_URL || "";
    if (process.env.NODE_ENV === "production" && dbUrl.startsWith("file:")) {
      findings.push("בפרודקשן רץ SQLite על דיסק זמני — הנתונים עלולים להימחק בכל דיפלוי");
    }
    if (!dbOk) {
      findings.push("מסד הנתונים לא מגיב — האפליקציה עלולה להחזיר 500");
    }
    if (openSecurityIncidentCount() > 0) {
      findings.push("נרשמו ניסיונות כניסה כושלים לדשבורד לאחרונה");
    }
    return findings;
  }

  async saveReport(reporter: User, body: CreateReportDto) {
    const targetId = body.targetId.trim().slice(0, 80);
    const kind = body.targetKind === "group" ? "group" : "user";
    let targetName = (body.targetName || "").trim().slice(0, 80);
    let targetPhone = "";
    if (kind === "user") {
      const target = await this.prisma.user.findUnique({
        where: { id: targetId },
        select: { displayName: true, phoneE164: true },
      });
      if (target) {
        targetName = target.displayName || targetName || target.phoneE164;
        targetPhone = target.phoneE164;
      }
    }
    const data = {
      reporterId: reporter.id,
      reporterName: (reporter.displayName || "").trim(),
      reporterPhone: reporter.phoneE164 || "",
      targetId,
      targetName: targetName || "—",
      targetPhone,
      targetKind: kind,
      reason: (body.reason || "").trim() || "ללא פירוט",
    };
    try {
      const row = await this.prisma.userReport.create({ data, select: { id: true, createdAt: true } });
      this.log.log(`report saved reporter=${reporter.id} target=${targetId}`);
      return row;
    } catch (error) {
      this.log.warn(`report create failed, ensuring table: ${(error as Error).message}`);
      await this.ensureReportTable();
      const row = await this.prisma.userReport.create({ data, select: { id: true, createdAt: true } });
      this.log.log(`report saved reporter=${reporter.id} target=${targetId}`);
      return row;
    }
  }

  async setBanned(userId: string, banned: boolean) {
    const id = userId.trim().slice(0, 40);
    await this.ensureBanColumn();
    const updated = await this.prisma.user.update({
      where: { id },
      data: banned
        ? { bannedAt: new Date(), sessionActive: false, sessionVersion: { increment: 1 } }
        : { bannedAt: null },
    });
    forgetUser(id);
    if (banned) this.gateway.revokeUserSessions(id);
    this.log.log(`user ${banned ? "banned" : "unbanned"} id=${id}`);
    return { ok: true, banned: Boolean(updated.bannedAt) };
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

  private async readReports() {
    try {
      const rows = await this.prisma.userReport.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const targetIds = [...new Set(rows.filter((row) => row.targetKind === "user").map((row) => row.targetId))];
      const banned = targetIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: targetIds }, bannedAt: { not: null } },
            select: { id: true },
          })
        : [];
      const bannedIds = new Set(banned.map((row) => row.id));
      return rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        reason: row.reason,
        reporterId: row.reporterId,
        reporterName: row.reporterName || "—",
        reporterPhone: row.reporterPhone,
        targetId: row.targetId,
        targetName: row.targetName || "—",
        targetPhone: row.targetPhone,
        targetKind: row.targetKind,
        targetBanned: bannedIds.has(row.targetId),
      }));
    } catch (error) {
      this.log.warn(`reports unavailable: ${(error as Error).message}`);
      return [];
    }
  }

  private async ensureReportTable() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "UserReport" (
        "id" TEXT NOT NULL,
        "reporterId" TEXT NOT NULL,
        "reporterName" TEXT NOT NULL DEFAULT '',
        "reporterPhone" TEXT NOT NULL DEFAULT '',
        "targetId" TEXT NOT NULL,
        "targetName" TEXT NOT NULL DEFAULT '',
        "targetPhone" TEXT NOT NULL DEFAULT '',
        "targetKind" TEXT NOT NULL DEFAULT 'user',
        "reason" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "UserReport_pkey" PRIMARY KEY ("id")
      )
    `);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "UserReport_createdAt_idx" ON "UserReport"("createdAt")`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "UserReport_targetId_idx" ON "UserReport"("targetId")`);
  }

  private async ensureBanColumn() {
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannedAt" TIMESTAMP(3)`);
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
