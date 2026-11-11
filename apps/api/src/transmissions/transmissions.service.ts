import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { decodeReply, HistoryItem, packReply, ReceiveMode, SOCKET_EVENTS, TransmissionReadyPayload } from "@talk/shared";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import {
  SttService,
  SttResult,
  collapseRepeats,
  detectLang,
  isHallucination,
  isStutterGarbage,
  matchesLang,
  spokenLang,
  usableSpeech,
  tooShortWalkie,
} from "../ai/stt.service";
import { TranslateService } from "../ai/translate.service";
import { TtsService } from "../ai/tts.service";
import { ChannelsService } from "../channels/channels.service";
import { ContactsService } from "../contacts/contacts.service";
import { PrismaService } from "../prisma/prisma.service";
import { PushService } from "../push/push.service";
import { PresenceService } from "../realtime/presence.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { FirebaseRtdbService } from "../firebase/firebase-rtdb.service";
import { StorageService } from "../storage/storage.service";
import { toPublicUser } from "../users/user.mapper";
import { notifyChrome } from "../i18n/notifyChrome";

function normalizeClientLocalId(value?: string | null) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 80) return "";
  if (/^local-[\w-]+$/.test(id)) return id;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  return "";
}

@Injectable()
export class TransmissionsService {
  private readonly logger = new Logger(TransmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly channels: ChannelsService,
    private readonly contacts: ContactsService,
    private readonly stt: SttService,
    private readonly translate: TranslateService,
    private readonly tts: TtsService,
    @Inject(forwardRef(() => RealtimeGateway))
    private readonly realtime: RealtimeGateway,
    private readonly presence: PresenceService,
    private readonly push: PushService,
    private readonly firebase: FirebaseRtdbService,
  ) {}

  private readonly claimedLocal = new Map<string, { id: string; at: number }>();

  clipLocalKey(input?: { clientLocalId?: string; releasedAt?: number }) {
    const explicit = normalizeClientLocalId(input?.clientLocalId);
    if (explicit) return explicit;
    const released = Number(input?.releasedAt);
    if (Number.isFinite(released) && released > 1_000_000_000_000) return `local-${Math.floor(released)}`;
    return "";
  }

  /** Same press / outbox retry returns the first id — never a second clip. */
  async beginClip(senderId: string, input?: { clientLocalId?: string; releasedAt?: number }) {
    const localId = this.clipLocalKey(input);
    if (localId) {
      const db = await this.existingByClientLocalId(senderId, localId);
      if (db) {
        this.claimedLocal.set(`${senderId}:${localId}`, { id: db.id, at: Date.now() });
        this.logger.log(`clip idempotent db ${db.id} clientLocalId=${localId}`);
        return { ...db, existing: true as const, localId };
      }
      const mem = this.claimedLocal.get(`${senderId}:${localId}`);
      if (mem && Date.now() - mem.at < 20 * 60_000) {
        this.logger.log(`clip idempotent mem ${mem.id} clientLocalId=${localId}`);
        return { id: mem.id, status: "READY" as const, channelId: "", existing: true as const, localId };
      }
    }
    const id = randomUUID();
    if (localId) {
      const key = `${senderId}:${localId}`;
      const raced = this.claimedLocal.get(key);
      if (raced) return { id: raced.id, status: "READY" as const, channelId: "", existing: true as const, localId };
      this.claimedLocal.set(key, { id, at: Date.now() });
      if (this.claimedLocal.size > 400) {
        const now = Date.now();
        for (const [k, v] of this.claimedLocal) {
          if (now - v.at > 20 * 60_000) this.claimedLocal.delete(k);
        }
      }
    }
    return { id, status: "READY" as const, channelId: "", existing: false as const, localId };
  }

  async create(
    sender: User,
    file: Express.Multer.File,
    input: {
      channelId?: string;
      channelIds?: string[];
      targetUserIds?: string[];
      everyone?: boolean;
      durationMs?: number;
      originalText?: string;
      kind?: string;
      viewOnce?: boolean;
      releasedAt?: number;
      speakLang?: string;
      sourceLanguage?: string;
      replyToId?: string;
      replyToName?: string;
      replyToText?: string;
      clientLocalId?: string;
    },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException("חסר קובץ");
    if (input.kind === "image" || input.kind === "video") {
      return this.createChatMedia(sender, file, input, input.kind);
    }
    const started = Date.now();
    const releasedAt = Number(input.releasedAt);
    const clientRelease = Number.isFinite(releasedAt) && releasedAt > 0 ? releasedAt : started;
    const ext = extFrom(file);
    const mime = file.mimetype || "audio/mp4";
    const kind = input.kind === "voice" ? "voice" : "walkie";

    const speakerLang = sender.speakLang || sender.listenLang;
    const planned = await this.planTargets(sender, input, kind);
    const targetIds = planned.deliverIds;
    if (kind === "walkie") {
      const users = await this.prisma.user.findMany({ where: { id: { in: targetIds } } });
      return this.relayWalkie(
        sender,
        file,
        input,
        users,
        targetIds,
        clientRelease,
        input.sourceLanguage || input.speakLang || "",
      );
    }
    const begun = await this.beginClip(sender.id, input);
    if (begun.existing) return { id: begun.id, status: begun.status, channelId: begun.channelId };
    const users = await this.prisma.user.findMany({ where: { id: { in: planned.channelIds } } });
    const sameLanguage =
      users.length > 0 &&
      users.every((user) => (user.listenLang || user.speakLang) === speakerLang);
    const hint = collapseRepeats(input.originalText?.trim() || "");
    const hasHint = Boolean(hint && !isHallucination(hint) && matchesLang(hint, speakerLang));
    // Same language on both phones: send the recording as-is. Do not wait on speech-to-text.
    const sttEarly: Promise<SttResult> =
      sameLanguage || hasHint
        ? Promise.resolve({ text: sameLanguage ? "" : hint, lang: detectLang(hint) || speakerLang })
        : this.stt.transcribeBytes(file.buffer, "", mime, ext);
    if (sameLanguage) {
      this.logger.log(`Same language ${speakerLang} — skip STT`);
    }

    const channel = await this.ensureChannel(sender, input.channelId, planned.channelIds);
    const audioUrl = await this.storage.save(file.buffer, ext, "audio");
    const sttP = sttEarly;
    const deliverUsers = planned.silent ? [] : users;

    const transmission = await this.prisma.transmission.create({
      data: {
        id: begun.id,
        senderId: sender.id,
        channelId: channel.id,
        originalAudioUrl: audioUrl,
        originalText: packReply(input.originalText?.trim() || "", {
          id: input.replyToId,
          name: input.replyToName,
          text: input.replyToText,
        }),
        durationMs: input.durationMs ?? null,
        kind,
        viewOnce: kind === "voice" && Boolean(input.viewOnce),
        status: "PROCESSING",
        ...(begun.localId ? { clientLocalId: begun.localId } : {}),
        ...(await this.expiryData(channel.id)),
        targets: {
          create: deliverUsers.map((user) => ({
            userId: user.id,
            language: user.listenLang || user.speakLang,
          })),
        },
      },
      include: { targets: true },
    });

    void this.finish(transmission, sender, sttP, started, { clientRelease, sameLanguage });
    void Promise.all(
      deliverUsers.map(async (target) => {
        await this.contacts.ensureIncoming(target, sender);
        await this.contacts.ensureMutualTalk(sender, target);
      }),
    );
    return { id: transmission.id, status: "PROCESSING" as const, channelId: channel.id };
  }

  private async createChatMedia(
    sender: User,
    file: Express.Multer.File,
    input: {
      channelId?: string;
      targetUserIds?: string[];
      everyone?: boolean;
      durationMs?: number;
      viewOnce?: boolean;
      originalText?: string;
      replyToId?: string;
      replyToName?: string;
      replyToText?: string;
      clientLocalId?: string;
      releasedAt?: number;
    },
    kind: "image" | "video",
  ) {
    const begun = await this.beginClip(sender.id, input);
    if (begun.existing) return { id: begun.id, status: begun.status, channelId: begun.channelId };
    if (file.buffer.length > 80 * 1024 * 1024) throw new BadRequestException("הקובץ גדול מדי");
    if (kind === "video") {
      const duration = Number(input.durationMs) || 0;
      if (duration > 61_500) throw new BadRequestException("הסרטון יכול להיות עד דקה");
    }
    const planned = await this.planTargets(sender, input, kind);
    const targetIds = planned.deliverIds;
    const users = await this.prisma.user.findMany({ where: { id: { in: planned.channelIds } } });
    const channel = await this.ensureChannel(sender, input.channelId, planned.channelIds);
    const saved = await this.storage.save(file.buffer, extFrom(file), "chat");
    const packed = packReply(input.originalText?.trim() || "", {
      id: input.replyToId,
      name: input.replyToName,
      text: input.replyToText,
    });
    const transmission = await this.prisma.transmission.create({
      data: {
        id: begun.id,
        senderId: sender.id,
        channelId: channel.id,
        originalAudioUrl: saved,
        ...(begun.localId ? { clientLocalId: begun.localId } : {}),
        originalText: packed || null,
        durationMs: kind === "video" ? input.durationMs ?? null : null,
        kind,
        viewOnce: Boolean(input.viewOnce),
        status: "READY",
        ...(await this.expiryData(channel.id)),
        targets: {
          create: planned.silent
            ? []
            : users.map((user) => ({
                userId: user.id,
                language: user.listenLang || user.speakLang,
              })),
        },
      },
      include: { targets: true },
    });
    const senderPublic = toPublicUser(sender);
    const hidePhoto = await this.hideAvatarFor(sender.id, transmission.targets.map((row) => row.userId));
    const mediaUrl = this.storage.publicUrl(saved);
    const quoted = decodeReply(packed);
    const readyAt = Date.now();
    for (const target of transmission.targets) {
      const payload: TransmissionReadyPayload = {
        transmissionId: transmission.id,
        channelId: transmission.channelId,
        senderId: sender.id,
        senderName: sender.displayName || sender.phoneE164,
        language: target.language,
        speakLang: sender.speakLang || sender.listenLang,
        mode: sender.plan === "PLUS" ? "plus" : "free",
        audioUrl: mediaUrl,
        originalText: quoted.text || "",
        translatedText: quoted.text || "",
        durationMs: transmission.durationMs,
        usedOriginalVoice: true,
        replyToId: quoted.reply?.id || null,
        replyToName: quoted.reply?.name || null,
        replyToText: quoted.reply?.text || null,
        needsAccept: false,
        live: false,
        senderPhone: sender.phoneE164,
        senderAvatarUrl: hidePhoto.has(target.userId) ? null : senderPublic.avatarUrl,
        voiceGender: sender.voiceGender === "female" || sender.voiceGender === "child" ? sender.voiceGender : "male",
        kind,
        viewOnce: Boolean(transmission.viewOnce),
        releasedAt: readyAt,
        readyAt,
        expiresAt: transmission.expiresAt?.toISOString() || null,
        group: isGroupType("type" in channel ? channel.type : undefined),
      };
      const reached = this.realtime.emitToUser(target.userId, SOCKET_EVENTS.TRANSMISSION_READY, payload);
      this.logger.log(`Deliver ${kind} ${transmission.id} -> ${target.userId} reached=${reached}`);
      if (reached) void this.noteDelivered(target.id, sender.id, transmission.id, target.userId);
      void this.push.notifyUsers(
        [target.userId],
        sender.displayName?.trim() || sender.phoneE164,
        transmission.viewOnce
          ? notifyChrome(target.language, kind === "video" ? "videoOnce" : "photoOnce")
          : notifyChrome(target.language, kind === "video" ? "video" : "photo"),
        {
          type: "message",
          transmissionId: transmission.id,
          channelId: transmission.channelId,
          kind,
          senderId: sender.id,
          senderName: sender.displayName || "",
          senderPhone: sender.phoneE164,
          senderAvatarUrl: hidePhoto.has(target.userId) ? "" : senderPublic.avatarUrl || "",
          audioUrl: mediaUrl,
          viewOnce: transmission.viewOnce ? "1" : "0",
        },
      );
    }
    void Promise.all(
      (planned.silent ? [] : users).map(async (target) => {
        await this.contacts.ensureIncoming(target, sender);
        await this.contacts.ensureMutualTalk(sender, target);
      }),
    );
    this.logger.log(`${kind.toUpperCase()} ${transmission.id} from=${sender.id} to=${targetIds.join(",")}`);
    return { id: transmission.id, status: "READY" as const, channelId: channel.id };
  }

  /** Same-language walkie: forward the clip over the socket now. Disk/history wait in the background. */
  async forwardWalkieClip(
    sender: User,
    file: Express.Multer.File,
    input: {
      channelId?: string;
      channelIds?: string[];
      targetUserIds?: string[];
      durationMs?: number;
      releasedAt?: number;
      speakLang?: string;
      sourceLanguage?: string;
      clientLocalId?: string;
    },
    opts?: { skipEmit?: boolean; skipEmitFor?: string[]; missed?: string[]; transmissionId?: string },
  ) {
    const started = Date.now();
    if (tooShortWalkie(input.durationMs)) {
      this.logger.warn(`Walkie drop short duration=${input.durationMs} sender=${sender.id}`);
      return { id: "", status: "READY" as const, channelId: "" };
    }
    const targetIds = [...new Set((input.targetUserIds || []).filter((id) => id && id !== sender.id))];
    const groupIds = [
      ...new Set(
        [input.channelId, ...(input.channelIds || [])]
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter(Boolean),
      ),
    ];
    const channelId = groupIds[0] || "";
    if (!targetIds.length && !groupIds.length) throw new BadRequestException("לא נבחרו נמענים");
    const lang = (
      input.sourceLanguage ||
      input.speakLang ||
      sender.speakLang ||
      sender.listenLang ||
      ""
    )
      .slice(0, 2)
      .toLowerCase();
    const audioB64 = file.buffer.length <= 1_500_000 ? file.buffer.toString("base64") : undefined;
    if (!audioB64) {
      return this.create(sender, file, { ...input, kind: "walkie" });
    }
    let transmissionId = opts?.transmissionId || "";
    if (!opts?.skipEmit) {
      const begun = await this.beginClip(sender.id, input);
      if (begun.existing) return { id: begun.id, status: begun.status, channelId: begun.channelId || channelId };
      transmissionId = begun.id;
    } else if (!transmissionId) {
      transmissionId = randomUUID();
    }
    const clientRelease = Number(input.releasedAt);
    const releasedAt = Number.isFinite(clientRelease) && clientRelease > 0 ? clientRelease : started;
    const senderPublic = toPublicUser(sender);
    const voiceGender =
      sender.voiceGender === "female" || sender.voiceGender === "child" ? sender.voiceGender : "male";
    const payload: TransmissionReadyPayload = {
      transmissionId,
      channelId,
      senderId: sender.id,
      senderName: sender.displayName || sender.phoneE164,
      language: lang,
      speakLang: lang,
      mode: sender.plan === "PLUS" ? "plus" : "free",
      audioUrl: "",
      originalText: "",
      translatedText: "",
      durationMs: input.durationMs ?? null,
      usedOriginalVoice: true,
      needsAccept: false,
      live: false,
      senderPhone: sender.phoneE164,
      senderAvatarUrl: senderPublic.avatarUrl,
      voiceGender,
      kind: "walkie",
      viewOnce: false,
      releasedAt,
      readyAt: Date.now(),
      group: Boolean(channelId),
      audioB64,
    };
    const groupIdsForPersist = groupIds;
    const already = new Set(opts?.skipEmitFor || []);
    const missed = [...new Set(opts?.missed || [])];
    if (!opts?.skipEmit) {
      if (!groupIdsForPersist.length) {
        for (const id of targetIds) {
          if (already.has(id)) continue;
          const reached = this.realtime.emitToUser(id, SOCKET_EVENTS.TRANSMISSION_READY, {
            ...payload,
            channelId: "",
            group: false,
            groupName: null,
          });
          this.logger.log(
            `Forward walkie ${transmissionId} -> ${id} reached=${reached} group=false channel=`,
          );
          if (!reached) missed.push(id);
          else already.add(id);
        }
      }
      const { audioB64: _omit, ...senderPayload } = payload;
      this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_READY, senderPayload);
    }
    const { audioB64: _omit, ...senderPayload } = payload;
    const saveP = this.storage.save(file.buffer, extFrom(file), "audio");
    void (async () => {
      try {
        const homesOf = new Map<string, { id: string; name: string }[]>();
        const groupRows = groupIdsForPersist.length
          ? await this.prisma.channel.findMany({
              where: { id: { in: groupIdsForPersist } },
              select: { id: true, name: true },
            })
          : [];
        const groupName = new Map(groupRows.map((row) => [row.id, row.name || ""]));
        for (const gid of groupIdsForPersist) {
          const members = await this.prisma.channelMember.findMany({
            where: { channelId: gid, userId: { not: sender.id } },
            select: { userId: true },
          });
          const stamped = { ...payload, channelId: gid, group: true, groupName: groupName.get(gid) || null };
          for (const row of members) {
            if (!row.userId) continue;
            if (!targetIds.includes(row.userId)) targetIds.push(row.userId);
            const list = homesOf.get(row.userId) || [];
            if (!list.some((home) => home.id === gid)) {
              list.push({ id: gid, name: groupName.get(gid) || "" });
              homesOf.set(row.userId, list);
            }
            if (already.has(row.userId) || missed.includes(row.userId)) continue;
            const reached = this.realtime.emitToUser(row.userId, SOCKET_EVENTS.TRANSMISSION_READY, stamped);
            if (!reached) missed.push(row.userId);
            else already.add(row.userId);
          }
        }
        for (const id of targetIds) {
          if (already.has(id) || missed.includes(id) || homesOf.has(id)) continue;
          const reached = this.realtime.emitToUser(id, SOCKET_EVENTS.TRANSMISSION_READY, {
            ...payload,
            channelId: "",
            group: false,
            groupName: null,
          });
          this.logger.log(
            `Forward walkie ${transmissionId} -> ${id} reached=${reached} group=false channel=`,
          );
          if (!reached) missed.push(id);
          else already.add(id);
        }
        const users = targetIds.length
          ? await this.prisma.user.findMany({ where: { id: { in: targetIds } } })
          : [];
        const dubbed = walkieDubbedTargets(users, lang, payload, homesOf);
        this.persistWalkie(
          transmissionId,
          sender,
          file,
          input,
          users,
          targetIds,
          saveP,
          lang,
          payload,
          lang,
          voiceGender,
          dubbed,
          groupIdsForPersist,
        );
        if (!missed.length) return;
        const url = await saveP;
        const dubbedIds = new Set(dubbed.map((row) => row.targetId));
        for (const id of [...new Set(missed)]) {
          if (dubbedIds.has(id)) continue;
          void this.push.notifyOfflineMessage(id, {
            ...senderPayload,
            audioUrl: this.storage.publicUrl(url),
            kind: "walkie",
          });
        }
      } catch (error) {
        this.logger.warn(`walkie persist after forward ${transmissionId} ${(error as Error).message}`);
      }
    })();
    this.logger.log(
      `Walkie forward ${transmissionId} bytes=${file.buffer.length} targets=${targetIds.length} emitMs=${Date.now() - started}`,
    );
    return { id: transmissionId, status: "READY" as const, channelId };
  }

  /** Walkie is the recording itself. Translation stays in the codebase and is not on this path. */
  private async relayWalkie(
    sender: User,
    file: Express.Multer.File,
    input: { channelId?: string; channelIds?: string[]; durationMs?: number },
    users: User[],
    targetIds: string[],
    clientRelease: number,
    sourceLanguage = "",
    savedAudioUrl?: string,
  ) {
    try {
      return await this.relayWalkieNow(
        sender,
        file,
        input,
        users,
        targetIds,
        clientRelease,
        sourceLanguage,
        savedAudioUrl,
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2024") {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          return await this.relayWalkieNow(
            sender,
            file,
            input,
            users,
            targetIds,
            clientRelease,
            sourceLanguage,
            savedAudioUrl,
          );
        } catch (retryError) {
          error = retryError;
        }
      }
      if (error instanceof HttpException) throw error;
      const message = error instanceof Error ? error.message : "Internal server error";
      this.logger.error(`Walkie relay failed: ${message}`);
      throw new InternalServerErrorException(message);
    }
  }

  private async relayWalkieNow(
    sender: User,
    file: Express.Multer.File,
    input: { channelId?: string; channelIds?: string[]; durationMs?: number; clientLocalId?: string; releasedAt?: number; targetUserIds?: string[] },
    users: User[],
    targetIds: string[],
    clientRelease: number,
    sourceLanguage = "",
    savedAudioUrl?: string,
  ) {
    const started = Date.now();
    if (tooShortWalkie(input.durationMs)) {
      this.logger.warn(`Walkie drop short duration=${input.durationMs} sender=${sender.id}`);
      return { id: "", status: "READY" as const, channelId: "" };
    }
    const begun = await this.beginClip(sender.id, { ...input, releasedAt: clientRelease });
    if (begun.existing) return { id: begun.id, status: begun.status, channelId: begun.channelId };
    const groupIds = [
      ...new Set(
        [input.channelId, ...(input.channelIds || [])]
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter(Boolean),
      ),
    ];
    const saveP = savedAudioUrl
      ? Promise.resolve(savedAudioUrl)
      : this.storage.save(file.buffer, extFrom(file), "audio");
    const groupRows = groupIds.length
      ? await this.prisma.channel.findMany({
          where: { id: { in: groupIds } },
          select: {
            id: true,
            name: true,
            type: true,
            members: { where: { userId: { not: sender.id } }, select: { userId: true } },
          },
        })
      : ([] as { id: string; name: string | null; type: string; members: { userId: string }[] }[]);
    const saveMs = Date.now() - started;
    const lang = (sourceLanguage || sender.speakLang || sender.listenLang || "").slice(0, 2).toLowerCase();
    const transmissionId = begun.id;
    const channelHint = groupIds[0] || "";
    const groupType = groupRows.find((row) => row.id === channelHint)?.type;
    const senderPublic = toPublicUser(sender);
    const voiceGender =
      sender.voiceGender === "female" || sender.voiceGender === "child" ? sender.voiceGender : "male";
    const audioB64 = file.buffer.length <= 1_500_000 ? file.buffer.toString("base64") : undefined;
    const audioUrl = audioB64 ? "" : await saveP;
    const payload: TransmissionReadyPayload = {
      transmissionId,
      channelId: channelHint,
      senderId: sender.id,
      senderName: sender.displayName || sender.phoneE164,
      language: lang,
      speakLang: lang,
      mode: sender.plan === "PLUS" ? "plus" : "free",
      audioUrl: audioUrl ? this.storage.publicUrl(audioUrl) : "",
      originalText: "",
      translatedText: "",
      durationMs: input.durationMs ?? null,
      usedOriginalVoice: true,
      needsAccept: false,
      live: false,
      senderPhone: sender.phoneE164,
      senderAvatarUrl: senderPublic.avatarUrl,
      voiceGender,
      kind: "walkie",
      viewOnce: false,
      releasedAt: clientRelease,
      readyAt: Date.now(),
      group: Boolean(input.channelId?.trim()) && isGroupType(groupType),
    };
    const speak = (lang || "").slice(0, 2).toLowerCase();
    const homesOf = new Map<string, { id: string; name: string }[]>();
    for (const row of groupRows) {
      if (!isGroupType(row.type)) continue;
      for (const member of row.members) {
        const list = homesOf.get(member.userId) || [];
        list.push({ id: row.id, name: row.name || "" });
        homesOf.set(member.userId, list);
      }
    }
    const explicit = new Set((input.targetUserIds || []).filter((id) => id && id !== sender.id));
    let textOnly = 0;
    const dubbed: { targetId: string; language: string; channelId: string; group: boolean; groupName: string }[] = [];
    for (const listener of users) {
      const hear = (listener.listenLang || listener.speakLang || "").slice(0, 2).toLowerCase();
      const sameLanguage = !speak || !hear || hear === speak;
      const stamps = walkieDeliveryStamps(listener.id, homesOf.get(listener.id), explicit);
      if (!sameLanguage) {
        textOnly += 1;
        if (hear) {
          for (const stamp of stamps) dubbed.push({ targetId: listener.id, language: hear, ...stamp });
        }
        continue;
      }
      for (const stamp of stamps) {
        const rowPayload = {
          ...payload,
          channelId: stamp.channelId,
          group: stamp.group,
          groupName: stamp.groupName || null,
          audioB64,
        };
        const reached = this.realtime.emitToUser(listener.id, SOCKET_EVENTS.TRANSMISSION_READY, rowPayload);
        this.logger.log(
          `Deliver walkie ${transmissionId} -> ${listener.id} reached=${reached} group=${String(rowPayload.group)} channel=${stamp.channelId}`,
        );
        if (!reached) {
          const { audioB64: _inline, ...pushPayload } = rowPayload;
          void saveP.then((url) =>
            this.push.notifyOfflineMessage(listener.id, {
              ...pushPayload,
              audioUrl: this.storage.publicUrl(url),
              kind: "walkie",
            }),
          );
        }
      }
    }
    this.persistWalkie(
      transmissionId,
      sender,
      file,
      input,
      users,
      targetIds,
      audioUrl || saveP,
      lang,
      payload,
      speak,
      voiceGender,
      dubbed,
      groupIds,
    );
    this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_READY, payload);
    this.logger.log(
      `Walkie relay ${transmissionId} bytes=${file.buffer.length} targets=${users.length} textOnly=${textOnly} saveMs=${saveMs} emitMs=${Date.now() - started}`,
    );
    void Promise.all(
      users.map(async (target) => {
        await this.contacts.ensureIncoming(target, sender);
        await this.contacts.ensureMutualTalk(sender, target);
      }),
    );
    return { id: transmissionId, status: "READY" as const, channelId: channelHint };
  }

  private persistWalkie(
    transmissionId: string,
    sender: User,
    file: Express.Multer.File,
    input: { channelId?: string; channelIds?: string[]; durationMs?: number },
    users: User[],
    targetIds: string[],
    audioUrl: string | Promise<string>,
    lang: string,
    payload: TransmissionReadyPayload,
    speak: string,
    voiceGender: "male" | "female" | "child",
    dubbed: { targetId: string; language: string; channelId: string; group: boolean; groupName: string }[],
    groupIds: string[],
  ) {
    void (async () => {
      if (dubbed.length) {
        void this.dubWalkie(file, transmissionId, payload, speak, voiceGender, dubbed);
      }
      try {
        const storedUrl = await audioUrl;
        const channel = groupIds[0]
          ? { id: groupIds[0] }
          : await this.ensureChannel(sender, input.channelId, targetIds, { reuseDirect: true });
        await this.prisma.transmission.create({
          data: {
            id: transmissionId,
            senderId: sender.id,
            channelId: channel.id,
            originalAudioUrl: storedUrl,
            originalText: null,
            durationMs: input.durationMs ?? null,
            kind: "walkie",
            viewOnce: false,
            status: "READY",
            ...(this.clipLocalKey(input) ? { clientLocalId: this.clipLocalKey(input) } : {}),
            targets: {
              create: users.map((user) => ({
                userId: user.id,
                language: (user.listenLang || user.speakLang || lang).slice(0, 2).toLowerCase(),
                deliveredAt: new Date(),
              })),
            },
          },
        });
      } catch (error) {
        this.logger.warn(`walkie persist ${transmissionId} ${(error as Error).message}`);
      }
    })();
  }

  /** Cross-language walkie: transcribe once in the speaker's language, then translate that exact text. */
  private async dubWalkie(
    file: Express.Multer.File,
    transmissionId: string,
    payload: TransmissionReadyPayload,
    speak: string,
    voiceGender: "male" | "female" | "child",
    dubbed: { targetId: string; language: string; channelId: string; group: boolean; groupName: string }[],
  ) {
    try {
      if (tooShortWalkie(payload.durationMs)) {
        this.logger.warn(`Walkie dub skip short ${transmissionId} ${payload.durationMs}ms`);
        return;
      }
      const ext = extFrom(file);
      const languages = [...new Set(dubbed.map((row) => row.language))];
      const heard = await this.stt.hearClip(
        file.buffer,
        file.mimetype || "audio/wav",
        ext,
        speak,
        payload.durationMs ?? undefined,
      );
      const originalText = usableSpeech((heard.stt || "").replace(/\s+/g, " ").trim());
      const { audioB64: _omitAudio, ...basePayload } = payload;
      if (!originalText || isHallucination(originalText) || isStutterGarbage(originalText)) {
        this.logger.warn(`Walkie dub empty/junk stt ${transmissionId}`);
        return;
      }
      try {
        await this.prisma.transmission.update({
          where: { id: transmissionId },
          data: { originalText },
        });
      } catch (error) {
        this.logger.warn(`Walkie dub originalText ${transmissionId} ${(error as Error).message}`);
      }
      this.realtime.emitToUser(payload.senderId, SOCKET_EVENTS.TRANSMISSION_READY, {
        ...basePayload,
        originalText,
        translatedText: "",
        audioUrl: null,
        kind: "walkie" as const,
      });
      const senderLines: string[] = [];
      await Promise.all(
        languages.map(async (language) => {
        let line = originalText;
        if (language !== speak) {
          const sameAsSource = (value: string) =>
            value.replace(/\s+/g, " ").trim().toLowerCase() === originalText.toLowerCase();
          const padded = (src: string, out: string) => {
            const a = src.split(/\s+/).filter(Boolean).length;
            const b = out.split(/\s+/).filter(Boolean).length;
            return b > a + 2 && b > Math.ceil(a * 1.5);
          };
          const live = await this.stt.translateHeard(originalText, language, voiceGender);
          line = (live.text || "").replace(/\s+/g, " ").trim();
          if (!line || sameAsSource(line) || padded(originalText, line)) {
            const cloud = await this.translate.translate(originalText, speak, language);
            line = (cloud.text || "").replace(/\s+/g, " ").trim();
            if (cloud.reason || !line || sameAsSource(line) || padded(originalText, line)) {
              this.logger.warn(
                `Walkie dub reject ${transmissionId} ${speak}->${language} reason=${cloud.reason || "source-echo-or-padded"}`,
              );
              line = "";
            }
          }
        }
        if (!line || /^\[unclear\]$/i.test(line)) {
          this.logger.warn(`Walkie dub no translation ${transmissionId} ${speak}->${language}`);
          return;
        }
        if (language !== speak) senderLines.push(line);
        const spoken = await this.tts.speakBytes(line, language, null, voiceGender, {
          allowEleven: true,
          preferEleven: true,
          timeoutMs: 12000,
        });
        if (!spoken?.length) {
          this.logger.warn(`Walkie dub no tts ${transmissionId} ${speak}->${language}`);
        }
        const audioB64 = spoken && spoken.length <= 1_500_000 ? spoken.toString("base64") : undefined;
        const saveP = spoken?.length ? this.storage.save(spoken, "mp3", "renders") : Promise.resolve("");
        for (const row of dubbed.filter((item) => item.language === language)) {
          const dubbedPayload = {
            ...basePayload,
            language,
            audioUrl: "",
            audioB64,
            originalText,
            translatedText: line,
            usedOriginalVoice: false,
            suppressOriginal: true,
            kind: "walkie" as const,
            channelId: row.channelId || payload.channelId,
            group: row.group,
            groupName: row.groupName || null,
          };
          const reached = this.realtime.emitToUser(row.targetId, SOCKET_EVENTS.TRANSMISSION_READY, dubbedPayload);
          this.logger.log(`Deliver walkie ${transmissionId} -> ${row.targetId} reached=${reached}`);
          if (!reached) {
            void saveP.then((saved) => {
              if (this.realtime.hasLiveSocket(row.targetId)) return;
              const audioUrl = saved ? this.storage.publicUrl(saved) : "";
              if (audioUrl) {
                void this.push.notifyOfflineMessage(row.targetId, { ...dubbedPayload, audioUrl, audioB64: undefined });
              }
            });
          }
          void this.prisma.transmissionTarget.updateMany({
            where: { transmissionId, userId: row.targetId, deliveredAt: null },
            data: { deliveredAt: new Date() },
          });
          this.logger.log(`Walkie dub ${transmissionId} ${speak}->${language} user=${row.targetId} tts`);
        }
        void saveP.then(async (saved) => {
          if (!saved) return;
          try {
            await this.prisma.transmissionRender.upsert({
              where: { transmissionId_language: { transmissionId, language } },
              create: { transmissionId, language, audioUrl: saved, translatedText: line },
              update: { audioUrl: saved, translatedText: line },
            });
          } catch (error) {
            this.logger.warn(`Walkie dub render ${transmissionId} ${language} ${(error as Error).message}`);
          }
        });
        }),
      );
      this.realtime.emitToUser(payload.senderId, SOCKET_EVENTS.TRANSMISSION_READY, {
        ...basePayload,
        originalText,
        translatedText: [...new Set(senderLines)].join(" · "),
        audioUrl: null,
        kind: "walkie" as const,
      });
    } catch (error) {
      this.logger.warn(`Walkie dub failed ${transmissionId}: ${(error as Error).message}`);
    }
  }

  async createText(
    sender: User,
    input: {
      originalText: string;
      channelId?: string;
      targetUserIds?: string[];
      everyone?: boolean;
      replyToId?: string;
      replyToName?: string;
      replyToText?: string;
      clientLocalId?: string;
    },
  ) {
    const packed = packReply(input.originalText.trim(), {
      id: input.replyToId,
      name: input.replyToName,
      text: input.replyToText,
    });
    const visible = decodeReply(packed).text.trim();
    if (!visible) throw new BadRequestException("חסרה הודעה");
    const begun = await this.beginClip(sender.id, { clientLocalId: input.clientLocalId });
    if (begun.existing) {
      this.logger.log(`TEXT idempotent ${begun.id} clientLocalId=${begun.localId}`);
      return { id: begun.id, status: begun.status, channelId: begun.channelId };
    }
    const clientLocalId = begun.localId;
    const planned = await this.planTargets(sender, input, "text");
    const targetIds = planned.deliverIds;
    const channel = await this.ensureChannel(sender, input.channelId, planned.channelIds);
    const users = await this.prisma.user.findMany({ where: { id: { in: planned.channelIds } } });
    const deliverUsers = planned.silent ? [] : users;
    let transmission;
    try {
      transmission = await this.prisma.transmission.create({
        data: {
          id: begun.id,
          senderId: sender.id,
          channelId: channel.id,
          originalAudioUrl: "",
          originalText: packed,
          durationMs: null,
          kind: "text",
          status: "PROCESSING",
          ...(clientLocalId ? { clientLocalId } : {}),
          ...(await this.expiryData(channel.id)),
          targets: {
            create: deliverUsers.map((user) => ({
              userId: user.id,
              language: user.listenLang || user.speakLang,
            })),
          },
        },
        include: { targets: true },
      });
    } catch (error) {
      if (clientLocalId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.existingByClientLocalId(sender.id, clientLocalId);
        if (existing) {
          this.logger.log(`TEXT idempotent ${existing.id} clientLocalId=${clientLocalId}`);
          return existing;
        }
      }
      throw error;
    }
    void this.finish(
      transmission,
      sender,
      Promise.resolve({
        text: visible,
        lang: detectLang(visible) || sender.speakLang || sender.listenLang,
      }),
      Date.now(),
      { textOnly: true },
    );
    void Promise.all(
      deliverUsers.map(async (target) => {
        await this.contacts.ensureIncoming(target, sender);
        await this.contacts.ensureMutualTalk(sender, target);
      }),
    );
    this.logger.log(`TEXT ${transmission.id} from=${sender.id} to=${targetIds.join(",")}`);
    return { id: transmission.id, status: "PROCESSING" as const, channelId: channel.id };
  }

  private async finish(
    transmission: {
      id: string;
      channelId: string;
      originalAudioUrl: string;
      originalText: string | null;
      durationMs: number | null;
      kind?: string;
      viewOnce?: boolean;
      expiresAt?: Date | null;
      targets: { id: string; userId: string; language: string }[];
    },
    sender: User,
    sttP: Promise<SttResult>,
    started: number,
    opts: { textOnly?: boolean; clientRelease?: number; sameLanguage?: boolean } = {},
  ) {
    const textOnly = Boolean(opts.textOnly || !transmission.originalAudioUrl);
    const clientRelease = opts.clientRelease ?? started;
    const delivery: "walkie" | "voice" | "text" =
      textOnly || transmission.kind === "text"
        ? "text"
        : transmission.kind === "voice"
          ? "voice"
          : "walkie";
    try {
      const speakerLang = sender.speakLang || sender.listenLang;
      const sttMark = Date.now();
      let sttMs = 0;
      const [sttResult, incomingRows, people, senderOnline] = await Promise.all([
        sttP
          .then((result) => {
            sttMs = Date.now() - sttMark;
            const text = result.text || transmission.originalText || "";
            const lang = result.lang || detectLang(text) || speakerLang;
            return { text, lang };
          })
          .catch(() => {
            sttMs = Date.now() - sttMark;
            const text = transmission.originalText || "";
            return { text, lang: detectLang(text) || speakerLang };
          }),
        this.prisma.contact.findMany({
          where: {
            ownerId: { in: transmission.targets.map((t) => t.userId) },
            matchedUserId: sender.id,
          },
        }),
        this.prisma.user.findMany({
          where: { id: { in: [sender.id, ...transmission.targets.map((t) => t.userId)] } },
          select: { id: true, displayName: true, plan: true, avatarUrl: true, voiceGender: true, phoneE164: true },
        }),
        this.presence.isOnline(sender.id),
      ]);
      const targetIds = transmission.targets.map((t) => t.userId);
      const [onlineTargets, heardFromSender, heardBySender] = await Promise.all([
        this.presence.onlineUserIds(targetIds),
        this.prisma.transmissionTarget.findMany({
          where: {
            userId: { in: targetIds },
            playedAt: { not: null },
            transmission: { senderId: sender.id, kind: "walkie", status: "READY" },
          },
          select: { userId: true },
          distinct: ["userId"],
        }),
        this.prisma.transmissionTarget.findMany({
          where: {
            userId: sender.id,
            playedAt: { not: null },
            transmission: { senderId: { in: targetIds }, kind: "walkie", status: "READY" },
          },
          select: { transmission: { select: { senderId: true } } },
        }),
      ]);
      const recipientHeardSender = new Set(heardFromSender.map((row) => row.userId));
      const senderHeardRecipient = new Set(
        heardBySender.map((row) => row.transmission.senderId).filter(Boolean),
      );
      const gate = (check: string, sample = "") => {
        const clean = (sample || "").replace(/\s+/g, " ").trim();
        const shown = clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
        this.logger.warn(`Gate ${transmission.id} check=${check}${shown ? ` "${shown}"` : ""}`);
      };
      const quoted = decodeReply(transmission.originalText || "");
      let originalText = textOnly
        ? usableSpeech(quoted.text) || quoted.text.trim() || usableSpeech(sttResult.text) || sttResult.text.trim()
        : usableSpeech(sttResult.text);
      if (!textOnly && originalText && isStutterGarbage(originalText)) {
        originalText = "";
      }
      let sourceLang = originalText
        ? textOnly
          ? detectLang(originalText) || spokenLang(originalText, sttResult.lang, speakerLang)
          : spokenLang(originalText, sttResult.lang, speakerLang)
        : speakerLang;
      let retriedStt = false;
      const retranscribeOnce = async () => {
        if (retriedStt || textOnly || !transmission.originalAudioUrl) return;
        retriedStt = true;
        try {
          const reMark = Date.now();
          const abs = this.storage.absolutePath(transmission.originalAudioUrl);
          const audio = await readFile(abs);
          const retry = await this.stt.transcribeBytes(audio, "", "audio/mp4", "m4a");
          sttMs += Date.now() - reMark;
          const next = usableSpeech(retry.text);
          if (next && !isStutterGarbage(next)) {
            originalText = next;
            sourceLang = spokenLang(next, retry.lang, speakerLang);
          }
        } catch (error) {
          this.logger.warn(`Retranscribe failed: ${(error as Error).message}`);
        }
      };

      if (!textOnly && !originalText && !opts.sameLanguage) await retranscribeOnce();

      const needTranslate = [
        ...new Set(
          transmission.targets
            .map((t) => t.language)
            .filter((lang) => lang !== sourceLang),
        ),
      ];
      if (!originalText && (textOnly || !transmission.originalAudioUrl)) {
        gate("speech");
        this.logger.log(
          `Clock ${transmission.id} recvToReady=${Date.now() - started} sttMs=${sttMs} translateMs=0 skipped=empty`,
        );
        void this.prisma.transmission.update({
          where: { id: transmission.id },
          data: { status: "READY", originalText: null },
        });
        return;
      }
      // No words heard — still deliver the recording as it sounded (noise included).
      if (!originalText && !textOnly) {
        originalText = "";
        sourceLang = speakerLang;
      }
      this.logger.log(`Source ${transmission.id} spoke=${sourceLang} profile=${speakerLang}`);
      const keepNames = textOnly
        ? people.map((p) => p.displayName).filter((name) => name && !/^(מנהל|admin|manager)$/i.test(name))
        : [];
      const planById = new Map(people.map((p) => [p.id, p.plan === "PLUS" ? "PLUS" : "FREE"] as const));
      const byLang: Record<string, string> = { [sourceLang]: originalText };
      const voiceGender =
        sender.voiceGender === "female" || sender.voiceGender === "child" ? sender.voiceGender : "male";
      const ttsByLang: Record<string, string | null> = {};
      const langsToFill = textOnly
        ? [...new Set(transmission.targets.map((t) => t.language).filter((lang) => lang !== sourceLang))]
        : needTranslate;

      const incomingByOwner = new Map(incomingRows.map((row) => [row.ownerId, row]));
      const senderPublic = toPublicUser(sender);
      const originalAudio = textOnly ? null : this.storage.publicUrl(transmission.originalAudioUrl);
      const senderMode: ReceiveMode = sender.plan === "PLUS" ? "plus" : "free";
      const deliveredJobs: Promise<void>[] = [];
      const channelRow = await this.prisma.channel.findUnique({
        where: { id: transmission.channelId },
        select: { type: true },
      });
      const group = isGroupType(channelRow?.type);
      const hidePhoto = await this.hideAvatarFor(
        sender.id,
        transmission.targets.map((row) => row.userId),
      );

      const emitTarget = (
        target: { id: string; userId: string; language: string },
        audioUrl: string | null,
        usedOriginalVoice: boolean,
      ) => {
        const incoming = incomingByOwner.get(target.userId);
        const plus = planById.get(target.userId) === "PLUS";
        const sameLang = target.language === sourceLang;
        const first = incoming?.status !== "ACCEPTED";
        const mutualHeard =
          recipientHeardSender.has(target.userId) && senderHeardRecipient.has(target.userId);
        const live =
          delivery === "walkie" &&
          mutualHeard &&
          Boolean(senderOnline) &&
          onlineTargets.has(target.userId);
        const publicAudio = audioUrl ? this.storage.publicUrl(audioUrl) : null;
        const payload: TransmissionReadyPayload = {
          transmissionId: transmission.id,
          channelId: transmission.channelId,
          senderId: sender.id,
          senderName: sender.displayName || sender.phoneE164,
          language: target.language,
          speakLang: sourceLang,
          mode: plus ? "plus" : "free",
          audioUrl: publicAudio,
          originalText,
          translatedText: sameLang
            ? originalText
            : byLang[target.language] || (textOnly ? originalText : ""),
          durationMs: textOnly ? null : transmission.durationMs,
          usedOriginalVoice,
          replyToId: quoted.reply?.id || null,
          replyToName: quoted.reply?.name || null,
          replyToText: quoted.reply?.text || null,
          needsAccept: first || (delivery === "walkie" && !live),
          live,
          senderPhone: sender.phoneE164,
          senderAvatarUrl: hidePhoto.has(target.userId) ? null : senderPublic.avatarUrl,
          voiceGender,
          kind: delivery,
          viewOnce: Boolean(transmission.viewOnce),
          releasedAt: clientRelease,
          readyAt: Date.now(),
          expiresAt: transmission.expiresAt?.toISOString() || null,
          group,
        };
        const reached = this.realtime.emitToUser(target.userId, SOCKET_EVENTS.TRANSMISSION_READY, payload);
        this.logger.log(`Deliver ${delivery} ${transmission.id} -> ${target.userId} reached=${reached}`);
        if (delivery === "walkie") {
          void this.prisma.transmissionTarget.update({
            where: { id: target.id },
            data: { deliveredAt: new Date() },
          });
        } else if (reached) {
          deliveredJobs.push(this.noteDelivered(target.id, sender.id, transmission.id, target.userId));
        }
        if (!reached) {
          void this.push.notifyOfflineMessage(target.userId, {
            transmissionId: transmission.id,
            channelId: transmission.channelId,
            kind: delivery,
            type: delivery === "walkie" ? "walkie" : "message",
            senderId: sender.id,
            senderName: sender.displayName || sender.phoneE164,
            senderPhone: sender.phoneE164,
            senderAvatarUrl: hidePhoto.has(target.userId) ? "" : senderPublic.avatarUrl || "",
            audioUrl: publicAudio || "",
            originalText,
            translatedText: payload.translatedText || originalText || "",
            speakLang: sourceLang,
            language: target.language,
          });
        }
      };

      const blockedTargets = transmission.targets.filter(
        (t) => incomingByOwner.get(t.userId)?.status === "BLOCKED",
      );
      if (blockedTargets.length) {
        await this.prisma.transmissionTarget.deleteMany({
          where: { id: { in: blockedTargets.map((row) => row.id) } },
        });
        transmission.targets = transmission.targets.filter(
          (t) => incomingByOwner.get(t.userId)?.status !== "BLOCKED",
        );
      }
      // Same language keeps the original voice. Every other language, including Hebrew, is translated.
      const sameTargets = transmission.targets.filter((t) => t.language === sourceLang);
      const crossTargets = transmission.targets.filter((t) => !sameTargets.includes(t));
      for (const target of sameTargets) {
        if (textOnly) {
          emitTarget(target, null, true);
        } else {
          emitTarget(target, transmission.originalAudioUrl, true);
        }
      }
      if (sameTargets.length) {
        this.logger.log(
          `Fast ${transmission.id} sameLang=${sourceLang} targets=${sameTargets.length} at ${Date.now() - started}ms`,
        );
      }
      const translateMark = Date.now();
      if (originalText && langsToFill.length) {
        await Promise.all(
          langsToFill.map(async (language) => {
            const listenerGenders = [
              ...new Set(
                transmission.targets
                  .filter((row) => row.language === language)
                  .map((row) => {
                    const peer = people.find((p) => p.id === row.userId);
                    const g = peer?.voiceGender;
                    return g === "female" || g === "child" || g === "male" ? g : "";
                  })
                  .filter(Boolean),
              ),
            ];
            const translated = await this.translate.translate(
              originalText,
              sourceLang,
              language,
              keepNames,
              textOnly,
              textOnly
                ? {
                    speakerGender:
                      sender.voiceGender === "female" || sender.voiceGender === "child"
                        ? sender.voiceGender
                        : "male",
                    listenerGender: listenerGenders.length === 1 ? listenerGenders[0] : undefined,
                  }
                : undefined,
            );
            if (!translated.text) {
              gate(translated.reason || "faithfulness", originalText);
              byLang[language] = "";
              ttsByLang[language] = null;
              return;
            }
            byLang[language] = translated.text;
            const said = originalText.replace(/\s+/g, " ").trim();
            const heard = translated.text.replace(/\s+/g, " ").trim();
            this.logger.log(
              `Walkie ${transmission.id} ${sourceLang}->${language} "${said.slice(0, 80)}" => "${heard.slice(0, 80)}"`,
            );
            if (textOnly) {
              ttsByLang[language] = null;
              return;
            }
            const clonedVoice =
              sender.plan === "PLUS" && sender.elevenVoiceId && !sender.elevenVoiceId.startsWith("mock-")
                ? sender.elevenVoiceId
                : null;
            const saved = await this.tts.speak(
              byLang[language],
              language,
              clonedVoice,
              voiceGender,
              {
                allowEleven: true,
                preferEleven: true,
                timeoutMs: delivery === "voice" ? 8000 : 7000,
              },
            );
            ttsByLang[language] = saved || null;
            if (!saved) gate("voice", originalText);
          }),
        );
      }
      const translateMs = Date.now() - translateMark;

      const fallbackLangs = new Set<string>();
      const persistRenders = async () => {
        try {
          await Promise.all(
            Object.entries(byLang).map(([language, translatedText]) => {
              const fellBack = fallbackLangs.has(language);
              if (!translatedText && !fellBack) return null;
              const audioPath =
                language === sourceLang || fellBack
                  ? transmission.originalAudioUrl || ""
                  : ttsByLang[language] || "";
              if (language !== sourceLang && !textOnly && !audioPath) return null;
              return this.prisma.transmissionRender.upsert({
                where: { transmissionId_language: { transmissionId: transmission.id, language } },
                create: {
                  transmissionId: transmission.id,
                  language,
                  audioUrl: audioPath || transmission.originalAudioUrl || "",
                  translatedText: translatedText || null,
                },
                update: {
                  translatedText: translatedText || null,
                  ...(audioPath ? { audioUrl: audioPath } : {}),
                },
              });
            }),
          );
        } catch (error) {
          this.logger.warn(`Render upsert failed ${transmission.id}: ${(error as Error).message}`);
        }
      };
      const markReady = async () => {
        try {
          await this.prisma.transmission.update({
            where: { id: transmission.id },
            data: { originalText: packReply(originalText || "", quoted.reply) || null, status: "READY" },
          });
        } catch (error) {
          this.logger.error(`READY update failed ${transmission.id}: ${(error as Error).message}`);
        }
      };

      // Text chat: mark missing translations as fallbacks, then persist before notify.
      if (textOnly) {
        for (const language of langsToFill) {
          if (!byLang[language]) fallbackLangs.add(language);
        }
        await persistRenders();
        await markReady();
      }

      let crossSent = 0;
      for (const target of crossTargets) {
        const translated = byLang[target.language] || "";
        if (textOnly) {
          if (translated) {
            emitTarget(target, null, false);
          } else if (originalText) {
            emitTarget(target, null, true);
            this.logger.log(`Text ${transmission.id} ${sourceLang}->${target.language} original text`);
          } else {
            continue;
          }
          crossSent += 1;
          continue;
        }
        const storageAudio = translated ? ttsByLang[target.language] || null : null;
        if (storageAudio) {
          emitTarget(target, storageAudio, false);
          crossSent += 1;
          continue;
        }
        if (transmission.originalAudioUrl) {
          emitTarget(target, transmission.originalAudioUrl, true);
          fallbackLangs.add(target.language);
          crossSent += 1;
          this.logger.log(`Walkie ${transmission.id} ${sourceLang}->${target.language} original voice`);
        }
      }
      if (!sameTargets.length && !crossSent && crossTargets.length) {
        await this.prisma.transmission.update({
          where: { id: transmission.id },
          data: { originalText: originalText || null, status: "FAILED" },
        });
        this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_FAILED, {
          transmissionId: transmission.id,
          senderId: sender.id,
        });
        return;
      }

      const readyAt = Date.now();
      const clockSkew = Math.abs(started - clientRelease) > 20000;
      this.logger.log(
        `Clock ${transmission.id} recvToReady=${readyAt - started} sttMs=${sttMs} translateMs=${translateMs}${clockSkew ? "" : ` sinceRelease=${readyAt - clientRelease}`}`,
      );

      if (delivery === "walkie" || delivery === "voice" || delivery === "text") {
        await Promise.all(deliveredJobs);
        const targetRows = await this.prisma.transmissionTarget.findMany({
          where: { transmissionId: transmission.id },
          select: { deliveredAt: true, playedAt: true },
        });
        const senderReceipt = targetRows.some((row) => row.deliveredAt) ? "delivered" : "sent";
        // Sender always gets the source-language transcript back (their language).
        this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_READY, {
          transmissionId: transmission.id,
          channelId: transmission.channelId,
          senderId: sender.id,
          senderName: sender.displayName || sender.phoneE164,
          language: sourceLang,
          speakLang: sourceLang,
          mode: senderMode,
          audioUrl: originalAudio,
          originalText,
          translatedText: originalText,
          durationMs: textOnly ? null : transmission.durationMs,
          usedOriginalVoice: true,
          replyToId: quoted.reply?.id || null,
          replyToName: quoted.reply?.name || null,
          replyToText: quoted.reply?.text || null,
          voiceGender,
          kind: delivery,
          viewOnce: Boolean(transmission.viewOnce),
          releasedAt: clientRelease,
          readyAt: Date.now(),
          receipt: senderReceipt,
          expiresAt: transmission.expiresAt?.toISOString() || null,
        });
      }

      this.logger.log(`Ready ${transmission.id} total=${Date.now() - started}ms src="${originalText.slice(0, 60)}"`);
      const createdAt = new Date().toISOString();
      const peopleById = new Map(people.map((row) => [row.id, row]));
      // Walkie/voice: persist after delivery. Text already persisted above before notify.
      if (!textOnly) {
        await markReady();
        await persistRenders();
      }
      const cloudItems = transmission.targets.flatMap((target) => {
          if (incomingByOwner.get(target.userId)?.status === "BLOCKED") return [];
          const sameLang = target.language === sourceLang;
          const fellBack = fallbackLangs.has(target.language);
          if (!sameLang && !fellBack && !byLang[target.language]) return [];
          if (!sameLang && !fellBack && !textOnly && !ttsByLang[target.language]) return [];
          const walkie = !textOnly && (sameLang || fellBack);
          const plus = planById.get(target.userId) === "PLUS";
          const peer = peopleById.get(target.userId);
          const audioUrl = textOnly
            ? null
            : walkie
              ? originalAudio
              : ttsByLang[target.language]
                ? this.storage.publicUrl(ttsByLang[target.language]!)
                : null;
          const translatedText = sameLang ? originalText : byLang[target.language] || "";
          return [
            {
              ownerId: target.userId,
              id: transmission.id,
              senderName: sender.displayName || sender.phoneE164,
              senderId: sender.id,
              mine: false,
              peerId: sender.id,
              peerName: sender.displayName || sender.phoneE164,
              peerPhone: sender.phoneE164,
              peerAvatar: senderPublic.avatarUrl,
              peerGender: voiceGender,
              originalText,
              translatedText,
              audioUrl,
              language: target.language,
              speakLang: sourceLang,
              mode: (plus ? "plus" : "free") as ReceiveMode,
              createdAt,
              durationMs: textOnly ? null : transmission.durationMs,
              kind: delivery,
              viewOnce: Boolean(transmission.viewOnce),
            },
            {
              ownerId: sender.id,
              id: `${transmission.id}:${target.userId}`,
              senderName: sender.displayName || sender.phoneE164,
              senderId: sender.id,
              mine: true,
              peerId: target.userId,
              peerName: peer?.displayName || peer?.phoneE164 || "",
              peerPhone: peer?.phoneE164 || null,
              peerAvatar: peer?.avatarUrl ? publicMedia(this.storage, peer.avatarUrl) : null,
              peerGender:
                peer?.voiceGender === "female" || peer?.voiceGender === "child" ? peer.voiceGender : "male",
              originalText,
              // Sender's own history row stays in the language they spoke.
              translatedText: originalText,
              audioUrl: originalAudio,
              language: sourceLang,
              speakLang: sourceLang,
              mode: senderMode,
              createdAt,
              durationMs: textOnly ? null : transmission.durationMs,
              kind: delivery,
              viewOnce: Boolean(transmission.viewOnce),
              receipt: "sent",
            },
          ];
        });
      if (!cloudItems.some((row) => row.ownerId === sender.id && row.mine)) {
        const member = await this.prisma.channelMember.findFirst({
          where: { channelId: transmission.channelId, userId: { not: sender.id } },
          include: { user: true },
        });
        const peer = member?.user;
        if (peer) {
          cloudItems.push({
            ownerId: sender.id,
            id: `${transmission.id}:${peer.id}`,
            senderName: sender.displayName || sender.phoneE164,
            senderId: sender.id,
            mine: true,
            peerId: peer.id,
            peerName: peer.displayName || peer.phoneE164 || "",
            peerPhone: peer.phoneE164 || null,
            peerAvatar: peer.avatarUrl ? publicMedia(this.storage, peer.avatarUrl) : null,
            peerGender:
              peer.voiceGender === "female" || peer.voiceGender === "child" ? peer.voiceGender : "male",
            originalText,
            translatedText: originalText,
            audioUrl: originalAudio,
            language: sourceLang,
            speakLang: sourceLang,
            mode: senderMode,
            createdAt,
            durationMs: textOnly ? null : transmission.durationMs,
            kind: delivery,
            viewOnce: Boolean(transmission.viewOnce),
            receipt: "sent",
          });
        }
      }
      void this.firebase.saveItems(cloudItems as Array<HistoryItem & { ownerId: string }>);
    } catch {
      this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_FAILED, {
        transmissionId: transmission.id,
      });
    }
  }

  async history(user: User) {
    // Local DB first — never block the inbox on Firebase round-trips.
    const local = await this.localHistory(user);
    void this.markInboxDelivered(user.id).catch((error) => {
      this.logger.warn(`Inbox delivered: ${(error as Error).message}`);
    });
    void this.syncHistoryCloud(user.id, local).catch((error) => {
      this.logger.warn(`History cloud sync: ${(error as Error).message}`);
    });
    return local;
  }

  private async syncHistoryCloud(ownerId: string, local: Array<Record<string, unknown>>) {
    const cloud = await this.firebase.listHistory(ownerId);
    if (!cloud.length && !local.length) return;
    const missing = local.filter((item) => !cloud.some((row) => row.id === String(item.id)));
    if (missing.length) {
      void this.firebase.saveItems(missing.map((item) => ({ ...(item as HistoryItem), ownerId })));
    }
  }

  private async localHistory(user: User) {
    const [received, sent] = await Promise.all([
      this.prisma.transmissionTarget.findMany({
        where: { userId: user.id },
        include: { transmission: { include: { sender: true, renders: true, channel: true } } },
        orderBy: { transmission: { createdAt: "desc" } },
        take: 80,
      }),
      this.prisma.transmission.findMany({
        where: { senderId: user.id },
        include: { targets: { include: { user: true } }, renders: true, channel: true },
        orderBy: { createdAt: "desc" },
        take: 80,
      }),
    ]);
    const items: Array<Record<string, unknown>> = [];
    const blockedViewer = await this.prisma.contact.findMany({
      where: { matchedUserId: user.id, status: "BLOCKED" },
      select: { ownerId: true },
    });
    const hideAvatarFrom = new Set(blockedViewer.map((row) => row.ownerId));
    for (const row of received) {
      const tx = row.transmission;
      if (tx.senderId === user.id) continue;
      if (tx.expiresAt && tx.expiresAt.getTime() < Date.now()) continue;
      const group = tx.channel?.type === "GROUP" || tx.channel?.type === "BROADCAST";
      const senderPublic = toPublicUser(tx.sender);
      const kind = tx.kind || (tx.originalAudioUrl ? "walkie" : "text");
      const quoted = decodeReply(tx.originalText);
      const sourceLang =
        detectLang(quoted.text) || tx.sender.speakLang || tx.sender.listenLang;
      const listenLang = row.language || user.listenLang || user.speakLang;
      const sameLang = listenLang === sourceLang;
      const langRender = tx.renders.find((r) => r.language === listenLang) ?? tx.renders[0];
      // Walkie replies: play in the listener's language (TTS) when languages differ.
      const audioUrl =
        kind === "walkie" && !sameLang
          ? publicMedia(this.storage, langRender?.audioUrl)
          : publicMedia(this.storage, sameLang ? tx.originalAudioUrl : langRender?.audioUrl || tx.originalAudioUrl);
      items.push({
        id: tx.id,
        senderName: tx.sender.displayName || tx.sender.phoneE164,
        senderId: tx.senderId,
        mine: false,
        peerId: group ? tx.channelId : tx.senderId,
        peerName: group
          ? tx.channel?.name || tx.sender.displayName || tx.sender.phoneE164
          : tx.sender.displayName || tx.sender.phoneE164,
        peerPhone: group ? null : tx.sender.phoneE164,
        peerAvatar: group
          ? tx.channel?.avatarUrl || senderPublic.avatarUrl
          : hideAvatarFrom.has(tx.senderId)
            ? null
            : senderPublic.avatarUrl,
        channelId: tx.channelId,
        peerGender: senderPublic.voiceGender,
        originalText: quoted.text || tx.originalText,
        translatedText: (langRender?.translatedText ?? quoted.text) || tx.originalText,
        replyToId: quoted.reply?.id || null,
        replyToName: quoted.reply?.name || null,
        replyToText: quoted.reply?.text || null,
        audioUrl: tx.viewOnce && !tx.originalAudioUrl ? null : audioUrl,
        language: listenLang,
        speakLang: sourceLang,
        mode: "free",
        createdAt: tx.createdAt.toISOString(),
        durationMs: tx.durationMs,
        kind,
        viewOnce: Boolean(tx.viewOnce),
        openedOnce: Boolean(tx.viewOnce && !tx.originalAudioUrl),
        expiresAt: tx.expiresAt?.toISOString() || null,
      });
    }
    const grouped = new Set<string>();
    for (const tx of sent) {
      if (tx.expiresAt && tx.expiresAt.getTime() < Date.now()) continue;
      const group = tx.channel?.type === "GROUP" || tx.channel?.type === "BROADCAST";
      if (group) {
        if (grouped.has(tx.id)) continue;
        grouped.add(tx.id);
        const quoted = decodeReply(tx.originalText);
        const sourceLang = detectLang(quoted.text) || user.speakLang || user.listenLang;
        const targets = tx.targets.filter((row) => row.userId !== user.id);
        const receipt = targets.every((row) => row.playedAt)
          ? "read"
          : targets.some((row) => row.deliveredAt)
            ? "delivered"
            : "sent";
        items.push({
          id: tx.id,
          senderName: user.displayName,
          senderId: user.id,
          mine: true,
          peerId: tx.channelId,
          peerName: tx.channel?.name || "",
          peerAvatar: tx.channel?.avatarUrl || null,
          channelId: tx.channelId,
          originalText: quoted.text || tx.originalText,
          translatedText: quoted.text || tx.originalText,
          replyToId: quoted.reply?.id || null,
          replyToName: quoted.reply?.name || null,
          replyToText: quoted.reply?.text || null,
          audioUrl: tx.viewOnce && !tx.originalAudioUrl ? null : publicMedia(this.storage, tx.originalAudioUrl),
          language: sourceLang,
          speakLang: sourceLang,
          mode: "free",
          createdAt: tx.createdAt.toISOString(),
          durationMs: tx.durationMs,
          kind: tx.kind || (tx.originalAudioUrl ? "walkie" : "text"),
          viewOnce: Boolean(tx.viewOnce),
          openedOnce: Boolean(tx.viewOnce && !tx.originalAudioUrl),
          receipt,
          expiresAt: tx.expiresAt?.toISOString() || null,
        });
        continue;
      }
      const outbound = tx.targets.filter((row) => row.userId !== user.id);
      if (!outbound.length) {
        const quoted = decodeReply(tx.originalText);
        const sourceLang = detectLang(quoted.text) || user.speakLang || user.listenLang;
        const member = await this.prisma.channelMember.findFirst({
          where: { channelId: tx.channelId, userId: { not: user.id } },
          include: { user: true },
        });
        const other = member?.user;
        items.push({
          id: other?.id ? `${tx.id}:${other.id}` : tx.id,
          senderName: user.displayName || user.phoneE164,
          senderId: user.id,
          mine: true,
          peerId: other?.id || tx.channelId,
          peerName: other?.displayName || other?.phoneE164 || "",
          peerPhone: other?.phoneE164 || null,
          peerAvatar: other ? toPublicUser(other).avatarUrl : null,
          peerGender: other ? toPublicUser(other).voiceGender : "male",
          originalText: quoted.text || tx.originalText,
          translatedText: quoted.text || tx.originalText,
          replyToId: quoted.reply?.id || null,
          replyToName: quoted.reply?.name || null,
          replyToText: quoted.reply?.text || null,
          audioUrl: tx.viewOnce && !tx.originalAudioUrl ? null : publicMedia(this.storage, tx.originalAudioUrl),
          language: sourceLang,
          speakLang: sourceLang,
          mode: "free",
          createdAt: tx.createdAt.toISOString(),
          durationMs: tx.durationMs,
          kind: tx.kind || (tx.originalAudioUrl ? "walkie" : "text"),
          viewOnce: Boolean(tx.viewOnce),
          openedOnce: Boolean(tx.viewOnce && !tx.originalAudioUrl),
          receipt: "sent",
          channelId: tx.channelId,
          expiresAt: tx.expiresAt?.toISOString() || null,
        });
        continue;
      }
      for (const target of outbound) {
        const peer = toPublicUser(target.user);
        const quoted = decodeReply(tx.originalText);
        const sourceLang =
          detectLang(quoted.text) || user.speakLang || user.listenLang;
        items.push({
          id: `${tx.id}:${target.userId}`,
          senderName: user.displayName || user.phoneE164,
          senderId: user.id,
          mine: true,
          peerId: target.userId,
          peerName: target.user.displayName || target.user.phoneE164,
          peerPhone: target.user.phoneE164,
          peerAvatar: peer.avatarUrl,
          peerGender: peer.voiceGender,
          originalText: quoted.text || tx.originalText,
          translatedText: quoted.text || tx.originalText,
          replyToId: quoted.reply?.id || null,
          replyToName: quoted.reply?.name || null,
          replyToText: quoted.reply?.text || null,
          audioUrl: tx.viewOnce && !tx.originalAudioUrl ? null : publicMedia(this.storage, tx.originalAudioUrl),
          language: sourceLang,
          speakLang: sourceLang,
          mode: "free",
          createdAt: tx.createdAt.toISOString(),
          durationMs: tx.durationMs,
          kind: tx.kind || (tx.originalAudioUrl ? "walkie" : "text"),
          viewOnce: Boolean(tx.viewOnce),
          openedOnce: Boolean(tx.viewOnce && !tx.originalAudioUrl),
          receipt: target.playedAt ? "read" : target.deliveredAt ? "delivered" : "sent",
          channelId: tx.channelId,
          expiresAt: tx.expiresAt?.toISOString() || null,
        });
      }
    }
    items.sort(
      (a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
    );
    return items.slice(0, 150);
  }

  async waiting(user: User): Promise<TransmissionReadyPayload[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stuckBefore = new Date(Date.now() - 12_000);
    const rows = await this.prisma.transmissionTarget.findMany({
      where: {
        userId: user.id,
        playedAt: null,
        transmission: {
          senderId: { not: user.id },
          kind: "walkie",
          createdAt: { gte: since },
          OR: [
            { status: "READY" },
            // Recover rows that finished pipeline but READY update lagged / failed.
            { status: "PROCESSING", createdAt: { lt: stuckBefore }, renders: { some: {} } },
          ],
        },
      },
      include: { transmission: { include: { sender: true, renders: true, channel: true } } },
      orderBy: { transmission: { createdAt: "asc" } },
      take: 40,
    });
    if (!rows.length) return [];
    const incomingRows = await this.prisma.contact.findMany({
      where: {
        ownerId: user.id,
        matchedUserId: { in: rows.map((row) => row.transmission.senderId) },
      },
    });
    const incomingBySender = new Map(incomingRows.map((row) => [row.matchedUserId, row]));
    const payloads: TransmissionReadyPayload[] = [];
    for (const row of rows) {
      const tx = row.transmission;
      if (incomingBySender.get(tx.senderId)?.status === "BLOCKED") continue;
      const senderPublic = toPublicUser(tx.sender);
      const quoted = decodeReply(tx.originalText);
      const sourceLang =
        detectLang(quoted.text) ||
        tx.sender.speakLang ||
        tx.sender.listenLang;
      const sameLang = row.language === sourceLang;
      const langRender = tx.renders.find((r) => r.language === row.language);
      const audioUrl = sameLang
        ? publicMedia(this.storage, tx.originalAudioUrl)
        : publicMedia(this.storage, langRender?.audioUrl) || null;
      if (!audioUrl && !(tx.originalText || langRender?.translatedText)) continue;
      payloads.push({
        transmissionId: tx.id,
        channelId: tx.channelId,
        senderId: tx.senderId,
        senderName: tx.sender.displayName || tx.sender.phoneE164,
        language: row.language,
        speakLang: sourceLang,
        mode: user.plan === "PLUS" ? "plus" : "free",
        audioUrl,
        originalText: quoted.text || tx.originalText,
        translatedText: sameLang ? quoted.text || tx.originalText : langRender?.translatedText || "",
        replyToId: quoted.reply?.id || null,
        replyToName: quoted.reply?.name || null,
        replyToText: quoted.reply?.text || null,
        durationMs: tx.durationMs,
        usedOriginalVoice: sameLang,
        suppressOriginal: !sameLang,
        needsAccept: true,
        live: false,
        senderPhone: tx.sender.phoneE164,
        senderAvatarUrl: senderPublic.avatarUrl,
        voiceGender: senderPublic.voiceGender ?? "male",
        kind: "walkie",
        viewOnce: Boolean(tx.viewOnce),
        readyAt: new Date(tx.createdAt).getTime(),
        releasedAt: new Date(tx.createdAt).getTime(),
        group: isGroupType(tx.channel?.type),
      });
    }
    return payloads;
  }

  async unread(user: User) {
    const rows = await this.prisma.transmissionTarget.findMany({
      where: {
        userId: user.id,
        playedAt: null,
        transmission: {
          senderId: { not: user.id },
          status: "READY",
          OR: [{ kind: { in: ["text", "voice"] } }, { originalAudioUrl: "" }],
        },
      },
      select: { transmission: { select: { senderId: true } } },
    });
    const byPeer: Record<string, number> = {};
    for (const row of rows) {
      const id = row.transmission.senderId;
      byPeer[id] = (byPeer[id] || 0) + 1;
    }
    return { total: rows.length, byPeer };
  }

  async markPeerTextRead(user: User, peerId: string) {
    if (!peerId) return { ok: true };
    const pending = await this.prisma.transmissionTarget.findMany({
      where: {
        userId: user.id,
        playedAt: null,
        transmission: {
          senderId: peerId,
          OR: [{ kind: { in: ["text", "voice"] } }, { originalAudioUrl: "" }],
        },
      },
      select: { id: true, transmissionId: true, deliveredAt: true },
    });
    if (!pending.length) return { ok: true };
    const now = new Date();
    await this.prisma.transmissionTarget.updateMany({
      where: { id: { in: pending.map((row) => row.id) } },
      data: { playedAt: now },
    });
    const undelivered = pending.filter((row) => !row.deliveredAt).map((row) => row.id);
    if (undelivered.length) {
      await this.prisma.transmissionTarget.updateMany({
        where: { id: { in: undelivered } },
        data: { deliveredAt: now },
      });
    }
    for (const row of pending) {
      this.realtime.emitToUser(peerId, "chat:receipt", {
        transmissionId: row.transmissionId,
        peerId: user.id,
        receipt: "read",
      });
    }
    for (const id of [...new Set(pending.map((row) => row.transmissionId))]) {
      void this.purgeChatIfDelivered(id);
    }
    return { ok: true };
  }

  async markDelivered(user: User, transmissionId: string) {
    if (!transmissionId) return { ok: true };
    const row = await this.prisma.transmissionTarget.findFirst({
      where: { transmissionId, userId: user.id },
      include: { transmission: { select: { senderId: true, kind: true } } },
    });
    if (!row || row.transmission.kind === "walkie" || row.deliveredAt) return { ok: true };
    await this.prisma.transmissionTarget.update({
      where: { id: row.id },
      data: { deliveredAt: new Date() },
    });
    this.realtime.emitToUser(row.transmission.senderId, "chat:receipt", {
      transmissionId,
      peerId: user.id,
      receipt: row.playedAt ? "read" : "delivered",
    });
    void this.purgeChatIfDelivered(transmissionId);
    return { ok: true };
  }

  /** Chat only. Drop the server copy once every recipient has it — reconnect must not replay. */
  async purgeChatIfDelivered(transmissionId: string) {
    if (!transmissionId) return;
    const tx = await this.prisma.transmission.findUnique({
      where: { id: transmissionId },
      include: { targets: true, renders: true },
    });
    if (!tx) return;
    if (tx.kind !== "text" && tx.kind !== "voice" && tx.kind !== "image" && tx.kind !== "video") return;
    if (!tx.targets.length || tx.targets.some((row) => !row.deliveredAt)) return;
    try {
      await this.storage.remove(tx.originalAudioUrl);
      for (const render of tx.renders) await this.storage.remove(render.audioUrl);
    } catch (error) {
      this.logger.warn(`chat purge files ${tx.id}: ${(error as Error).message}`);
    }
    const watchers = [...new Set([tx.senderId, ...tx.targets.map((row) => row.userId)])];
    if (tx.clientLocalId) {
      this.claimedLocal.set(`${tx.senderId}:${tx.clientLocalId}`, { id: tx.id, at: Date.now() });
    }
    await this.prisma.transmission.delete({ where: { id: tx.id } });
    void this.firebase.removeTransmission(watchers, tx.id);
    this.logger.log(`chat purged ${tx.id} kind=${tx.kind} targets=${tx.targets.length}`);
  }

  private async noteDelivered(targetRowId: string, senderId: string, transmissionId: string, peerId: string) {
    const updated = await this.prisma.transmissionTarget.updateMany({
      where: { id: targetRowId, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
    if (!updated.count) return;
    this.realtime.emitToUser(senderId, "chat:receipt", {
      transmissionId,
      peerId,
      receipt: "delivered",
    });
    void this.purgeChatIfDelivered(transmissionId);
  }

  private async markInboxDelivered(userId: string) {
    const rows = await this.prisma.transmissionTarget.findMany({
      where: {
        userId,
        deliveredAt: null,
        transmission: {
          senderId: { not: userId },
          status: "READY",
          OR: [{ kind: { in: ["text", "voice"] } }, { originalAudioUrl: "" }],
        },
      },
      select: {
        id: true,
        transmissionId: true,
        playedAt: true,
        transmission: { select: { senderId: true } },
      },
      take: 80,
    });
    if (!rows.length) return;
    await this.prisma.transmissionTarget.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { deliveredAt: new Date() },
    });
    for (const row of rows) {
      this.realtime.emitToUser(row.transmission.senderId, "chat:receipt", {
        transmissionId: row.transmissionId,
        peerId: userId,
        receipt: row.playedAt ? "read" : "delivered",
      });
    }
    for (const id of [...new Set(rows.map((row) => row.transmissionId))]) {
      void this.purgeChatIfDelivered(id);
    }
  }

  async markPlayed(user: User, transmissionId: string) {
    if (!transmissionId) return { ok: true };
    const row = await this.prisma.transmissionTarget.findFirst({
      where: { transmissionId, userId: user.id },
      include: { transmission: { select: { senderId: true, kind: true } } },
    });
    if (!row) return { ok: true };
    const now = new Date();
    const data: { playedAt?: Date; deliveredAt?: Date } = {};
    if (!row.playedAt) data.playedAt = now;
    if (!row.deliveredAt) data.deliveredAt = now;
    if (Object.keys(data).length) {
      await this.prisma.transmissionTarget.update({
        where: { id: row.id },
        data,
      });
    }
    // Walkie ACK is playedAt only (PTT UI stays visual). Chat emits read ticks.
    if (!row.playedAt && row.transmission.kind !== "walkie") {
      this.realtime.emitToUser(row.transmission.senderId, "chat:receipt", {
        transmissionId,
        peerId: user.id,
        receipt: "read",
      });
    }
    if (row.transmission.kind !== "walkie") void this.purgeChatIfDelivered(transmissionId);
    return { ok: true };
  }

  async closeViewOnce(user: User, transmissionId: string) {
    const tx = await this.prisma.transmission.findUnique({
      where: { id: transmissionId },
      include: { targets: true, renders: true },
    });
    if (!tx?.viewOnce) throw new BadRequestException("זו לא הודעה חד-פעמית");
    const allowed = tx.senderId === user.id || tx.targets.some((row) => row.userId === user.id);
    if (!allowed) throw new ForbiddenException();
    const burn = tx.targets.some((row) => row.userId === user.id);
    if (!burn) return { ok: true, kept: true };
    await this.storage.remove(tx.originalAudioUrl);
    for (const render of tx.renders) await this.storage.remove(render.audioUrl);
    await this.prisma.transmission.update({
      where: { id: tx.id },
      data: { originalAudioUrl: "" },
    });
    await this.prisma.transmissionTarget.updateMany({
      where: { transmissionId: tx.id },
      data: { playedAt: new Date() },
    });
    const watchers = [...new Set([tx.senderId, ...tx.targets.map((row) => row.userId)])];
    for (const id of watchers) {
      this.realtime.emitToUser(id, SOCKET_EVENTS.TRANSMISSION_REMOVED, { transmissionId: tx.id, opened: true });
      this.realtime.emitToUser(id, SOCKET_EVENTS.CHAT_RECEIPT, {
        transmissionId: tx.id,
        peerId: tx.senderId,
        receipt: "read",
      });
    }
    return { ok: true };
  }

  async unsend(user: User, transmissionId: string) {
    const tx = await this.prisma.transmission.findUnique({
      where: { id: transmissionId },
      include: { targets: true, renders: true },
    });
    if (!tx) throw new NotFoundException();
    if (tx.senderId !== user.id) throw new ForbiddenException();
    await this.storage.remove(tx.originalAudioUrl);
    for (const render of tx.renders) await this.storage.remove(render.audioUrl);
    const watchers = [...new Set([tx.senderId, ...tx.targets.map((row) => row.userId)])];
    await this.prisma.transmission.delete({ where: { id: tx.id } });
    void this.firebase.removeTransmission(watchers, tx.id);
    for (const id of watchers) {
      this.realtime.emitToUser(id, SOCKET_EVENTS.TRANSMISSION_REMOVED, { transmissionId: tx.id }, true);
    }
    return { ok: true };
  }

  private async existingByClientLocalId(senderId: string, clientLocalId: string) {
    const row = await this.prisma.transmission.findFirst({
      where: { senderId, clientLocalId },
      select: { id: true, channelId: true, status: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      status: (row.status === "READY" ? "READY" : "PROCESSING") as "READY" | "PROCESSING",
      channelId: row.channelId,
    };
  }

  private async expiryData(channelId: string) {
    const expiresAt = await this.expiryFor(channelId);
    return expiresAt ? { expiresAt } : {};
  }

  private async expiryFor(channelId: string) {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ disappearAfterSec: number | null }>>`
        SELECT "disappearAfterSec" FROM "Channel" WHERE "id" = ${channelId} LIMIT 1
      `;
      const sec = rows[0]?.disappearAfterSec || 0;
      if (sec <= 0) return null;
      return new Date(Date.now() + sec * 1000);
    } catch {
      return null;
    }
  }

  private async planTargets(
    sender: User,
    input: { channelId?: string; channelIds?: string[]; targetUserIds?: string[]; everyone?: boolean },
    kind: "walkie" | "voice" | "text" | "image" | "video",
  ) {
    const deliverIds = await this.resolveTargets(sender, input);
    if (deliverIds.length) return { deliverIds, channelIds: deliverIds, silent: false };
    const direct = [...new Set((input.targetUserIds || []).filter((id) => id && id !== sender.id))];
    const silent = kind !== "walkie" && !input.everyone && direct.length === 1;
    if (silent) return { deliverIds: [] as string[], channelIds: direct, silent: true };
    throw new BadRequestException("לא נבחרו נמענים");
  }

  private async hideAvatarFor(senderId: string, targetIds: string[]) {
    if (!targetIds.length) return new Set<string>();
    const rows = await this.prisma.contact.findMany({
      where: { ownerId: senderId, matchedUserId: { in: targetIds }, status: "BLOCKED" },
      select: { matchedUserId: true },
    });
    return new Set(rows.map((row) => row.matchedUserId).filter((id): id is string => Boolean(id)));
  }

  private async resolveTargets(
    sender: User,
    input: { channelId?: string; channelIds?: string[]; targetUserIds?: string[]; everyone?: boolean },
  ) {
    if (input.everyone) {
      const matches = await this.prisma.contact.findMany({
        where: { ownerId: sender.id, matchedUserId: { not: null }, status: "ACCEPTED" },
        select: { matchedUserId: true },
      });
      const ids = [...new Set(matches.map((m) => m.matchedUserId).filter((id): id is string => Boolean(id)))];
      return this.withoutBlocked(sender.id, ids);
    }
    const extra = (input.targetUserIds || []).filter((id) => id && id !== sender.id);
    const channelIds = [
      ...new Set(
        [input.channelId, ...(input.channelIds || [])]
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter(Boolean),
      ),
    ];
    const fromChannels: string[] = [];
    for (const channelId of channelIds) {
      try {
        await this.channels.assertMember(channelId, sender.id);
      } catch {
        this.logger.warn(`resolveTargets skip channel ${channelId}`);
        continue;
      }
      const members = await this.prisma.channelMember.findMany({
        where: { channelId, userId: { not: sender.id } },
      });
      fromChannels.push(...members.map((m) => m.userId));
    }
    const merged = [...new Set([...fromChannels, ...extra])];
    if (merged.length) return this.withoutBlocked(sender.id, merged);
    return [];
  }

  private async withoutBlocked(senderId: string, targetIds: string[]) {
    if (!targetIds.length) return [];
    const blocked = await this.prisma.contact.findMany({
      where: { ownerId: { in: targetIds }, matchedUserId: senderId, status: "BLOCKED" },
      select: { ownerId: true },
    });
    const blockedIds = new Set(blocked.map((row) => row.ownerId));
    return targetIds.filter((id) => !blockedIds.has(id));
  }

  private async ensureChannel(
    sender: User,
    channelId: string | undefined,
    targetIds: string[],
    opts?: { reuseDirect?: boolean },
  ) {
    const id = channelId?.trim();
    if (id) {
      await this.channels.assertMember(id, sender.id);
      const channel = await this.prisma.channel.findUnique({
        where: { id },
        include: { members: { include: { user: true } } },
      });
      if (!channel) throw new BadRequestException("ערוץ לא נמצא");
      this.logger.log(`ensureChannel keep id=${id} type=${channel.type} targets=${targetIds.length}`);
      return channel;
    }
    const peer = targetIds.find((userId) => userId && userId !== sender.id);
    if (targetIds.length === 1 || (opts?.reuseDirect && peer)) {
      if (!peer) throw new BadRequestException("לא נבחרו נמענים");
      const directId = await this.channels.directChannelId(sender, peer);
      this.realtime.joinChannel(sender.id, directId);
      this.realtime.joinChannel(peer, directId);
      return { id: directId };
    }
    const summary = await this.channels.createGroup(sender, "שידור", targetIds);
    const channel = await this.prisma.channel.findUnique({
      where: { id: summary.id },
      include: { members: { include: { user: true } } },
    });
    if (!channel) throw new BadRequestException("ערוץ לא נמצא");
    for (const memberId of [sender.id, ...targetIds]) this.realtime.joinChannel(memberId, channel.id);
    this.logger.log(`ensureChannel created broadcast id=${channel.id} targets=${targetIds.length}`);
    return channel;
  }
}

function isGroupType(type?: string | null) {
  return type === "GROUP" || type === "BROADCAST";
}

function walkieDeliveryStamps(
  listenerId: string,
  homes: { id: string; name: string }[] | undefined,
  explicit: Set<string>,
) {
  const stamps: { channelId: string; group: boolean; groupName: string }[] = [];
  const seen = new Set<string>();
  const add = (channelId: string, group: boolean, groupName = "") => {
    const key = `${group ? "g" : "u"}:${channelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    stamps.push({ channelId, group, groupName });
  };
  if (homes?.length) {
    for (const home of homes) add(home.id, true, home.name || "");
  }
  if (explicit.has(listenerId)) add("", false);
  return stamps;
}

function walkieDubbedTargets(
  users: User[],
  speak: string,
  payload: TransmissionReadyPayload,
  homesOf?: Map<string, { id: string; name: string }[]>,
  explicit?: Set<string>,
) {
  const dubbed: { targetId: string; language: string; channelId: string; group: boolean; groupName: string }[] = [];
  const src = (speak || "").slice(0, 2).toLowerCase();
  const named = explicit || new Set<string>();
  for (const listener of users) {
    const hear = (listener.listenLang || listener.speakLang || "").slice(0, 2).toLowerCase();
    if (!src || !hear || hear === src) continue;
    const stamps = walkieDeliveryStamps(listener.id, homesOf?.get(listener.id), named);
    for (const stamp of stamps) dubbed.push({ targetId: listener.id, language: hear, ...stamp });
  }
  return dubbed;
}

function walkieReadyFor(
  payload: TransmissionReadyPayload,
  userId: string,
  groupId: string,
  groupMemberIds: Set<string>,
): TransmissionReadyPayload {
  const inGroup = Boolean(groupId) && groupMemberIds.has(userId);
  return { ...payload, group: inGroup, channelId: inGroup ? groupId : payload.channelId };
}

function extFrom(file: Express.Multer.File) {
  const name = file.originalname || "";
  const fromName = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/.test(fromName)) return fromName;
  const mime = file.mimetype || "";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime") || mime.includes("mov")) return "mov";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "m4a";
}

function publicMedia(storage: StorageService, path?: string | null) {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  if (!path.startsWith("/media")) return null;
  return storage.publicUrl(path);
}
