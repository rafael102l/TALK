import { createSign, randomUUID } from "crypto";
import { existsSync } from "fs";
import { connect } from "http2";
import { isAbsolute, resolve } from "path";
import { Injectable, Logger } from "@nestjs/common";
import { cert, getApps, initializeApp } from "firebase-admin/app";
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
  private lastChatPushAt = new Map<string, number>();

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
    this.logger.log(`call device saved user=${userId} fcm=${Boolean(fcmToken)} voip=${Boolean(voipToken)}`);
    return { ok: true };
  }

  /** Visible lock-screen FCM when the recipient has no live socket. */
  async notifyOfflineMessage(
    userId: string,
    input: {
      transmissionId?: string;
      kind?: string;
      type?: string;
      senderName?: string;
      senderPhone?: string;
      senderId?: string;
      senderAvatarUrl?: string | null;
      channelId?: string;
      audioUrl?: string | null;
      originalText?: string | null;
      translatedText?: string | null;
      speakLang?: string;
      language?: string;
    },
  ) {
    const transmissionId = String(input.transmissionId || "").trim();
    if (!userId || !transmissionId) return false;
    const key = `${userId}:${transmissionId}`;
    const now = Date.now();
    if ((this.lastChatPushAt.get(key) ?? 0) > now - 2_000) return true;
    this.lastChatPushAt.set(key, now);
    if (this.lastChatPushAt.size > 200) {
      for (const [id, at] of this.lastChatPushAt) {
        if (now - at > 60_000) this.lastChatPushAt.delete(id);
      }
    }
    const walkie = input.kind === "walkie" || input.type === "walkie";
    const name = (input.senderName || input.senderPhone || "TALK").trim() || "TALK";
    const text = String(input.translatedText || input.originalText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    const title = name;
    const body = text || (walkie ? "ווקי-טוקי" : "הודעה חדשה");
    const data = stringData({
      type: walkie ? "walkie" : "message",
      kind: walkie ? "walkie" : input.kind || "text",
      title,
      body,
      transmissionId,
      channelId: input.channelId || "",
      senderId: input.senderId || "",
      senderName: name,
      senderPhone: input.senderPhone || "",
      senderAvatarUrl: input.senderAvatarUrl || "",
      audioUrl: input.audioUrl || "",
      originalText: input.originalText || "",
      translatedText: input.translatedText || "",
      speakLang: input.speakLang || "",
      language: input.language || "",
    });
    try {
      await this.ensureTable();
      const rows = await this.prisma.$queryRaw<Array<{ fcmToken: string | null }>>`
        SELECT "fcmToken" FROM "CallDevice" WHERE "userId" = ${userId}
      `;
      const token = rows[0]?.fcmToken?.trim();
      if (!token) {
        this.logger.warn(`chat FCM skipped — no fcmToken user=${userId} id=${transmissionId}`);
      } else if (await this.sendFcmDisplay(token, title, body, data)) {
        this.logger.log(`chat fcm user=${userId} id=${transmissionId} kind=${data.kind}`);
        return true;
      }
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { expoPushToken: true },
      });
      const expo = user?.expoPushToken?.trim();
      if (!expo) {
        this.logger.warn(
          `chat wake missed user=${userId} id=${transmissionId} fcm=${Boolean(token)} expo=no`,
        );
        return false;
      }
      const ok = await this.sendExpoChat(expo, title, body, data);
      if (ok) this.logger.log(`chat expo user=${userId} id=${transmissionId} kind=${data.kind}`);
      else this.logger.warn(`chat wake missed user=${userId} id=${transmissionId} expo=fail`);
      return ok;
    } catch (error) {
      this.logger.warn(`chat wake failed: ${(error as Error).message}`);
      return false;
    }
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
    let via = "";
    if (device?.fcmToken) {
      if (await this.sendFcmCall(device.fcmToken, data, incoming.callerName, incoming.callerPhone || "שיחה נכנסת")) {
        via = "fcm";
      }
    } else {
      this.logger.warn(`call FCM skipped — no fcmToken user=${userId} id=${incoming.callId}`);
    }
    if (!via && device?.voipToken && (await this.sendVoip(device.voipToken, data))) via = "voip";
    if (!via && user?.expoPushToken && (await this.sendExpoCall(user.expoPushToken, incoming, data))) via = "expo";
    if (via) this.logger.log(`call wake user=${userId} id=${incoming.callId} via=${via}`);
    else this.logger.warn(`call wake missed user=${userId} id=${incoming.callId} fcm=${Boolean(device?.fcmToken)} expo=${Boolean(user?.expoPushToken)}`);
    return Boolean(via);
  }

  async notifyCallEnded(userId: string, callId: string, reason = "cancelled") {
    try {
      await this.ensureTable();
      const rows = await this.prisma.$queryRaw<Array<{ fcmToken: string | null }>>`
        SELECT "fcmToken" FROM "CallDevice" WHERE "userId" = ${userId}
      `;
      const token = rows[0]?.fcmToken?.trim();
      const data = { type: "call_ended", callId, reason: reason || "cancelled" };
      if (!token) this.logger.warn(`call end FCM skipped — no fcmToken user=${userId} id=${callId}`);
      else if (await this.sendFcmCall(token, data, "TALK", "השיחה הסתיימה")) {
        this.logger.log(`call end fcm user=${userId} id=${callId} reason=${reason}`);
        return true;
      }
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { expoPushToken: true },
      });
      const expo = user?.expoPushToken?.trim();
      if (!expo) return false;
      const ok = await this.sendExpoCallSilent(expo, data);
      if (ok) this.logger.log(`call end expo user=${userId} id=${callId}`);
      return ok;
    } catch (error) {
      this.logger.warn(`Call end wake failed: ${(error as Error).message}`);
      return false;
    }
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
    const walkie = payload.type === "walkie" || payload.kind === "walkie";
    const channelId = walkie ? "walkie_talkie_channel" : "talk-text";
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

  private async sendExpoCallSilent(to: string, data: Record<string, string>) {
    return this.postExpo({
      to,
      priority: "high",
      channelId: "talk-calls",
      ttl: 60,
      title: "TALK",
      body: "השיחה הסתיימה",
      data,
    }, "call-end expo");
  }

  private async sendExpoCall(to: string, incoming: CallWake, data: Record<string, string>) {
    return this.postExpo({
      to,
      priority: "high",
      channelId: "talk-calls-fcm",
      title: incoming.callerName,
      body: incoming.callerPhone || "שיחה נכנסת",
      categoryId: "incoming-call",
      sound: "default",
      ttl: 60,
      data,
    }, "call expo");
  }

  private ensureAdmin() {
    if (getApps().length) return true;
    try {
      const cred = loadFirebaseCert();
      if (!cred) {
        this.logger.warn("FCM admin skipped — no service account");
        return false;
      }
      initializeApp({ credential: typeof cred === "string" ? cert(cred) : cert(cred) });
      this.logger.log("FCM admin ready");
      return true;
    } catch (error) {
      this.logger.warn(`FCM admin init failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async sendExpoChat(to: string, title: string, body: string, data: Record<string, string>) {
    const walkie = data.type === "walkie" || data.kind === "walkie";
    return this.postExpo({
      to,
      sound: walkie ? "walkie_talkie" : "default",
      title,
      body,
      data,
      channelId: walkie ? "walkie_talkie_channel" : "talk-text",
      priority: "high",
      ttl: 300,
    }, "chat expo");
  }

  private async postExpo(message: Record<string, unknown>, label: string) {
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(message),
      });
      const json = (await response.json().catch(() => null)) as
        | { data?: { status?: string; message?: string; details?: { error?: string } } | Array<{ status?: string; message?: string; details?: { error?: string } }> }
        | null;
      const tickets = Array.isArray(json?.data) ? json.data : json?.data ? [json.data] : [];
      const err = tickets.find((row) => row.status === "error");
      if (err) {
        this.logger.warn(`${label} ticket ${err.message || err.details?.error || "error"}`);
        return false;
      }
      if (!response.ok) {
        this.logger.warn(`${label} http ${response.status}`);
        return false;
      }
      return tickets.length ? tickets.some((row) => row.status === "ok") : true;
    } catch (error) {
      this.logger.warn(`${label} failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async sendFcmDisplay(token: string, title: string, body: string, data: Record<string, string>) {
    try {
      if (!this.ensureAdmin()) {
        this.logger.warn("FCM display skipped — Firebase admin is not ready");
        return false;
      }
      const walkie = data.type === "walkie" || data.kind === "walkie";
      const channelId = walkie ? "walkie_talkie_channel" : "talk-text";
      const sound = walkie ? "walkie_talkie" : "default";
      const tag = `${walkie ? "walkie" : "text"}-${(data.transmissionId || "clip").slice(0, 24)}`;
      await getMessaging().send({
        token,
        data,
        notification: { title, body },
        android: {
          priority: "high",
          ttl: 86_400_000,
          collapseKey: tag,
          directBootOk: true,
          notification: {
            title,
            body,
            channelId,
            sound,
            defaultSound: !walkie,
            visibility: "public" as const,
            priority: "high" as const,
            tag,
          },
        },
        apns: {
          payload: {
            aps: {
              alert: { title, body },
              sound: walkie ? "walkie_talkie.mp3" : "default",
            },
          },
          headers: { "apns-priority": "10" },
        },
      });
      this.logger.log(`FCM display channel=${channelId} walkie=${walkie}`);
      return true;
    } catch (error) {
      this.logger.warn(`FCM display failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async sendFcmCall(token: string, data: Record<string, string>, title: string, body: string) {
    try {
      if (!this.ensureAdmin()) {
        this.logger.warn("FCM call skipped — Firebase admin is not ready");
        return false;
      }
      const ended = data.type === "call_ended" || data.type === "call_cancel";
      const tag = `talk-call-${data.callId || "x"}`;
      await getMessaging().send({
        token,
        data,
        notification: { title, body },
        android: {
          priority: "high",
          ttl: ended ? 30_000 : 60_000,
          collapseKey: tag,
          directBootOk: true,
          notification: {
            title,
            body,
            channelId: ended ? "talk-calls-wake" : "talk-calls-fcm",
            ...(ended ? {} : { sound: "default", defaultSound: true }),
            visibility: "public" as const,
            priority: "max" as const,
            tag,
          },
        },
        apns: {
          payload: {
            aps: ended
              ? { alert: { title, body }, "content-available": 1 }
              : { sound: "default", alert: { title, body }, "content-available": 1 },
          },
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
    return this.sendFcmDisplay(token, title, body, {
      ...data,
      title,
      body,
      type: data.type || "message",
      ...(image ? { image } : {}),
    });
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

function loadFirebaseCert(): string | Record<string, string> | null {
  const fromBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (fromBase64) {
    return JSON.parse(Buffer.from(fromBase64, "base64").toString("utf8")) as Record<string, string>;
  }
  let inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim() || "";
  if (inline) {
    if (
      (inline.startsWith("'") && inline.endsWith("'")) ||
      (inline.startsWith('"') && inline.endsWith('"') && !inline.startsWith('{"'))
    ) {
      inline = inline.slice(1, -1);
    }
    if (inline.startsWith("{")) return JSON.parse(inline) as Record<string, string>;
  }
  const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
  const credPath = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  if (!existsSync(credPath)) return null;
  return credPath;
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
