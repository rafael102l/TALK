import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  ttlPurgeBatchSize,
  ttlPurgeDays,
  ttlPurgeDryRun,
  ttlPurgeEnabled,
  ttlPurgeIntervalMs,
  ttlPurgeStatus,
  WALKIE_REPLAY_MS,
} from "./ttl-purge.flags";

export type TtlPurgeRunResult = {
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  scanned: number;
  candidates: number;
  purged: number;
  filesRemoved: number;
  skippedReplay: number;
  skippedIncompleteAck: number;
  ids: string[];
  at: string;
};

const EMPTY: Omit<TtlPurgeRunResult, "dryRun" | "at" | "skipped" | "reason"> = {
  scanned: 0,
  candidates: 0,
  purged: 0,
  filesRemoved: 0,
  skippedReplay: 0,
  skippedIncompleteAck: 0,
  ids: [],
};

@Injectable()
export class TtlPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TtlPurgeService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRun: TtlPurgeRunResult | null = null;
  private lastKick = 0;
  private dbOk: boolean | null = null;
  private dbMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    const status = ttlPurgeStatus();
    this.log.log(
      `ttl-purge flag enabled=${status.enabled} dryRun=${status.dryRun} days=${status.ttlDays} intervalMs=${status.intervalMs} (live PTT / WebRTC / 2min walkie replay are out of scope)`,
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, status.intervalMs);
    if (status.enabled && status.dryRun) {
      setTimeout(() => {
        void this.run({ dryRun: true }).catch((error: Error) => {
          this.log.warn(`ttl-purge boot dry-run failed: ${error.message}`);
          if (!this.lastRun) {
            this.lastRun = {
              ...EMPTY,
              dryRun: true,
              skipped: true,
              reason: error.message,
              at: new Date().toISOString(),
            };
          }
        });
      }, 8_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      ...ttlPurgeStatus(),
      running: this.running,
      dbOk: this.dbOk,
      dbMs: this.dbMs,
      lastRun: this.lastRun,
    };
  }

  /** One dry-run retry after a skipped DB error. Cooldown avoids health-check stampedes. */
  kickIfNeeded() {
    if (!ttlPurgeEnabled() || !ttlPurgeDryRun()) return;
    if (this.running) return;
    if (this.lastRun && !this.lastRun.skipped) return;
    if (Date.now() - this.lastKick < 45_000) return;
    this.lastKick = Date.now();
    void this.probeAndRun();
  }

  async probeDb(): Promise<boolean> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      this.dbOk = true;
      this.dbMs = Date.now() - started;
    } catch {
      this.dbOk = false;
      this.dbMs = Date.now() - started;
    }
    return Boolean(this.dbOk);
  }

  private async probeAndRun() {
    if (!(await this.probeDb())) return;
    await this.run({ dryRun: true });
  }

  /** Hourly job. No-ops unless MEDIA_TTL_PURGE_ENABLED is on. */
  async tick(): Promise<TtlPurgeRunResult> {
    if (!ttlPurgeEnabled()) {
      return this.remember({
        ...EMPTY,
        dryRun: true,
        skipped: true,
        reason: "MEDIA_TTL_PURGE_ENABLED is off",
        at: new Date().toISOString(),
      });
    }
    return this.run({ dryRun: ttlPurgeDryRun() });
  }

  /**
   * Strip original + TransmissionRender media after full ACK + TTL.
   * Never deletes Transmission / text / transcripts.
   * Never touches live-dub RAM, Redis, WebRTC, or walkies inside the 2-minute replay window.
   */
  async run(opts: { dryRun?: boolean; limit?: number } = {}): Promise<TtlPurgeRunResult> {
    const dryRun = opts.dryRun ?? ttlPurgeDryRun();
    const at = new Date().toISOString();
    if (!dryRun && !ttlPurgeEnabled()) {
      return this.remember({
        ...EMPTY,
        dryRun: false,
        skipped: true,
        reason: "MEDIA_TTL_PURGE_ENABLED is off — refuse actual delete",
        at,
      });
    }
    if (this.running) {
      return this.remember({
        ...EMPTY,
        dryRun,
        skipped: true,
        reason: "purge already running",
        at,
      });
    }
    this.running = true;
    try {
      const limit = opts.limit ?? ttlPurgeBatchSize();
      const timed = await Promise.race([
        this.execute(dryRun, limit, at),
        new Promise<TtlPurgeRunResult>((_, reject) => {
          setTimeout(() => reject(new Error("ttl-purge query timed out after 25s")), 25_000);
        }),
      ]);
      return this.remember(timed);
    } catch (error) {
      const failed: TtlPurgeRunResult = {
        ...EMPTY,
        dryRun,
        skipped: true,
        reason: error instanceof Error ? error.message : String(error),
        at,
      };
      this.log.warn(`ttl-purge failed: ${failed.reason}`);
      return this.remember(failed);
    } finally {
      this.running = false;
    }
  }

  private async execute(dryRun: boolean, limit: number, at: string): Promise<TtlPurgeRunResult> {
    const ttlMs = ttlPurgeDays() * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const ackCutoff = new Date(now - ttlMs);
    const replayFloor = new Date(now - WALKIE_REPLAY_MS);

    const rows = await this.prisma.transmission.findMany({
      where: {
        status: "READY",
        createdAt: { lt: ackCutoff },
        OR: [{ originalAudioUrl: { not: "" } }, { renders: { some: { audioUrl: { not: "" } } } }],
      },
      select: {
        id: true,
        kind: true,
        createdAt: true,
        originalAudioUrl: true,
        targets: { select: { playedAt: true, deliveredAt: true } },
        renders: { select: { id: true, audioUrl: true } },
      },
      orderBy: { createdAt: "asc" },
      take: Math.min(limit, 200),
    });

    let skippedReplay = 0;
    let skippedIncompleteAck = 0;
    const due: typeof rows = [];
    for (const row of rows) {
      if (this.isReplayProtected(row.kind, row.createdAt, replayFloor)) {
        skippedReplay += 1;
        continue;
      }
      const lastAck = this.lastAckAt(row.targets);
      if (!lastAck || lastAck > ackCutoff) {
        skippedIncompleteAck += 1;
        continue;
      }
      due.push(row);
    }

    const ids: string[] = [];
    let filesRemoved = 0;
    for (const row of due) {
      const files = this.mediaPaths(row.originalAudioUrl, row.renders);
      if (!files.length) continue;
      ids.push(row.id);
      if (dryRun) continue;
      for (const path of files) {
        await this.storage.remove(path);
        filesRemoved += 1;
      }
      await this.prisma.transmission.update({
        where: { id: row.id },
        data: { originalAudioUrl: "" },
      });
      if (row.renders.some((render) => render.audioUrl)) {
        await this.prisma.transmissionRender.updateMany({
          where: { transmissionId: row.id, audioUrl: { not: "" } },
          data: { audioUrl: "" },
        });
      }
    }

    const result: TtlPurgeRunResult = {
      dryRun,
      scanned: rows.length,
      candidates: due.length,
      purged: dryRun ? 0 : ids.length,
      filesRemoved: dryRun ? 0 : filesRemoved,
      skippedReplay,
      skippedIncompleteAck,
      ids: ids.slice(0, 20),
      at,
    };
    this.log.log(
      `ttl-purge dryRun=${dryRun} scanned=${result.scanned} due=${result.candidates} purged=${result.purged} files=${result.filesRemoved} skipReplay=${skippedReplay} skipAck=${skippedIncompleteAck}`,
    );
    return result;
  }

  /**
   * Iron rule: live PTT RAM + 2-minute walkie replay must never be TTL-purged.
   * Replay reads READY walkies with createdAt >= now-2min (see sendUnplayedWalkies).
   * Any media inside that window stays, including durable WalkieAudio blobs used for replay.
   */
  private isReplayProtected(_kind: string, createdAt: Date, replayFloor: Date): boolean {
    return createdAt >= replayFloor;
  }

  private lastAckAt(targets: { playedAt: Date | null; deliveredAt: Date | null }[]): Date | null {
    if (!targets.length) return null;
    let latest = 0;
    for (const target of targets) {
      const played = target.playedAt?.getTime() ?? 0;
      if (!played) return null;
      if (played > latest) latest = played;
    }
    return latest ? new Date(latest) : null;
  }

  private mediaPaths(original: string, renders: { audioUrl: string }[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const path of [original, ...renders.map((row) => row.audioUrl)]) {
      const clean = (path || "").trim();
      if (!clean || seen.has(clean)) continue;
      if (clean.includes("/avatars/")) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out;
  }

  private remember(result: TtlPurgeRunResult): TtlPurgeRunResult {
    if (!result.skipped || result.reason !== "MEDIA_TTL_PURGE_ENABLED is off") {
      this.lastRun = result;
    } else if (!this.lastRun) {
      this.lastRun = result;
    }
    return result;
  }
}
