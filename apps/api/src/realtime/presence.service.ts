import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

const TTL = 90;

@Injectable()
export class PresenceService {
  /** Live sockets in this process. Redis TTL must not hide a connected phone. */
  private readonly live = new Set<string>();
  /** App is in the foreground. Call sockets may stay up in background. */
  private readonly foreground = new Set<string>();
  private lastSeen = new Map<string, number>();

  constructor(private readonly redis: RedisService) {}

  private key(userId: string) {
    return `presence:${userId}`;
  }

  private seenKey(userId: string) {
    return `lastSeen:${userId}`;
  }

  async setOnline(userId: string, socketId: string) {
    this.live.add(userId);
    await this.redis.set(this.key(userId), socketId, TTL);
  }

  async heartbeat(userId: string, socketId: string) {
    await this.setOnline(userId, socketId);
  }

  async setAppActive(userId: string, active: boolean) {
    if (active) {
      this.foreground.add(userId);
      return 0;
    }
    this.foreground.delete(userId);
    const at = Date.now();
    this.lastSeen.set(userId, at);
    await this.redis.set(this.seenKey(userId), String(at));
    return at;
  }

  isChatOnline(userId: string) {
    return this.foreground.has(userId) && this.live.has(userId);
  }

  isSocketLive(userId: string) {
    return this.live.has(userId);
  }

  async setOffline(userId: string) {
    this.live.delete(userId);
    this.foreground.delete(userId);
    const at = Date.now();
    this.lastSeen.set(userId, at);
    await this.redis.del(this.key(userId));
    await this.redis.set(this.seenKey(userId), String(at));
    return at;
  }

  async lastSeenAt(userId: string) {
    const mem = this.lastSeen.get(userId);
    if (mem) return mem;
    const raw = await this.redis.get(this.seenKey(userId));
    const at = raw ? Number(raw) : 0;
    if (at) this.lastSeen.set(userId, at);
    return at || 0;
  }

  async lastSeenMap(userIds: string[]) {
    const out: Record<string, number> = {};
    for (const id of userIds) {
      const at = await this.lastSeenAt(id);
      if (at) out[id] = at;
    }
    return out;
  }

  async isOnline(userId: string) {
    if (this.live.has(userId)) return true;
    return Boolean(await this.redis.get(this.key(userId)));
  }

  async socketId(userId: string) {
    return this.redis.get(this.key(userId));
  }

  async onlineUserIds(userIds: string[]) {
    const online = new Set<string>();
    for (const id of userIds) {
      if (this.isChatOnline(id)) online.add(id);
    }
    return online;
  }
}
