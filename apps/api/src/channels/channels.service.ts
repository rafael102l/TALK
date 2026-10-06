import { BadRequestException, Injectable } from "@nestjs/common";
import { User } from "@prisma/client";
import { PresenceService } from "../realtime/presence.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {}

  async list(user: User) {
    const memberships = await this.prisma.channelMember.findMany({
      where: { userId: user.id },
      include: {
        channel: {
          include: { members: { include: { user: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(memberships.map((m) => this.toSummary(m.channel)));
  }

  async getOrCreateDirect(user: User, otherUserId: string) {
    if (otherUserId === user.id) throw new BadRequestException("אי אפשר לפתוח ערוץ לעצמך");
    const other = await this.prisma.user.findUnique({ where: { id: otherUserId } });
    if (!other) {
      throw new BadRequestException(
        "המשתמש לא רשום בשרת הנוכחי. שני הצדדים צריכים להתחבר מחדש ואז להוסיף אחד את השני דרך חיפוש מספר.",
      );
    }

    const existing = await this.prisma.channel.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: user.id } } },
          { members: { some: { userId: otherUserId } } },
        ],
      },
      include: { members: { include: { user: true } } },
    });
    if (existing && existing.members.length === 2) return this.toSummary(existing);

    const channel = await this.prisma.channel.create({
      data: {
        type: "DIRECT",
        members: {
          create: [{ userId: user.id }, { userId: otherUserId }],
        },
      },
      include: { members: { include: { user: true } } },
    });
    return this.toSummary(channel);
  }

  async createGroup(user: User, name: string, userIds: string[]) {
    const unique = [...new Set([user.id, ...userIds])];
    if (unique.length < 2) throw new BadRequestException("צריך לפחות עוד אדם אחד");
    const channel = await this.prisma.channel.create({
      data: {
        type: unique.length > 10 ? "BROADCAST" : "GROUP",
        name: name.trim() || "קבוצה",
        ownerId: user.id,
        members: { create: unique.map((userId) => ({ userId })) },
      },
      include: { members: { include: { user: true } } },
    });
    return this.toSummary(channel);
  }

  async assertMember(channelId: string, userId: string) {
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (!member) throw new BadRequestException("אין גישה לערוץ");
    return member;
  }

  async toSummary(channel: {
    id: string;
    type: "DIRECT" | "GROUP" | "BROADCAST";
    name: string | null;
    members: { userId: string; user: { displayName: string; listenLang: string } }[];
  }) {
    const onlineIds = await this.presence.onlineUserIds(channel.members.map((m) => m.userId));
    return {
      id: channel.id,
      type: channel.type,
      name: channel.name,
      members: channel.members.map((m) => ({
        userId: m.userId,
        displayName: m.user.displayName,
        listenLang: m.user.listenLang,
        online: onlineIds.has(m.userId),
      })),
    };
  }
}
