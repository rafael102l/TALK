import { BadRequestException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { User } from "@prisma/client";
import { currentLanBase } from "../lan-base";
import { PrismaService } from "../prisma/prisma.service";
import { PushService } from "../push/push.service";
import {
  COMPANY_VALUATION_USD,
  INVESTOR_POOL_PCT,
  MAX_INVEST_USD,
  MIN_INVEST_USD,
  PENDING_TTL_MS,
  cardcomLang,
  companyPercent,
  formatPercent,
} from "./invest.constants";

type InvestRow = {
  id: string;
  userId: string;
  phoneE164: string;
  displayName: string;
  amountUsd: number;
  percent: string;
  status: string;
  lowProfileId: string | null;
  cardcomTxId: string | null;
  paidAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class InvestmentsService implements OnModuleInit {
  private readonly log = new Logger(InvestmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  async onModuleInit() {
    await this.ensureTable();
  }

  private cardcom() {
    const terminal = Number((process.env.CARDCOM_TERMINAL || "").trim());
    const apiName = (process.env.CARDCOM_API_NAME || "").trim();
    const apiPassword = (process.env.CARDCOM_API_PASSWORD || "").trim();
    if (!terminal || !apiName) {
      throw new ServiceUnavailableException("Cardcom is not configured");
    }
    return { terminal, apiName, apiPassword };
  }

  private async ensureTable() {
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Investment" (
          "id" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          "phoneE164" TEXT NOT NULL,
          "displayName" TEXT NOT NULL DEFAULT '',
          "amountUsd" DOUBLE PRECISION NOT NULL,
          "percent" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'PENDING',
          "lowProfileId" TEXT,
          "cardcomTxId" TEXT,
          "paidAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "Investment_pkey" PRIMARY KEY ("id")
        )
      `);
      await this.prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "Investment_lowProfileId_key" ON "Investment"("lowProfileId")`,
      );
      await this.prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Investment_userId_status_idx" ON "Investment"("userId", "status")`,
      );
    } catch (error) {
      this.log.warn(`investment table: ${(error as Error).message}`);
    }
  }

  private async expireStale() {
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    await this.prisma.$executeRaw`
      UPDATE "Investment"
      SET "status" = 'EXPIRED', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "status" = 'PENDING' AND "createdAt" < ${cutoff}
    `;
  }

  private async poolUsedPct() {
    await this.expireStale();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const rows = await this.prisma.$queryRaw<Array<{ percent: string }>>`
      SELECT "percent" FROM "Investment"
      WHERE "status" = 'PAID' OR ("status" = 'PENDING' AND "createdAt" > ${cutoff})
    `;
    return rows.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
  }

  async summary(user: User) {
    await this.ensureTable();
    await this.expireStale();
    const usedPct = await this.poolUsedPct();
    const remainingPct = Math.max(0, INVESTOR_POOL_PCT - usedPct);
    const remainingUsd = Math.min(MAX_INVEST_USD, (remainingPct / 100) * COMPANY_VALUATION_USD);
    const mine = await this.prisma.$queryRaw<InvestRow[]>`
      SELECT * FROM "Investment" WHERE "userId" = ${user.id} ORDER BY "createdAt" DESC
    `;
    const paid = mine.filter((row) => row.status === "PAID");
    const myAmount = paid.reduce((sum, row) => sum + Number(row.amountUsd || 0), 0);
    const myPercent = paid.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
    return {
      valuationUsd: COMPANY_VALUATION_USD,
      poolPct: INVESTOR_POOL_PCT,
      minUsd: MIN_INVEST_USD,
      maxUsd: Math.max(MIN_INVEST_USD, Math.floor(remainingUsd)),
      remainingPct: formatPercent(remainingPct),
      usedPct: formatPercent(usedPct),
      myAmountUsd: Math.round(myAmount * 100) / 100,
      myPercent: formatPercent(myPercent),
      holdings: paid.map((row) => ({
        id: row.id,
        amountUsd: row.amountUsd,
        percent: row.percent,
        at: row.paidAt || row.createdAt,
      })),
    };
  }

  async checkout(user: User, amountUsd: number) {
    const amount = Math.round(Number(amountUsd) * 100) / 100;
    if (!Number.isFinite(amount) || amount < MIN_INVEST_USD) {
      throw new BadRequestException("סכום ההשקעה קטן מדי");
    }
    if (amount > MAX_INVEST_USD) {
      throw new BadRequestException("סכום ההשקעה גדול מדי");
    }
    await this.ensureTable();
    const usedPct = await this.poolUsedPct();
    const wantPct = companyPercent(amount);
    if (usedPct + wantPct > INVESTOR_POOL_PCT + 1e-12) {
      throw new BadRequestException("המאגר של 20% כבר מלא");
    }
    const cfg = this.cardcom();
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    const percent = formatPercent(wantPct);
    const base = currentLanBase();
    await this.prisma.$executeRaw`
      INSERT INTO "Investment" (
        "id", "userId", "phoneE164", "displayName", "amountUsd", "percent", "status", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${user.id}, ${user.phoneE164 || ""}, ${user.displayName || ""},
        ${amount}, ${percent}, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;
    const body: Record<string, unknown> = {
      TerminalNumber: cfg.terminal,
      ApiName: cfg.apiName,
      Operation: "ChargeOnly",
      Amount: amount,
      ISOCoinId: 2,
      Language: cardcomLang(user.speakLang || user.listenLang),
      ProductName: "TalkHim investment",
      ReturnValue: id,
      SuccessRedirectUrl: `${base}/investments/done?ok=1`,
      FailedRedirectUrl: `${base}/investments/done?ok=0`,
      WebHookUrl: `${base}/investments/webhook`,
      UIDefinition: {
        CardOwnerNameValue: user.displayName || "",
        CardOwnerPhoneValue: user.phoneE164 || "",
        IsHideCardOwnerIdentityNumber: true,
      },
      AdvancedDefinition: {
        ...(cfg.apiPassword ? { ApiPassword: cfg.apiPassword } : {}),
        MaxNumOfPayments: 1,
        MinNumOfPayments: 1,
        ISOCoinName: "USD",
      },
    };
    let created = await this.cardcomPost("https://secure.cardcom.solutions/api/v11/LowProfile/Create", body);
    let code = Number(created.ResponseCode ?? created.responseCode ?? -1);
    let url = String(created.Url || created.url || "").trim();
    if (code !== 0 || !url) {
      created = await this.cardcomPost("https://secure.cardcom.solutions/api/v11/LowProfile/Create", {
        TerminalNumber: cfg.terminal,
        ApiName: cfg.apiName,
        Operation: "ChargeOnly",
        Amount: amount,
        ISOCoinId: 2,
        Language: cardcomLang(user.speakLang || user.listenLang),
        ProductName: "TalkHim investment",
        ReturnValue: id,
        SuccessRedirectUrl: `${base}/investments/done?ok=1`,
        FailedRedirectUrl: `${base}/investments/done?ok=0`,
        WebHookUrl: `${base}/investments/webhook`,
      });
      code = Number(created.ResponseCode ?? created.responseCode ?? -1);
      url = String(created.Url || created.url || "").trim();
    }
    const lowProfileId = String(created.LowProfileId || created.lowProfileId || "").trim() || null;
    if (code !== 0 || !url) {
      await this.prisma.$executeRaw`
        UPDATE "Investment" SET "status" = 'FAILED', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}
      `;
      this.log.warn(`cardcom create failed code=${code} desc=${String(created.Description || "")}`);
      throw new BadRequestException("לא ניתן לפתוח את דף התשלום כרגע");
    }
    if (lowProfileId) {
      await this.prisma.$executeRaw`
        UPDATE "Investment"
        SET "lowProfileId" = ${lowProfileId}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${id}
      `;
    }
    return { id, url, amountUsd: amount, percent };
  }

  async webhook(raw: Record<string, unknown>) {
    const lowProfileId = String(
      raw.LowProfileId || raw.lowProfileId || raw.lowprofilecode || raw.LowProfileCode || "",
    ).trim();
    const returnValue = String(raw.ReturnValue || raw.returnValue || "").trim();
    if (!lowProfileId && !returnValue) return { ok: true };
    await this.markPaid(lowProfileId, returnValue);
    return { ok: true };
  }

  async confirmById(id: string) {
    if (!id) return { ok: false };
    await this.markPaid("", id);
    return { ok: true };
  }

  private async markPaid(lowProfileId: string, returnValue: string) {
    await this.ensureTable();
    const cfg = this.cardcom();
    const lp = lowProfileId || undefined;
    let row: InvestRow | undefined;
    if (lp) {
      const found = await this.prisma.$queryRaw<InvestRow[]>`
        SELECT * FROM "Investment" WHERE "lowProfileId" = ${lp} LIMIT 1
      `;
      row = found[0];
    }
    if (!row && returnValue) {
      const found = await this.prisma.$queryRaw<InvestRow[]>`
        SELECT * FROM "Investment" WHERE "id" = ${returnValue} LIMIT 1
      `;
      row = found[0];
    }
    const profileId = lp || row?.lowProfileId;
    if (!profileId) return;
    const result = await this.cardcomPost("https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult", {
      TerminalNumber: cfg.terminal,
      ApiName: cfg.apiName,
      LowProfileId: profileId,
      ...(cfg.apiPassword ? { ApiPassword: cfg.apiPassword } : {}),
    });
    const ok = Number(result.ResponseCode ?? result.responseCode ?? -1) === 0;
    const txId = String(
      result.TranzactionId || result.TransactionId || result.tranzactionId || "",
    ).trim();
    const dealOk =
      ok &&
      (txId ||
        Number((result.TranzactionInfo as { ResponseCode?: number } | undefined)?.ResponseCode ?? 0) === 0);
    if (!row) {
      const found = await this.prisma.$queryRaw<InvestRow[]>`
        SELECT * FROM "Investment" WHERE "lowProfileId" = ${profileId} LIMIT 1
      `;
      row = found[0];
    }
    if (!row) return;
    if (row.status === "PAID") return;
    if (!dealOk) {
      await this.prisma.$executeRaw`
        UPDATE "Investment"
        SET "status" = 'FAILED', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${row.id} AND "status" = 'PENDING'
      `;
      return;
    }
    const now = new Date();
    await this.prisma.$executeRaw`
      UPDATE "Investment"
      SET "status" = 'PAID',
          "cardcomTxId" = ${txId || row.cardcomTxId},
          "lowProfileId" = ${profileId},
          "paidAt" = ${now},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${row.id} AND "status" <> 'PAID'
    `;
    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { speakLang: true, listenLang: true },
    });
    const lang = user?.speakLang || user?.listenLang || "he";
    void this.push.notifyUsers(
      [row.userId],
      investText(lang, "title"),
      investText(lang, "body", row.amountUsd, row.percent),
      { type: "invest", kind: "invest", investmentId: row.id },
    );
    this.log.log(`investment paid id=${row.id} usd=${row.amountUsd} pct=${row.percent}`);
  }

  async adminList() {
    await this.ensureTable();
    await this.expireStale();
    const rows = await this.prisma.$queryRaw<InvestRow[]>`
      SELECT * FROM "Investment" WHERE "status" = 'PAID' ORDER BY "paidAt" DESC, "createdAt" DESC LIMIT 300
    `;
    const amountUsd = rows.reduce((sum, row) => sum + Number(row.amountUsd || 0), 0);
    const percent = rows.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
    return {
      count: rows.length,
      amountUsd: Math.round(amountUsd * 100) / 100,
      percent: formatPercent(percent),
      remainingPct: formatPercent(Math.max(0, INVESTOR_POOL_PCT - percent)),
      rows: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.displayName || "—",
        phone: row.phoneE164,
        amountUsd: row.amountUsd,
        percent: row.percent,
        at: (row.paidAt || row.createdAt).toISOString?.() || String(row.paidAt || row.createdAt),
      })),
    };
  }

  private async cardcomPost(url: string, body: Record<string, unknown>) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.log.warn(`cardcom non-json ${res.status} ${text.slice(0, 180)}`);
      return { ResponseCode: -1, Description: text.slice(0, 180) };
    }
  }
}

function investText(lang: string, key: "title" | "body", amount?: number, percent?: string) {
  const code = (lang || "he").split("-")[0].toLowerCase();
  const title: Record<string, string> = {
    he: "ההשקעה ב־TalkHim נקלטה",
    en: "Your TalkHim investment is in",
    ar: "تم تسجيل استثمارك في TalkHim",
    ru: "Ваша инвестиция в TalkHim принята",
    fr: "Votre investissement TalkHim est enregistré",
    es: "Tu inversión en TalkHim quedó registrada",
    de: "Ihre TalkHim-Investition ist eingegangen",
  };
  if (key === "title") return title[code] || title.en;
  const usd = `$${Number(amount || 0).toLocaleString("en-US")}`;
  const pct = `${percent || "0"}%`;
  const body: Record<string, string> = {
    he: `השקעתם ${usd}. יש לכם ${pct} מהחברה, ללא זכות הצבעה.`,
    en: `You invested ${usd}. You now hold ${pct} of the company, with no voting rights.`,
    ar: `استثمرت ${usd}. لديك ${pct} من الشركة، دون حق التصويت.`,
    ru: `Вы вложили ${usd}. Вам принадлежит ${pct} компании, без права голоса.`,
    fr: `Vous avez investi ${usd}. Vous détenez ${pct} de la société, sans droit de vote.`,
    es: `Invertiste ${usd}. Tienes ${pct} de la compañía, sin derecho a voto.`,
    de: `Sie haben ${usd} investiert. Sie halten ${pct} der Gesellschaft, ohne Stimmrecht.`,
  };
  return body[code] || body.en;
}
