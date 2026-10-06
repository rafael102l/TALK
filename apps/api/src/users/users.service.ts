import { BadRequestException, Injectable } from "@nestjs/common";
import { User } from "@prisma/client";
import { VoiceCloneService } from "../ai/voice-clone.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { toPublicUser } from "./user.mapper";

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly voiceClone: VoiceCloneService,
  ) {}

  me(user: User) {
    return toPublicUser(user);
  }

  async update(
    user: User,
    data: {
      displayName?: string;
      speakLang?: string;
      listenLang?: string;
      voiceGender?: "male" | "female" | "child";
      plan?: "FREE" | "PLUS";
    },
  ) {
    const lang = data.speakLang || data.listenLang;
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...data,
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
    return toPublicUser(updated);
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
