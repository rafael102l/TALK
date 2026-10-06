import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private readonly memory = new Map<string, { value: string; expiresAt: number | null }>();
  ready = false;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn("REDIS_URL missing — using in-memory store");
      return;
    }
    try {
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      this.client.on("error", (error) => {
        this.logger.warn(`Redis error: ${error.message}`);
      });
      this.client
        .connect()
        .then(() => {
          this.ready = true;
          this.logger.log("Redis connected");
        })
        .catch((error: Error) => {
          this.logger.warn(`Redis unavailable, falling back to memory: ${error.message}`);
          this.client = null;
        });
    } catch (error) {
      this.logger.warn(`Redis init failed: ${(error as Error).message}`);
      this.client = null;
    }
  }

  async onModuleDestroy() {
    if (this.client) await this.client.quit();
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (this.client && this.ready) {
      if (ttlSeconds) await this.client.set(key, value, "EX", ttlSeconds);
      else await this.client.set(key, value);
      return;
    }
    this.memory.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async get(key: string): Promise<string | null> {
    if (this.client && this.ready) return this.client.get(key);
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key: string) {
    if (this.client && this.ready) {
      await this.client.del(key);
      return;
    }
    this.memory.delete(key);
  }

  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.client && this.ready) {
      const result = await this.client.set(key, value, "EX", ttlSeconds, "NX");
      return result === "OK";
    }
    const existing = await this.get(key);
    if (existing) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }
}
