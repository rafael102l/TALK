import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { currentLanBase } from "../lan-base";

function mimeFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3") return "audio/mpeg";
  return "audio/mp4";
}

@Injectable()
export class StorageService {
  private readonly root = join(process.cwd(), "storage");
  private audioTable: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async save(buffer: Buffer, ext: string, folder = "audio"): Promise<string> {
    const dir = join(this.root, folder);
    await mkdir(dir, { recursive: true });
    const name = `${randomUUID()}.${ext.replace(/^\./, "")}`;
    await writeFile(join(dir, name), buffer);
    if (folder === "audio") await this.rememberAudio(name, buffer, mimeFor(name));
    return `/media/${folder}/${name}`;
  }

  /** Keep the clip in Postgres so either server can play it after a restart. */
  async rememberAudio(name: string, buffer: Buffer, mime: string) {
    if (!buffer.length || buffer.length > 8_000_000) return;
    try {
      await this.ensureAudioTable();
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "WalkieAudio" ("name", "b64", "mime") VALUES ($1, $2, $3)
         ON CONFLICT ("name") DO UPDATE SET "b64" = EXCLUDED."b64", "mime" = EXCLUDED."mime"`,
        name,
        buffer.toString("base64"),
        mime,
      );
    } catch (error) {
      console.error(`[audio] store failed: ${(error as Error).message}`);
    }
  }

  async readAudio(name: string): Promise<{ body: Buffer; mime: string } | null> {
    const clean = name.split("/").pop() ?? name;
    if (!/^[\w.-]+$/.test(clean)) return null;
    const names = clean.includes(".") ? [clean] : [clean, `${clean}.m4a`, `${clean}.mp3`, `${clean}.wav`];
    for (const candidate of names) {
      const found = await this.readNamedAudio(candidate);
      if (found) return found;
    }
    return null;
  }

  private async readNamedAudio(name: string): Promise<{ body: Buffer; mime: string } | null> {
    const diskPath = join(this.root, "audio", name);
    try {
      const body = await readFile(diskPath);
      if (body.length) {
        void this.rememberAudio(name, body, mimeFor(name));
        return { body, mime: mimeFor(name) };
      }
    } catch {
      /* this server does not have the file on disk */
    }
    try {
      await this.ensureAudioTable();
      const rows = await this.prisma.$queryRawUnsafe<{ b64: string; mime: string }[]>(
        `SELECT "b64", "mime" FROM "WalkieAudio" WHERE "name" = $1 LIMIT 1`,
        name,
      );
      const row = rows[0];
      if (!row?.b64) return null;
      const body = Buffer.from(row.b64, "base64");
      if (!body.length) return null;
      return { body, mime: row.mime || mimeFor(name) };
    } catch (error) {
      console.error(`[audio] read failed: ${(error as Error).message}`);
      return null;
    }
  }

  private ensureAudioTable() {
    if (!this.audioTable) {
      this.audioTable = this.prisma
        .$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS "WalkieAudio" (
            "name" TEXT PRIMARY KEY,
            "b64" TEXT NOT NULL,
            "mime" TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`,
        )
        .then(() => undefined)
        .catch((error: Error) => {
          this.audioTable = null;
          throw error;
        });
    }
    return this.audioTable;
  }

  publicUrl(path: string): string {
    const base = currentLanBase();
    if (path.startsWith("http")) return path;
    return `${base}${path}`;
  }

  absolutePath(publicPath: string): string {
    const relative = publicPath.replace(/^\/media\//, "").replace(/^https?:\/\/[^/]+\/media\//, "");
    return join(this.root, relative);
  }

  async remove(publicPath: string) {
    if (!publicPath) return;
    try {
      await unlink(this.absolutePath(publicPath));
    } catch {
      /* already gone */
    }
  }
}
