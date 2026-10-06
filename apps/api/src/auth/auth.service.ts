import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { hashPhone, toE164 } from "@talk/shared";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { toPublicUser } from "../users/user.mapper";

const OTP_TTL_MS = 5 * 60 * 1000;

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

  async requestOtp(phone: string) {
    const phoneE164 = this.normalizePhone(phone);
    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    try {
      await this.prisma.otpCode.updateMany({
        where: { phoneE164, consumed: false },
        data: { consumed: true },
      });
      await this.prisma.otpCode.create({
        data: {
          phoneE164,
          codeHash,
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        },
      });
    } catch (error) {
      console.error("[TALK OTP] database error", (error as Error).message);
      throw error;
    }
    await this.sendSms(
      phoneE164,
      `קוד הכניסה ל-TALK: ${code}. הקוד תקף ל-5 דקות.`,
    );
    const showDev =
      process.env.NODE_ENV !== "production" || process.env.OTP_ALLOW_DEV_BYPASS === "true";
    if (showDev) {
      console.log(`[TALK OTP] ${phoneE164} → ${code} (also accepts ${process.env.OTP_DEV_CODE ?? "000000"})`);
    }
    return { ok: true, phoneE164, devCode: showDev ? code : undefined };
  }

  async verifyOtp(phone: string, code: string) {
    const phoneE164 = this.normalizePhone(phone);
    const latest = await this.prisma.otpCode.findFirst({
      where: { phoneE164, consumed: false },
      orderBy: { createdAt: "desc" },
    });
    const devCode = process.env.OTP_DEV_CODE ?? "000000";
    const allowDevBypass =
      process.env.NODE_ENV !== "production" || process.env.OTP_ALLOW_DEV_BYPASS === "true";
    const isDevBypass = allowDevBypass && code === devCode;
    if (!latest && !isDevBypass) throw new UnauthorizedException("קוד לא תקין או שפג תוקפו");
    if (latest && latest.expiresAt < new Date() && !isDevBypass) {
      throw new UnauthorizedException("קוד לא תקין או שפג תוקפו");
    }
    const matches = latest ? await bcrypt.compare(code, latest.codeHash) : false;
    if (!matches && !isDevBypass) throw new UnauthorizedException("קוד שגוי");
    if (latest) {
      await this.prisma.otpCode.update({ where: { id: latest.id }, data: { consumed: true } });
    }

    const salt = process.env.CONTACT_HASH_SALT ?? "talk-contact-salt-dev";
    const phoneHash = hashPhone(phoneE164, salt);
    let user = await this.prisma.user.findUnique({ where: { phoneE164 } });
    const isNew = !user;
    if (!user) {
      user = await this.prisma.user.create({
        data: { phoneE164, phoneHash, sessionVersion: 1 },
      });
      await this.prisma.contact.updateMany({
        where: { phoneHash, matchedUserId: null },
        data: { matchedUserId: user.id },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion: { increment: 1 } },
      });
    }
    // Drop any live sockets from a previous device before the new token is used.
    this.realtime.revokeUserSessions(user.id);
    const token = await this.jwt.signAsync({
      sub: user.id,
      phone: user.phoneE164,
      sv: user.sessionVersion,
    });
    return { token, user: toPublicUser(user), isNew };
  }

  private generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
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
}
