import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(private readonly prisma: PrismaService) {}

  async notifyUsers(
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, string>,
    extra: { image?: string | null } = {},
  ) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, expoPushToken: { not: null } },
      select: { expoPushToken: true },
    });
    const tokens = users.map((u) => u.expoPushToken).filter((t): t is string => Boolean(t));
    if (!tokens.length) return;
    const messages = tokens.map((to) => ({
      to,
      sound: "default" as const,
      title,
      body,
      data,
      channelId: "talk-ptt",
      priority: "high" as const,
      ...(extra.image
        ? {
            image: extra.image,
            richContent: { image: extra.image },
            mutableContent: true,
          }
        : {}),
    }));
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messages),
      });
    } catch (error) {
      this.logger.warn(`Push failed: ${(error as Error).message}`);
    }
  }
}
