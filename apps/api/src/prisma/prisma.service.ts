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
  if (!kept.some((part) => part.startsWith("sslmode="))) kept.push("sslmode=require");
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
    void this.$connect()
      .then(() => this.ensureColumns())
      .catch((error: Error) => {
        console.error(`[db] connect failed: ${error.message}`);
      });
  }

  private async ensureColumns() {
    try {
      await this.$executeRawUnsafe(`ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT`);
      await this.$executeRawUnsafe(
        `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "disappearAfterSec" INTEGER NOT NULL DEFAULT 0`,
      );
      await this.$executeRawUnsafe(`ALTER TABLE "Transmission" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3)`);
      await this.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "fcmToken" TEXT`);
      await this.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "CallDevice" (
          "userId" TEXT PRIMARY KEY,
          "fcmToken" TEXT,
          "voipToken" TEXT,
          "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      );
      console.log("[db] optional columns ready");
    } catch (error) {
      console.error(`[db] alter columns: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
