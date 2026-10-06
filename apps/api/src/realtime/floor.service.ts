import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

const FLOOR_TTL = 35;

export type FloorHolder = {
  speakerId: string;
  speakerName: string;
};

@Injectable()
export class FloorService {
  constructor(private readonly redis: RedisService) {}

  private key(channelId: string) {
    return `floor:${channelId}`;
  }

  async acquire(channelId: string, speakerId: string, speakerName: string): Promise<FloorHolder | true> {
    const existing = await this.get(channelId);
    if (existing && existing.speakerId !== speakerId) return existing;
    await this.redis.set(this.key(channelId), JSON.stringify({ speakerId, speakerName }), FLOOR_TTL);
    return true;
  }

  async release(channelId: string, speakerId: string) {
    const existing = await this.get(channelId);
    if (existing && existing.speakerId !== speakerId) return false;
    await this.redis.del(this.key(channelId));
    return true;
  }

  async get(channelId: string): Promise<FloorHolder | null> {
    const raw = await this.redis.get(this.key(channelId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FloorHolder;
    } catch {
      return null;
    }
  }
}
