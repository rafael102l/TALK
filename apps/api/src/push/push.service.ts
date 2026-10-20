import { createSign, randomUUID } from "crypto";
import { connect } from "http2";
import { Injectable, Logger } from "@nestjs/common";
import { getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { PrismaService } from "../prisma/prisma.service";

type CallWake = {
  callId: string;
  callerName: string;
  callerPhone: string;
  video?: boolean;
  caller: { id: string; name: string; phone: string; avatarUrl?: string | null; gender?: string | null };
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private tableReady: Promise<void> | null = null;
  private apnsToken = "";
  private apnsTokenAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async saveCallDevice(userId: string, input: { fcmToken?: string; voipToken?: string }) {
    const fcmToken = input.fcmToken?.trim() || null;
    const voipToken = input.voipToken?.trim() || null;
    if (!fcmToken && !voipToken) return { ok: true };
    await this.ensureTable();
    await this.prisma.$executeRaw`
      INSERT INTO "CallDevice" ("userId", "fcmToken", "voipToken", "updatedAt")
      VALUES (${userId}, ${fcmToken}, ${voipToken}, CURRENT_TIMESTAMP)
      ON CONFLICT ("userId") DO UPDATE SET
        "fcmToken" = COALESCE(EXCLUDED."fcmToken", "CallDevice"."fcmToken"),
        "voipToken" = COALESCE(EXCLUDED."voipToken", "CallDevice"."voipToken"),
        "updatedAt" = CURRENT_TIMESTAMP
    `;
    return { ok: true };
  }

  /** Wake a phone that has no live socket. Returns false when there is no token to try. */
  async notifyIncomingCall(userId: string, incoming: CallWake) {
    try {
      return await this.deliverIncomingCall(userId, incoming);
    } catch (error) {
      this.logger.warn(`Call wake failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async deliverIncomingCall(userId: string, incoming: CallWake) {
    await this.ensureTable();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { expoPushToken: true },
    });
    const rows = await this.prisma.$queryRaw<Array<{ fcmToken: string | null; voipToken: string | null }>>`
      SELECT "fcmToken", "voipToken" FROM "CallDevice" WHERE "userId" = ${userId}
    `;
    const device = rows[0];
    const data = {
      type: "incoming_call",
      callId: incoming.callId,
      callerId: incoming.caller.id,
      callerName: incoming.callerName,
      callerPhone: incoming.callerPhone,
      avatarUrl: incoming.caller.avatarUrl || "",
      gender: incoming.caller.gender || "male",
      video: incoming.video ? "1" : "0",
    };
    let woke = false;
    if (device?.fcmToken) woke = (await this.sendFcmCall(device.fcmToken, data, incoming.callerName, incoming.callerPhone || "שיחה נכנסת")) || woke;
    if (device?.voipToken) woke = (await this.sendVoip(device.voipToken, data)) || woke;
    if (user?.expoPushToken) woke = (await this.sendExpoCall(user.expoPushToken, incoming, data)) || woke;
    if (woke) this.logger.log(`call wake user=${userId} id=${incoming.callId}`);
    return woke;
  }

  async notifyUsers(
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, string>,
    extra: { image?: string | null } = {},
  ) {
    if (!userIds.length) return;
    await this.ensureTable();
    const payload = stringData({ type: data.type || "message", ...data });
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, expoPushToken: true },
    });
    const gotFcm = new Set<string>();
    for (const user of users) {
      const rows = await this.prisma.$queryRaw<Array<{ fcmToken: string | null }>>`
        SELECT "fcmToken" FROM "CallDevice" WHERE "userId" = ${user.id}
      `;
      const fcm = rows[0]?.fcmToken?.trim();
      if (fcm && (await this.sendFcmMessage(fcm, title, body, payload, extra.image))) gotFcm.add(user.id);
    }
    const tokens = users
      .filter((u) => u.expoPushToken && !gotFcm.has(u.id))
      .map((u) => u.expoPushToken)
      .filter((t): t is string => Boolean(t));
    if (!tokens.length) return;
    const walkie = payload.type === "walkie";
    const channelId = walkie ? "walkie_talkie_channel" : "talk-ptt";
    const sound = walkie ? "walkie_talkie" : "default";
    const messages = tokens.map((to) => ({
      to,
      sound,
      title,
      body,
      data: payload,
      channelId,
      priority: "high" as const,
      ...(extra.image
        ? {
            image: extra.image,
            richContent: { image: extra.image },
            mutableContent: true,
          }
        : {}),
    }));
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messages),
      });
    } catch (error) {
      this.logger.warn(`Push failed: ${(error as Error).message}`);
    }
  }

  private ensureTable() {
    this.tableReady ??= this.prisma
      .$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "CallDevice" (
          "userId" TEXT PRIMARY KEY,
          "fcmToken" TEXT,
          "voipToken" TEXT,
          "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      )
      .then(() => undefined)
      .catch((error: Error) => {
        this.tableReady = null;
        this.logger.warn(`CallDevice table: ${error.message}`);
      });
    return this.tableReady;
  }

  private async sendExpoCall(to: string, incoming: CallWake, data: Record<string, string>) {
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          priority: "high",
          channelId: "talk-calls",
          title: incoming.callerName,
          body: incoming.callerPhone || "שיחה נכנסת",
          categoryId: "incoming-call",
          sound: "default",
          ttl: 0,
          data,
        }),
      });
      return response.ok;
    } catch (error) {
      this.logger.warn(`Call push failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async sendFcmCall(token: string, data: Record<string, string>, title: string, body: string) {
    try {
      if (!getApps().length) return false;
      await getMessaging().send({
        token,
        data,
        android: {
          priority: "high",
          ttl: 0,
          collapseKey: "incoming-call",
          directBootOk: true,
        },
        apns: {
          payload: { aps: { sound: "default", "content-available": 1 } },
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(`FCM call failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async sendFcmMessage(
    token: string,
    title: string,
    body: string,
    data: Record<string, string>,
    image?: string | null,
  ) {
    try {
      if (!getApps().length) {
        this.logger.warn("FCM message skipped — Firebase admin is not ready");
        return false;
      }
      const walkie = data.type === "walkie";
      const channelId = walkie ? "walkie_talkie_channel" : "talk-ptt";
      const sound = walkie ? "walkie_talkie" : "default";
      await getMessaging().send({
        token,
        data,
        notification: { title, body, imageUrl: image || undefined },
        android: {
          priority: "high",
          notification: {
            title,
            body,
            channelId,
            sound,
            defaultSound: !walkie,
            imageUrl: image || undefined,
          },
        },
        apns: {
          payload: { aps: { sound: walkie ? "walkie_talkie.mp3" : "default" } },
        },
      });
      this.logger.log(`FCM ${data.type || "message"} channel=${channelId}`);
      return true;
    } catch (error) {
      this.logger.warn(`FCM message failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async sendVoip(token: string, data: Record<string, string>) {
    const key = this.apnsKey();
    const keyId = process.env.APNS_KEY_ID?.trim();
    const teamId = process.env.APNS_TEAM_ID?.trim();
    if (!key || !keyId || !teamId) return false;
    const bundle = process.env.APNS_BUNDLE_ID?.trim() || "app.talk.ptt";
    const host = process.env.APNS_PRODUCTION === "false" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    const jwt = this.apnsJwt(key, keyId, teamId);
    const body = JSON.stringify({
      aps: { "content-available": 1 },
      ...data,
      uuid: data.callId,
    });
    return new Promise<boolean>((resolve) => {
      const session = connect(`https://${host}`);
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": `${bundle}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
        "apns-id": randomUUID(),
      });
      const chunks: Buffer[] = [];
      req.on("response", (headers) => {
        const status = Number(headers[":status"] || 0);
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          session.close();
          if (status !== 200) this.logger.warn(`APNs voip ${status} ${Buffer.concat(chunks).toString("utf8").slice(0, 180)}`);
          resolve(status === 200);
        });
      });
      req.on("error", (error) => {
        session.close();
        this.logger.warn(`APNs voip failed: ${error.message}`);
        resolve(false);
      });
      req.end(body);
    });
  }

  private apnsKey() {
    const raw = process.env.APNS_KEY?.trim() || process.env.APNS_KEY_BASE64?.trim() || "";
    if (!raw) return "";
    if (raw.includes("BEGIN PRIVATE KEY")) return raw.replace(/\\n/g, "\n");
    try {
      return Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return "";
    }
  }

  private apnsJwt(key: string, keyId: string, teamId: string) {
    const now = Math.floor(Date.now() / 1000);
    if (this.apnsToken && now - this.apnsTokenAt < 2400) return this.apnsToken;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString("base64url");
    const signer = createSign("SHA256");
    signer.update(`${header}.${claims}`);
    signer.end();
    const jose = derToJose(signer.sign(key));
    this.apnsToken = `${header}.${claims}.${jose.toString("base64url")}`;
    this.apnsTokenAt = now;
    return this.apnsToken;
  }
}

function stringData(data: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) out[key] = value == null ? "" : String(value);
  return out;
}

function derToJose(der: Buffer) {
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
  const read = () => {
    if (der[offset++] !== 0x02) throw new Error("bad APNs signature");
    const len = der[offset++];
    const bytes = der.subarray(offset, offset + len);
    offset += len;
    return bytes;
  };
  const r = read();
  const s = read();
  const out = Buffer.alloc(64);
  const copy = (src: Buffer, at: number) => {
    const start = src[0] === 0 ? 1 : 0;
    const slice = src.subarray(start);
    slice.copy(out, at + (32 - slice.length));
  };
  copy(r, 0);
  copy(s, 32);
  return out;
}
