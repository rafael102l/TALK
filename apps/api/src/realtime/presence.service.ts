import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

const TTL = 90;

@Injectable()
export class PresenceService {
  constructor(private readonly redis: RedisService) {}

  private key(userId: string) {
    return `presence:${userId}`;
  }

  async setOnline(userId: string, socketId: string) {
    await this.redis.set(this.key(userId), socketId, TTL);
  }

  async heartbeat(userId: string, socketId: string) {
    await this.setOnline(userId, socketId);
  }

  async setOffline(userId: string) {
    await this.redis.del(this.key(userId));
  }

  async isOnline(userId: string) {
    return Boolean(await this.redis.get(this.key(userId)));
  }

  async socketId(userId: string) {
    return this.redis.get(this.key(userId));
  }

  async onlineUserIds(userIds: string[]) {
    const online = new Set<string>();
    for (const id of userIds) {
      if (await this.isOnline(id)) online.add(id);
    }
    return online;
  }
}
