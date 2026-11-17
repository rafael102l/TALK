import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { onIncident, type AdminIncident } from "./error-bus";

export type WatchAction = {
  id: string;
  at: string;
  kind: string;
  message: string;
  detail: string;
};

const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 8;
const BLOCK_MS = 2 * 60 * 60 * 1000;
const RESTART_COOLDOWN_MS = 10 * 60 * 1000;
const ACTION_KEEP = 80;

function paymentPath(path: string) {
  return /invest|cardcom|checkout|payment|billing/i.test(path || "");
}

export function clientIp(req?: Request | { headers?: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } } | null) {
  if (!req) return "";
  const forwarded = req.headers?.["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === "string" ? forwarded.split(",")[0] : "";
  return (raw || req.ip || req.socket?.remoteAddress || "").trim();
}

@Injectable()
export class WatchBotService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WatchBotService.name);
  private enabled = false;
  private actions: WatchAction[] = [];
  private fails = new Map<string, number[]>();
  private blocked = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  private lastRestartAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offIncident: (() => void) | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureTable();
    await this.load();
    this.offIncident = onIncident((row) => this.handleIncident(row));
    this.timer = setInterval(() => void this.tick(), 20_000);
    process.on("uncaughtException", this.onCrash);
    process.on("unhandledRejection", this.onReject);
    this.log.log(`watch bot ${this.enabled ? "on" : "off"}`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.offIncident?.();
    process.off("uncaughtException", this.onCrash);
    process.off("unhandledRejection", this.onReject);
  }

  isEnabled() {
    return this.enabled;
  }

  isBlocked(ip: string) {
    if (!this.enabled || !ip) return false;
    this.pruneBlocks();
    const until = this.blocked.get(ip);
    return Boolean(until && until > Date.now());
  }

  noteAdminFail(ip: string) {
    if (!this.enabled || !ip) return;
    const now = Date.now();
    const list = (this.fails.get(ip) || []).filter((at) => now - at < FAIL_WINDOW_MS);
    list.push(now);
    this.fails.set(ip, list);
    if (list.length >= FAIL_LIMIT && !this.isBlocked(ip)) {
      this.blocked.set(ip, now + BLOCK_MS);
      void this.record("block", "נחסמה כתובת אחרי ניסיונות כניסה כושלים לדשבורד", ip);
    }
  }

  snapshot() {
    this.pruneBlocks();
    return {
      enabled: this.enabled,
      blocked: this.blocked.size,
      actions: this.actions.slice(0, 40),
    };
  }

  async setEnabled(enabled: boolean) {
    this.enabled = Boolean(enabled);
    await this.ensureTable();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "WatchBotState" ("id", "enabled", "updatedAt") VALUES ('main', ${this.enabled ? "TRUE" : "FALSE"}, CURRENT_TIMESTAMP)
       ON CONFLICT ("id") DO UPDATE SET "enabled" = EXCLUDED."enabled", "updatedAt" = CURRENT_TIMESTAMP`,
    );
    await this.record(this.enabled ? "on" : "off", this.enabled ? "השומר הופעל" : "השומר כובה", "");
    return this.snapshot();
  }

  private onCrash = (error: unknown) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : String(error);
    void this.crash("קריסת תהליך לא נתפסה", detail);
  };

  private onReject = (reason: unknown) => {
    const detail = reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack || ""}` : String(reason);
    void this.crash("הבטחה שנכשלה בלי טיפול", detail);
  };

  private handleIncident(row: AdminIncident) {
    if (!this.enabled) return;
    if (paymentPath(row.path)) return;
    if (row.kind === "security") return;
    const key = `${row.kind}:${row.path}:${row.message}`;
    const now = Date.now();
    if ((this.lastSeen.get(key) || 0) > now - 60_000) return;
    this.lastSeen.set(key, now);
    void this.record("error", row.message, row.detail || `${row.method} ${row.path} · ${row.status}`);
    if (row.kind === "db") void this.reconnect(row.detail);
  }

  private async tick() {
    if (!this.enabled) return;
    this.pruneBlocks();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      await this.reconnect(error instanceof Error ? error.message : String(error));
    }
  }

  private async reconnect(detail: string) {
    if (!this.enabled) return;
    await this.record("lift", "מסד הנתונים לא מגיב — מתחברים מחדש", detail);
    try {
      await this.prisma.$connect();
      await this.prisma.$queryRaw`SELECT 1`;
      await this.record("lift", "החיבור למסד הנתונים חזר", "");
    } catch (error) {
      await this.record("lift", "עדיין אין חיבור למסד הנתונים", error instanceof Error ? error.message : String(error));
    }
  }

  private async crash(message: string, detail: string) {
    if (!this.enabled) {
      console.error("[watch] crash while off", message, detail);
      process.exit(1);
      return;
    }
    await this.record("crash", message, detail.slice(0, 1200));
    const now = Date.now();
    if (now - this.lastRestartAt < RESTART_COOLDOWN_MS) {
      await this.record("skip", "דילגנו על הרמה — השרת כבר הורם לאחרונה", "");
      return;
    }
    this.lastRestartAt = now;
    await this.prisma.$executeRawUnsafe(
      `UPDATE "WatchBotState" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'main'`,
    ).catch(() => undefined);
    await this.record("restart", "מרימים את השרת אחרי קריסה", message);
    if (process.env.NODE_ENV === "production") {
      setTimeout(() => process.exit(1), 800);
    }
  }

  private pruneBlocks() {
    const now = Date.now();
    for (const [ip, until] of this.blocked) {
      if (until <= now) this.blocked.delete(ip);
    }
  }

  private async record(kind: string, message: string, detail: string) {
    const row: WatchAction = {
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      at: new Date().toISOString(),
      kind,
      message: String(message || "").slice(0, 400),
      detail: String(detail || "").slice(0, 1200),
    };
    this.actions.unshift(row);
    if (this.actions.length > ACTION_KEEP) this.actions.length = ACTION_KEEP;
    this.log.warn(`[watch] ${kind} ${row.message}`);
    try {
      await this.ensureTable();
      await this.prisma.$executeRaw`
        INSERT INTO "WatchBotAction" ("id", "at", "kind", "message", "detail")
        VALUES (${row.id}, CURRENT_TIMESTAMP, ${row.kind}, ${row.message}, ${row.detail})
      `;
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM "WatchBotAction" WHERE "id" NOT IN (SELECT "id" FROM "WatchBotAction" ORDER BY "at" DESC LIMIT ${ACTION_KEEP})`,
      );
    } catch {
      /* keep memory log */
    }
  }

  private async load() {
    try {
      const state = await this.prisma.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT "enabled" FROM "WatchBotState" WHERE "id" = 'main' LIMIT 1
      `;
      this.enabled = Boolean(state[0]?.enabled);
      const rows = await this.prisma.$queryRaw<WatchAction[]>`
        SELECT "id", "at", "kind", "message", "detail" FROM "WatchBotAction" ORDER BY "at" DESC LIMIT 40
      `;
      this.actions = rows.map((row) => ({
        ...row,
        at: typeof row.at === "string" ? row.at : new Date(row.at).toISOString(),
      }));
    } catch {
      this.enabled = false;
    }
  }

  private async ensureTable() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WatchBotState" (
        "id" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "WatchBotState_pkey" PRIMARY KEY ("id")
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WatchBotAction" (
        "id" TEXT NOT NULL,
        "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "kind" TEXT NOT NULL,
        "message" TEXT NOT NULL,
        "detail" TEXT NOT NULL DEFAULT '',
        CONSTRAINT "WatchBotAction_pkey" PRIMARY KEY ("id")
      )
    `);
  }
}
