import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { currentLanBase } from "../lan-base";

function mimeFor(name: string, fallback = "") {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3") return "audio/mpeg";
  if (fallback.startsWith("image/") || fallback.startsWith("video/") || fallback.startsWith("audio/")) return fallback;
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
    if (folder === "audio" || folder === "chat") {
      await this.rememberAudio(name, buffer, mimeFor(name)).catch((error: Error) => {
        console.error(`[media] store failed: ${error.message}`);
      });
    }
    return `/media/${folder}/${name}`;
  }

  /** Keep the file in Postgres so a Render restart does not turn photos black. */
  async rememberAudio(name: string, buffer: Buffer, mime: string) {
    const max = 12_000_000;
    if (!buffer.length || buffer.length > max) return;
    let last: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureAudioTable();
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "WalkieAudio" ("name", "b64", "mime") VALUES ($1, $2, $3)
           ON CONFLICT ("name") DO UPDATE SET "b64" = EXCLUDED."b64", "mime" = EXCLUDED."mime"`,
          name,
          buffer.toString("base64"),
          mime,
        );
        return;
      } catch (error) {
        last = error as Error;
        this.audioTable = null;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw last ?? new Error("audio store failed");
  }

  async readAudio(name: string): Promise<{ body: Buffer; mime: string } | null> {
    return this.readStored(name, "audio");
  }

  async readChat(name: string): Promise<{ body: Buffer; mime: string } | null> {
    return this.readStored(name, "chat");
  }

  private async readStored(name: string, folder: "audio" | "chat"): Promise<{ body: Buffer; mime: string } | null> {
    const clean = name.split("/").pop() ?? name;
    if (!/^[\w.-]+$/.test(clean)) return null;
    const extras = folder === "audio" ? [clean, `${clean}.m4a`, `${clean}.mp3`, `${clean}.wav`] : [clean];
    const names = clean.includes(".") ? [clean] : extras;
    for (const candidate of names) {
      const found = await this.readNamedFile(candidate, folder);
      if (found) return found;
    }
    return null;
  }

  private async readNamedFile(name: string, folder: "audio" | "chat"): Promise<{ body: Buffer; mime: string } | null> {
    const diskPath = join(this.root, folder, name);
    try {
      const body = await readFile(diskPath);
      if (body.length) {
        void this.rememberAudio(name, body, mimeFor(name)).catch(() => undefined);
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
      let row = rows[0];
      if (!row?.b64) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const again = await this.prisma.$queryRawUnsafe<{ b64: string; mime: string }[]>(
          `SELECT "b64", "mime" FROM "WalkieAudio" WHERE "name" = $1 LIMIT 1`,
          name,
        );
        row = again[0];
      }
      if (!row?.b64) return null;
      const body = Buffer.from(row.b64, "base64");
      if (!body.length) return null;
      try {
        await mkdir(join(this.root, folder), { recursive: true });
        await writeFile(diskPath, body);
      } catch {
        /* next request can still serve from Postgres */
      }
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
    const name = publicPath.split("/").pop();
    if (!name || !/^[\w.-]+$/.test(name)) return;
    try {
      await this.ensureAudioTable();
      await this.prisma.$executeRawUnsafe(`DELETE FROM "WalkieAudio" WHERE "name" = $1`, name);
    } catch {
      /* table missing */
    }
  }
}
