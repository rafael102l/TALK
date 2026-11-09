import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { User } from "@prisma/client";
import { SOCKET_EVENTS } from "@talk/shared";
import { VoiceCloneService } from "../ai/voice-clone.service";
import { ContactsService } from "../contacts/contacts.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { StorageService } from "../storage/storage.service";
import { toPublicUser } from "./user.mapper";

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly voiceClone: VoiceCloneService,
    private readonly realtime: RealtimeGateway,
    private readonly contacts: ContactsService,
  ) {}

  me(user: User) {
    return toPublicUser(user);
  }

  async publicCard(viewer: User, userId: string) {
    if (viewer.id === userId) return toPublicUser(viewer);
    const other = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!other) throw new NotFoundException();
    const related = await this.isRelated(viewer.id, userId);
    if (!related) throw new NotFoundException();
    const hidden = await this.contacts.isBlockedBy(other.id, viewer.id);
    if (!hidden) return toPublicUser(other);
    return { ...toPublicUser(other), avatarUrl: null, avatarHidden: true };
  }

  private async isRelated(viewerId: string, otherId: string) {
    const [tx, contact, channel] = await Promise.all([
      this.prisma.transmissionTarget.findFirst({
        where: {
          OR: [
            { userId: viewerId, transmission: { senderId: otherId } },
            { userId: otherId, transmission: { senderId: viewerId } },
          ],
        },
        select: { id: true },
      }),
      this.prisma.contact.findFirst({
        where: {
          OR: [
            { ownerId: viewerId, matchedUserId: otherId },
            { ownerId: otherId, matchedUserId: viewerId },
          ],
        },
        select: { id: true },
      }),
      this.prisma.channelMember.findFirst({
        where: { userId: viewerId, channel: { members: { some: { userId: otherId } } } },
        select: { id: true },
      }),
    ]);
    return Boolean(tx || contact || channel);
  }

  async update(
    user: User,
    data: {
      displayName?: string;
      email?: string;
      speakLang?: string;
      listenLang?: string;
      voiceGender?: "male" | "female" | "child";
      plan?: "FREE" | "PLUS";
    },
  ) {
    const lang = data.speakLang || data.listenLang;
    const email = data.email?.trim().toLowerCase();
    if (email !== undefined && email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException("כתובת אימייל לא תקינה");
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(email !== undefined ? { email: email || null } : {}),
        ...(data.voiceGender !== undefined ? { voiceGender: data.voiceGender } : {}),
        ...(data.plan !== undefined ? { plan: data.plan } : {}),
        ...(lang ? { speakLang: lang, listenLang: lang } : {}),
      },
    });
    return toPublicUser(updated);
  }

  async savePushToken(user: User, token: string) {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { expoPushToken: token },
    });
    return { ok: true };
  }

  async cloneVoice(user: User, file: Express.Multer.File) {
    if (user.plan !== "PLUS") {
      throw new BadRequestException("שיבוט קול זמין במסלול PLUS בלבד");
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { voiceCloneStatus: "PENDING" },
    });
    const saved = await this.storage.save(file.buffer, extFrom(file), "voices");
    const abs = this.storage.absolutePath(saved);
    try {
      const voiceId = await this.voiceClone.clone(user.id, user.displayName, abs);
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { elevenVoiceId: voiceId, voiceCloneStatus: "READY" },
      });
      return toPublicUser(updated);
    } catch {
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { voiceCloneStatus: "FAILED" },
      });
      return toPublicUser(updated);
    }
  }

  async saveAvatar(user: User, file: Express.Multer.File) {
    if (file.size > 5_000_000) throw new BadRequestException("התמונה גדולה מדי");
    const saved = await this.storage.save(file.buffer, imageExt(file), "avatars");
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: saved },
    });
    await this.broadcastProfile(updated);
    return toPublicUser(updated);
  }

  private async broadcastProfile(user: User) {
    const card = toPublicUser(user);
    const hiddenCard = { ...card, avatarUrl: null as string | null, avatarHidden: true };
    const [contacts, members, blockedViewers] = await Promise.all([
      this.prisma.contact.findMany({
        where: { matchedUserId: user.id, status: { not: "BLOCKED" } },
        select: { ownerId: true },
      }),
      this.prisma.channelMember.findMany({
        where: { channel: { members: { some: { userId: user.id } } } },
        select: { userId: true },
      }),
      this.contacts.blockedByOwner(user.id),
    ]);
    const ids = new Set<string>();
    for (const row of contacts) ids.add(row.ownerId);
    for (const row of members) if (row.userId !== user.id) ids.add(row.userId);
    for (const id of ids) {
      this.realtime.emitToUser(id, SOCKET_EVENTS.USER_UPDATED, {
        user: blockedViewers.has(id) ? hiddenCard : card,
      });
    }
  }

  async remove(user: User) {
    await this.prisma.$transaction([
      this.prisma.transmissionTarget.deleteMany({ where: { userId: user.id } }),
      this.prisma.transmission.deleteMany({ where: { senderId: user.id } }),
      this.prisma.contact.deleteMany({
        where: { OR: [{ ownerId: user.id }, { matchedUserId: user.id }] },
      }),
      this.prisma.otpCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.channelMember.deleteMany({ where: { userId: user.id } }),
      this.prisma.user.delete({ where: { id: user.id } }),
    ]);
    return { ok: true };
  }
}

function extFrom(file: Express.Multer.File) {
  const fromName = file.originalname.split(".").pop();
  if (fromName && fromName.length <= 5) return fromName;
  if (file.mimetype.includes("mpeg") || file.mimetype.includes("mp3")) return "mp3";
  if (file.mimetype.includes("wav")) return "wav";
  return "m4a";
}

function imageExt(file: Express.Multer.File) {
  const fromName = file.originalname.split(".").pop()?.toLowerCase();
  if (fromName === "png" || fromName === "webp" || fromName === "jpg" || fromName === "jpeg") {
    return fromName === "jpeg" ? "jpg" : fromName;
  }
  if (file.mimetype.includes("png")) return "png";
  if (file.mimetype.includes("webp")) return "webp";
  return "jpg";
}
