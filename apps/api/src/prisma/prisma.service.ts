import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/** Keep enough connections for a recording. A short socket timeout was cutting SSL and Postgres logged "unexpected eof". */
function pooledDatabaseUrl(raw: string | undefined) {
  const url = raw?.trim() ?? "";
  if (!url.startsWith("postgres")) return url;
  const [base, query = ""] = url.split("?");
  const kept = query
    .split("&")
    .filter((part) => part && !/^(connection_limit|pool_timeout|connect_timeout|socket_timeout)=/.test(part));
  kept.push("connection_limit=10", "pool_timeout=20");
  return `${base}?${kept.join("&")}`;
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
