import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { currentLanBase } from "../lan-base";

@Injectable()
export class StorageService {
  private readonly root = join(process.cwd(), "storage");

  async save(buffer: Buffer, ext: string, folder = "audio"): Promise<string> {
    const dir = join(this.root, folder);
    await mkdir(dir, { recursive: true });
    const name = `${randomUUID()}.${ext.replace(/^\./, "")}`;
    await writeFile(join(dir, name), buffer);
    return `/media/${folder}/${name}`;
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
