import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

const STARTER = [
  "Cursor",
  "Render",
  "PostgreSQL",
  "Cardcom",
  "אחסון קבצים",
  "דומיין",
  "Google Play",
  "Apple Developer",
  "Firebase",
];

export type CostRow = {
  id: string;
  name: string;
  amount: number;
  currency: string;
  at: string;
  status: string;
  note: string;
};

@Injectable()
export class CostLedgerService implements OnModuleInit {
  private readonly log = new Logger(CostLedgerService.name);
  private ready = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureTable();
  }

  async snapshot() {
    await this.ensureTable();
    const names = await this.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT "name" FROM "CostItem" ORDER BY "name" ASC
    `;
    const rows = await this.prisma.$queryRaw<CostRow[]>`
      SELECT "id", "name", "amount", "currency", "at", "status", "note"
      FROM "CostPayment" ORDER BY "at" DESC, "createdAt" DESC LIMIT 400
    `;
    const list = rows.map((row) => ({
      ...row,
      amount: Number(row.amount || 0),
      at: typeof row.at === "string" ? row.at : new Date(row.at).toISOString(),
    }));
    const paid = list.filter((row) => row.status === "PAID");
    const due = list.filter((row) => row.status === "DUE");
    return {
      names: names.map((row) => row.name),
      paid: sumByCurrency(paid),
      due: sumByCurrency(due),
      rows: list,
    };
  }

  async add(input: { name: string; amount: number; currency?: string; at?: string; status?: string; note?: string }) {
    const name = String(input.name || "").trim().slice(0, 80);
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!name) throw new BadRequestException("חסר שם עלות");
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("סכום לא תקין");
    const currency = input.currency === "USD" ? "USD" : "ILS";
    const status = input.status === "DUE" ? "DUE" : "PAID";
    const at = parseDay(input.at);
    const note = String(input.note || "").trim().slice(0, 200);
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    await this.ensureTable();
    await this.prisma.$executeRaw`
      INSERT INTO "CostItem" ("id", "name") VALUES (${randomUUID().replace(/-/g, "").slice(0, 24)}, ${name})
      ON CONFLICT ("name") DO NOTHING
    `;
    await this.prisma.$executeRaw`
      INSERT INTO "CostPayment" ("id", "name", "amount", "currency", "at", "status", "note", "createdAt")
      VALUES (${id}, ${name}, ${amount}, ${currency}, ${at}, ${status}, ${note}, CURRENT_TIMESTAMP)
    `;
    this.log.log(`cost ${status} ${name} ${amount} ${currency}`);
    return this.snapshot();
  }

  async markPaid(id: string) {
    const key = String(id || "").trim();
    if (!key) throw new BadRequestException("חסר תשלום");
    await this.ensureTable();
    await this.prisma.$executeRaw`
      UPDATE "CostPayment" SET "status" = 'PAID', "at" = CURRENT_TIMESTAMP WHERE "id" = ${key}
    `;
    return this.snapshot();
  }

  async remove(id: string) {
    const key = String(id || "").trim();
    if (!key) throw new BadRequestException("חסר תשלום");
    await this.ensureTable();
    await this.prisma.$executeRaw`DELETE FROM "CostPayment" WHERE "id" = ${key}`;
    return this.snapshot();
  }

  private async ensureTable() {
    if (this.ready) return;
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CostItem" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        CONSTRAINT "CostItem_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "CostItem_name_key" UNIQUE ("name")
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CostPayment" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "amount" DOUBLE PRECISION NOT NULL,
        "currency" TEXT NOT NULL DEFAULT 'ILS',
        "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "status" TEXT NOT NULL DEFAULT 'PAID',
        "note" TEXT NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CostPayment_pkey" PRIMARY KEY ("id")
      )
    `);
    for (const name of STARTER) {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await this.prisma.$executeRaw`
        INSERT INTO "CostItem" ("id", "name") VALUES (${id}, ${name})
        ON CONFLICT ("name") DO NOTHING
      `;
    }
    this.ready = true;
  }
}

function parseDay(value?: string) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T12:00:00.000Z`);
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return new Date();
}

function sumByCurrency(rows: CostRow[]) {
  const map: Record<string, number> = {};
  for (const row of rows) {
    const key = row.currency === "USD" ? "USD" : "ILS";
    map[key] = Math.round(((map[key] || 0) + Number(row.amount || 0)) * 100) / 100;
  }
  return { ILS: map.ILS || 0, USD: map.USD || 0 };
}
