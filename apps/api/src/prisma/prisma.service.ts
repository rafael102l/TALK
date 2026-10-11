import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/** One small web process. A pool of 9 fills up and the next query dies after 10s (P2024). */
function pooledDatabaseUrl(raw: string | undefined) {
  const url = raw?.trim() ?? "";
  if (!url.startsWith("postgres")) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}connection_limit=5&pool_timeout=30`;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = pooledDatabaseUrl(process.env.DATABASE_URL);
    super(url ? { datasources: { db: { url } } } : undefined);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
