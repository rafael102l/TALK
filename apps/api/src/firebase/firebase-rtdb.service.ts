import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { HistoryItem } from "@talk/shared";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { Database, getDatabase } from "firebase-admin/database";
import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";

const DEFAULT_URL = "https://talk-79c8a-default-rtdb.firebaseio.com";

export type CloudHistoryItem = HistoryItem & { ownerId: string };

@Injectable()
export class FirebaseRtdbService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseRtdbService.name);
  private readonly base = (process.env.FIREBASE_DATABASE_URL || DEFAULT_URL).replace(/\/$/, "");
  private db: Database | null = null;
  ready = false;

  async onModuleInit() {
    try {
      this.db = this.initAdmin();
      await Promise.race([
        this.db.ref("talk/meta/apiConnectedAt").set(new Date().toISOString()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Firebase connect timeout")), 8000)),
      ]);
      this.ready = true;
      this.logger.log(`Firebase history connected ${this.base}`);
    } catch (error) {
      this.ready = false;
      this.db = null;
      this.logger.warn(`Firebase history init failed — ${(error as Error).message}`);
    }
  }

  async saveItems(items: CloudHistoryItem[]) {
    if (!this.db) return;
    await Promise.all(
      items.map((item) => this.put(historyPath(item.ownerId, item.id), { ...item, savedAt: Date.now() })),
    );
  }

  async listHistory(ownerId: string): Promise<HistoryItem[]> {
    const data = await this.get<Record<string, CloudHistoryItem>>(historyPath(ownerId));
    if (!data) return [];
    return Object.values(data)
      .filter((row) => row && row.id)
      .map(({ ownerId: _owner, ...item }) => item)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 150);
  }

  async removeItem(ownerId: string, itemId: string) {
    await this.remove(historyPath(ownerId, itemId));
  }

  async removeTransmission(ownerIds: string[], transmissionId: string) {
    await Promise.all(
      ownerIds.map(async (ownerId) => {
        await this.removeItem(ownerId, transmissionId);
        const rows = await this.listHistory(ownerId);
        await Promise.all(
          rows
            .filter((row) => row.id === transmissionId || row.id.startsWith(`${transmissionId}:`))
            .map((row) => this.removeItem(ownerId, row.id)),
        );
      }),
    );
  }

  private initAdmin() {
    if (!getApps().length) {
      initializeApp({
        credential: cert(loadServiceAccount()),
        databaseURL: this.base,
      });
    }
    return getDatabase();
  }

  private async put(path: string, value: unknown) {
    if (!this.db) return false;
    try {
      await this.db.ref(path).set(value);
      return true;
    } catch (error) {
      this.logger.warn(`Firebase PUT ${(error as Error).message}`);
      return false;
    }
  }

  private async get<T>(path: string): Promise<T | null> {
    if (!this.db) return null;
    try {
      const snap = await this.db.ref(path).get();
      return (snap.exists() ? snap.val() : null) as T | null;
    } catch (error) {
      this.logger.warn(`Firebase GET ${(error as Error).message}`);
      return null;
    }
  }

  private async remove(path: string) {
    if (!this.db) return false;
    try {
      await this.db.ref(path).remove();
      return true;
    } catch {
      return false;
    }
  }
}

function loadServiceAccount() {
  const fromBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (fromBase64) {
    const json = Buffer.from(fromBase64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, string>;
  }

  let inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim() || "";
  if (inline) {
    // Render / UI sometimes wraps the whole JSON in quotes.
    if (
      (inline.startsWith("'") && inline.endsWith("'")) ||
      (inline.startsWith('"') && inline.endsWith('"') && !inline.startsWith('{"'))
    ) {
      inline = inline.slice(1, -1);
    }
    return JSON.parse(inline) as Record<string, string>;
  }

  const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
  const credPath = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  if (!existsSync(credPath)) {
    const flags = [
      `FIREBASE_SERVICE_ACCOUNT=${Boolean(process.env.FIREBASE_SERVICE_ACCOUNT)}`,
      `FIREBASE_SERVICE_ACCOUNT_BASE64=${Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64)}`,
      `cwd=${process.cwd()}`,
    ].join(" ");
    throw new Error(`Missing Firebase service account (${flags}). Set FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT.`);
  }
  return credPath;
}

function historyPrefix(ownerId: string) {
  return `talk/history/${safeKey(ownerId)}`;
}

function historyPath(ownerId: string, itemId?: string) {
  return itemId ? `${historyPrefix(ownerId)}/${safeKey(itemId)}` : historyPrefix(ownerId);
}

function safeKey(value: string) {
  return value.replace(/[.#$\[\]]/g, "_");
}
