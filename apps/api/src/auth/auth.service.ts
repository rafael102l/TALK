import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { User } from "@prisma/client";
import { hashPhone, toE164 } from "@talk/shared";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { toPublicUser } from "../users/user.mapper";

const OTP_TTL_MS = 5 * 60 * 1000;
const TRANSFER_TTL_SEC = 15 * 60;

type TransferChallengePayload = {
  typ: "device_transfer";
  sub: string;
  phone: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private normalizePhone(phone: string) {
    const e164 = toE164(phone);
    if (!e164) throw new BadRequestException("מספר טלפון לא תקין");
    return e164;
  }

  private normalizeEmail(email: string) {
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new BadRequestException("כתובת אימייל לא תקינה");
    }
    return trimmed;
  }

  private maskEmail(email: string | null | undefined) {
    if (!email) return null;
    const [local, domain] = email.split("@");
    if (!local || !domain) return null;
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
  }

  private generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  private allowDevBypass() {
    return process.env.NODE_ENV !== "production" || process.env.OTP_ALLOW_DEV_BYPASS === "true";
  }

  private async issueSession(user: User) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        sessionVersion: { increment: 1 },
        sessionActive: true,
      },
    });
    this.realtime.revokeUserSessions(updated.id);
    const token = await this.jwt.signAsync({
      sub: updated.id,
      phone: updated.phoneE164,
      sv: updated.sessionVersion,
    });
    return { token, user: toPublicUser(updated) };
  }

  async requestOtp(phone: string) {
    const phoneE164 = this.normalizePhone(phone);
    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    try {
      await this.prisma.otpCode.updateMany({
        where: { phoneE164, consumed: false, purpose: "login" },
        data: { consumed: true },
      });
      await this.prisma.otpCode.create({
        data: {
          phoneE164,
          codeHash,
          purpose: "login",
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        },
      });
    } catch (error) {
      console.error("[TALK OTP] database error", (error as Error).message);
      throw error;
    }
    const smsOk = await this.sendSms(
      phoneE164,
      `קוד הכניסה ל-TALK: ${code}. הקוד תקף ל-5 דקות.`,
    );
    const showDev = this.allowDevBypass();
    if (!smsOk) {
      console.warn(`[TALK OTP] SMS not sent to ${phoneE164} — check TWILIO_* env and trial verified numbers`);
    } else {
      console.log(`[TALK OTP] SMS queued to ${phoneE164}`);
    }
    if (showDev) {
      console.log(`[TALK OTP] ${phoneE164} → ${code} (also accepts ${process.env.OTP_DEV_CODE ?? "000000"})`);
    }
    return { ok: true, phoneE164, smsSent: smsOk, devCode: showDev ? code : undefined };
  }

  async verifyOtp(phone: string, code: string) {
    const phoneE164 = this.normalizePhone(phone);
    await this.consumeOtp({
      phoneE164,
      purpose: "login",
      code,
      destination: null,
    });

    const salt = process.env.CONTACT_HASH_SALT ?? "talk-contact-salt-dev";
    const phoneHash = hashPhone(phoneE164, salt);
    let user = await this.prisma.user.findUnique({ where: { phoneE164 } });
    const isNew = !user;
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phoneE164,
          phoneHash,
          sessionVersion: 0,
          sessionActive: false,
        },
      });
      await this.prisma.contact.updateMany({
        where: { phoneHash, matchedUserId: null },
        data: { matchedUserId: user.id },
      });
      const session = await this.issueSession(user);
      return { ...session, isNew: true };
    }

    // Account already signed in elsewhere → WhatsApp-style device transfer.
    if (user.sessionActive) {
      return this.beginDeviceTransfer(user);
    }

    const session = await this.issueSession(user);
    return { ...session, isNew: false };
  }

  private async beginDeviceTransfer(user: User) {
    const challengeToken = await this.jwt.signAsync(
      {
        typ: "device_transfer",
        sub: user.id,
        phone: user.phoneE164,
      } satisfies TransferChallengePayload,
      { expiresIn: TRANSFER_TTL_SEC },
    );

    await this.createPurposeOtp({
      phoneE164: user.phoneE164,
      purpose: "transfer_sms",
      destination: user.phoneE164,
      message: (code) =>
        `TALK: קוד אימות מכשיר חדש: ${code}. הזינו אותו יחד עם האימייל לאישור שהחשבון שלכם.`,
    });

    if (user.email) {
      await this.createPurposeOtp({
        phoneE164: user.phoneE164,
        purpose: "transfer_email",
        destination: user.email,
        message: (code) =>
          `קוד אימות מכשיר חדש ב-TALK: ${code}. אם לא ביקשתם להתחבר ממכשיר אחר — התעלמו.`,
      });
    }

    return {
      requiresDeviceTransfer: true as const,
      challengeToken,
      phoneE164: user.phoneE164,
      emailMasked: this.maskEmail(user.email),
      hasEmail: Boolean(user.email),
    };
  }

  async confirmDeviceTransfer(input: {
    challengeToken: string;
    email: string;
    smsCode: string;
    emailCode?: string;
    confirmOwnership: boolean;
  }) {
    if (!input.confirmOwnership) {
      throw new BadRequestException("יש לאשר שזה החשבון שלך");
    }

    let payload: TransferChallengePayload;
    try {
      payload = await this.jwt.verifyAsync<TransferChallengePayload>(input.challengeToken);
    } catch {
      throw new UnauthorizedException("תוקף אימות המכשיר פג — התחילו מחדש");
    }
    if (payload.typ !== "device_transfer" || !payload.sub || !payload.phone) {
      throw new UnauthorizedException("אתגר לא תקין");
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.phoneE164 !== payload.phone) {
      throw new UnauthorizedException("משתמש לא נמצא");
    }
    if (!user.sessionActive) {
      // Already logged out on the other device — plain login is enough.
      throw new BadRequestException("החשבון כבר מנותק במכשיר הקודם — היכנסו שוב עם קוד SMS");
    }

    const email = this.normalizeEmail(input.email);
    await this.consumeOtp({
      phoneE164: user.phoneE164,
      purpose: "transfer_sms",
      code: input.smsCode,
      destination: user.phoneE164,
    });

    if (user.email) {
      if (user.email.toLowerCase() !== email) {
        throw new BadRequestException("האימייל לא תואם לחשבון");
      }
      if (!input.emailCode) {
        throw new BadRequestException("חסר קוד האימייל");
      }
      await this.consumeOtp({
        phoneE164: user.phoneE164,
        purpose: "transfer_email",
        code: input.emailCode,
        destination: user.email,
      });
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { email },
      });
    }

    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const session = await this.issueSession(fresh);
    return { ...session, isNew: false };
  }

  async logout(user: User) {
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        sessionActive: false,
        sessionVersion: { increment: 1 },
      },
    });
    this.realtime.revokeUserSessions(user.id);
    return { ok: true };
  }

  private async createPurposeOtp(opts: {
    phoneE164: string;
    purpose: string;
    destination: string;
    message: (code: string) => string;
  }) {
    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    await this.prisma.otpCode.updateMany({
      where: {
        phoneE164: opts.phoneE164,
        purpose: opts.purpose,
        consumed: false,
      },
      data: { consumed: true },
    });
    await this.prisma.otpCode.create({
      data: {
        phoneE164: opts.phoneE164,
        codeHash,
        purpose: opts.purpose,
        destination: opts.destination,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    const body = opts.message(code);
    if (opts.purpose === "transfer_email") {
      const emailed = await this.sendEmail(opts.destination, "TALK — אימות מכשיר חדש", body);
      if (!emailed) {
        // Fallback: SMS so transfer still works without an email provider configured.
        await this.sendSms(opts.phoneE164, `TALK (קוד אימייל): ${code}`);
      }
    } else {
      await this.sendSms(opts.destination, body);
    }

    if (this.allowDevBypass()) {
      console.log(`[TALK OTP ${opts.purpose}] ${opts.destination} → ${code}`);
    }
  }

  private async consumeOtp(opts: {
    phoneE164: string;
    purpose: string;
    code: string;
    destination: string | null;
  }) {
    const latest = await this.prisma.otpCode.findFirst({
      where: {
        phoneE164: opts.phoneE164,
        purpose: opts.purpose,
        consumed: false,
        ...(opts.destination ? { destination: opts.destination } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    const devCode = process.env.OTP_DEV_CODE ?? "000000";
    const isDevBypass = this.allowDevBypass() && opts.code === devCode;
    if (!latest && !isDevBypass) throw new UnauthorizedException("קוד לא תקין או שפג תוקפו");
    if (latest && latest.expiresAt < new Date() && !isDevBypass) {
      throw new UnauthorizedException("קוד לא תקין או שפג תוקפו");
    }
    const matches = latest ? await bcrypt.compare(opts.code, latest.codeHash) : false;
    if (!matches && !isDevBypass) throw new UnauthorizedException("קוד שגוי");
    if (latest) {
      await this.prisma.otpCode.update({ where: { id: latest.id }, data: { consumed: true } });
    }
  }

  async sendSms(to: string, body: string): Promise<boolean> {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) return false;
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    if (!res.ok) {
      console.warn("Twilio SMS failed", await res.text());
      return false;
    }
    return true;
  }

  async sendEmail(to: string, subject: string, text: string): Promise<boolean> {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM ?? "TALK <onboarding@resend.dev>";
    if (!key) {
      console.warn(`[TALK EMAIL] RESEND_API_KEY missing — would send to ${to}: ${text}`);
      return false;
    }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) {
        console.warn("Resend email failed", await res.text());
        return false;
      }
      return true;
    } catch (error) {
      console.warn("Resend email error", (error as Error).message);
      return false;
    }
  }
}
