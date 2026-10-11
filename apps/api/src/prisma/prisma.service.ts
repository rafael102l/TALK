import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/** Two phones were opening a connection on every retry until none were left. */
function pooledDatabaseUrl(raw: string | undefined) {
  const url = raw?.trim() ?? "";
  if (!url.startsWith("postgres")) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}connection_limit=2&pool_timeout=10&connect_timeout=10&socket_timeout=15`;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = pooledDatabaseUrl(process.env.DATABASE_URL);
    super(url ? { datasources: { db: { url } } } : undefined);
  }

  async onModuleInit() {
    // Do not wait on the database before listening. A stuck connect was failing the deploy.
    void this.$connect().catch((error: Error) => {
      console.error(`[db] connect failed: ${error.message}`);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
