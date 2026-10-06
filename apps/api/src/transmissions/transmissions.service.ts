import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { HistoryItem, SOCKET_EVENTS, TransmissionReadyPayload } from "@talk/shared";
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
    private readonly realtime: RealtimeGateway,
    private readonly presence: PresenceService,
    private readonly push: PushService,
    private readonly firebase: FirebaseRtdbService,
  ) {}

  async create(
    sender: User,
    file: Express.Multer.File,
    input: {
      channelId?: string;
      targetUserIds?: string[];
      everyone?: boolean;
      durationMs?: number;
      originalText?: string;
      kind?: string;
      viewOnce?: boolean;
      releasedAt?: number;
    },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException("חסר קובץ שמע");
    const started = Date.now();
    const releasedAt = Number(input.releasedAt);
    const clientRelease = Number.isFinite(releasedAt) && releasedAt > 0 ? releasedAt : started;
    const ext = extFrom(file);
    const mime = file.mimetype || "audio/mp4";
    const kind = input.kind === "voice" ? "voice" : "walkie";

    const speakerLang = sender.speakLang || sender.listenLang;
    const hint = collapseRepeats(input.originalText?.trim() || "");
    const skipStt = Boolean(hint && !isHallucination(hint) && matchesLang(hint, speakerLang));
    const sttEarly: Promise<SttResult> = skipStt
      ? Promise.resolve({ text: hint, lang: detectLang(hint) || speakerLang })
      : this.stt.transcribeBytes(file.buffer, "", mime, ext);

    const targetIds = await this.resolveTargets(sender, input);
    if (!targetIds.length) throw new BadRequestException("לא נבחרו נמענים");

    const channel = await this.ensureChannel(sender, input.channelId, targetIds);
    const [audioUrl, users] = await Promise.all([
      this.storage.save(file.buffer, ext, "audio"),
      this.prisma.user.findMany({ where: { id: { in: targetIds } } }),
    ]);
    const sttP = sttEarly;

    const transmission = await this.prisma.transmission.create({
      data: {
        senderId: sender.id,
        channelId: channel.id,
        originalAudioUrl: audioUrl,
        originalText: input.originalText?.trim() || null,
        durationMs: input.durationMs ?? null,
        kind,
        viewOnce: kind === "voice" && Boolean(input.viewOnce),
        status: "PROCESSING",
        targets: {
          create: users.map((user) => ({
            userId: user.id,
            language: user.listenLang || user.speakLang,
          })),
        },
      },
      include: { targets: true },
    });

    if (kind === "walkie") {
      this.realtime.emitToChannel(channel.id, SOCKET_EVENTS.TRANSMISSION_PROCESSING, {
        transmissionId: transmission.id,
        channelId: channel.id,
        senderId: sender.id,
        senderName: sender.displayName,
      });
    }

    void this.finish(transmission, sender, sttP, started, { clientRelease });
    void Promise.all(users.map((target) => this.contacts.ensureIncoming(target, sender)));
    return { id: transmission.id, status: "PROCESSING" as const, channelId: channel.id };
  }

  async createText(
    sender: User,
    input: {
      originalText: string;
      channelId?: string;
      targetUserIds?: string[];
      everyone?: boolean;
    },
  ) {
    const originalText = input.originalText.trim();
    if (!originalText) throw new BadRequestException("חסרה הודעה");
    const targetIds = await this.resolveTargets(sender, input);
    if (!targetIds.length) throw new BadRequestException("לא נבחרו נמענים");
    const channel = await this.ensureChannel(sender, input.channelId, targetIds);
    const users = await this.prisma.user.findMany({ where: { id: { in: targetIds } } });
    const transmission = await this.prisma.transmission.create({
      data: {
        senderId: sender.id,
        channelId: channel.id,
        originalAudioUrl: "",
        originalText,
        durationMs: null,
        kind: "text",
        status: "PROCESSING",
        targets: {
          create: users.map((user) => ({
            userId: user.id,
            language: user.listenLang || user.speakLang,
          })),
        },
      },
      include: { targets: true },
    });
    void this.finish(
      transmission,
      sender,
      Promise.resolve({
        text: originalText,
        lang: detectLang(originalText) || sender.speakLang || sender.listenLang,
      }),
      Date.now(),
      { textOnly: true },
    );
    void Promise.all(users.map((target) => this.contacts.ensureIncoming(target, sender)));
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
      targets: { id: string; userId: string; language: string }[];
    },
    sender: User,
    sttP: Promise<SttResult>,
    started: number,
    opts: { textOnly?: boolean; clientRelease?: number } = {},
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
      let originalText = textOnly
        ? usableSpeech(sttResult.text) || sttResult.text.trim()
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

      if (!textOnly && !originalText) await retranscribeOnce();

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
      // Audio present but STT heard nothing — do not emit silent walkie to the other side.
      if (!originalText && !textOnly) {
        gate("speech");
        await this.prisma.transmission.update({
          where: { id: transmission.id },
          data: { status: "FAILED", originalText: null },
        });
        this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_FAILED, {
          transmissionId: transmission.id,
          senderId: sender.id,
        });
        return;
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
      const senderMode = sender.plan === "PLUS" ? "plus" : "free";

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
          needsAccept: first || (delivery === "walkie" && !live),
          live,
          senderPhone: sender.phoneE164,
          senderAvatarUrl: senderPublic.avatarUrl,
          voiceGender,
          kind: delivery,
          viewOnce: Boolean(transmission.viewOnce),
          releasedAt: clientRelease,
          readyAt: Date.now(),
        };
        this.realtime.emitToUser(target.userId, SOCKET_EVENTS.TRANSMISSION_READY, payload);
        void this.prisma.transmissionTarget.update({
          where: { id: target.id },
          data: { deliveredAt: new Date() },
        });
        const title = first
          ? sender.displayName?.trim() || sender.phoneE164
          : sender.displayName || "TALK";
        const body = first
          ? sender.displayName?.trim() && sender.phoneE164 && sender.displayName.trim() !== sender.phoneE164
            ? sender.phoneE164
            : "TALK"
          : delivery === "walkie"
            ? live
              ? "שידור חדש הגיע"
              : "יש שידור שמחכה — לחצו כדי לשמוע"
            : (payload.translatedText || originalText || "הודעה קולית").slice(0, 180);
        void this.push.notifyUsers(
          [target.userId],
          title,
          body,
          {
            transmissionId: transmission.id,
            channelId: transmission.channelId,
            kind: delivery,
            senderId: sender.id,
            senderName: sender.displayName || "",
            senderPhone: sender.phoneE164,
            senderAvatarUrl: senderPublic.avatarUrl || "",
            audioUrl: publicAudio || "",
            needsAccept: payload.needsAccept ? "1" : "0",
            live: live ? "1" : "0",
            usedOriginalVoice: usedOriginalVoice ? "1" : "0",
            speakLang: sourceLang,
            language: target.language,
            voiceGender: voiceGender,
            originalText: originalText || "",
            translatedText: payload.translatedText || "",
          },
          { image: senderPublic.avatarUrl },
        );
      };

      // Same language keeps the original voice. Every other language, including Hebrew, is translated.
      const sameTargets = transmission.targets.filter((t) => {
        if (incomingByOwner.get(t.userId)?.status === "BLOCKED") return false;
        return t.language === sourceLang;
      });
      const crossTargets = transmission.targets.filter(
        (t) => incomingByOwner.get(t.userId)?.status !== "BLOCKED" && !sameTargets.includes(t),
      );
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
            const translated = await this.translate.translate(
              originalText,
              sourceLang,
              language,
              keepNames,
              textOnly,
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
            data: { originalText: originalText || null, status: "READY" },
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
          voiceGender,
          kind: delivery,
          viewOnce: Boolean(transmission.viewOnce),
          releasedAt: clientRelease,
          readyAt: Date.now(),
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
      void this.firebase.saveItems(
        transmission.targets.flatMap((target) => {
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
              peerAvatar: senderPublic.avatarUrl,
              peerGender: voiceGender,
              originalText,
              translatedText,
              audioUrl,
              language: target.language,
              speakLang: sourceLang,
              mode: plus ? "plus" : "free",
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
            },
          ];
        }),
      );
    } catch {
      this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_FAILED, {
        transmissionId: transmission.id,
      });
    }
  }

  async history(user: User) {
    // Local DB first — never block the inbox on Firebase round-trips.
    const local = await this.localHistory(user);
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
        include: { transmission: { include: { sender: true, renders: true } } },
        orderBy: { transmission: { createdAt: "desc" } },
        take: 80,
      }),
      this.prisma.transmission.findMany({
        where: { senderId: user.id },
        include: { targets: { include: { user: true } }, renders: true },
        orderBy: { createdAt: "desc" },
        take: 80,
      }),
    ]);
    const items: Array<Record<string, unknown>> = [];
    for (const row of received) {
      const tx = row.transmission;
      if (tx.senderId === user.id) continue;
      const senderPublic = toPublicUser(tx.sender);
      const kind = tx.kind || (tx.originalAudioUrl ? "walkie" : "text");
      const sourceLang =
        detectLang(tx.originalText || "") || tx.sender.speakLang || tx.sender.listenLang;
      const listenLang = row.language || user.listenLang || user.speakLang;
      const sameLang = listenLang === sourceLang;
      const langRender = tx.renders.find((r) => r.language === listenLang) ?? tx.renders[0];
      // Walkie replies: play in the listener's language (TTS) when languages differ.
      const audioUrl =
        kind === "walkie" && !sameLang
          ? publicMedia(this.storage, langRender?.audioUrl) ||
            publicMedia(this.storage, tx.originalAudioUrl)
          : publicMedia(this.storage, sameLang ? tx.originalAudioUrl : langRender?.audioUrl || tx.originalAudioUrl);
      items.push({
        id: tx.id,
        senderName: tx.sender.displayName,
        senderId: tx.senderId,
        mine: false,
        peerId: tx.senderId,
        peerName: tx.sender.displayName,
        peerAvatar: senderPublic.avatarUrl,
        peerGender: senderPublic.voiceGender,
        originalText: tx.originalText,
        translatedText: langRender?.translatedText ?? tx.originalText,
        audioUrl,
        language: listenLang,
        speakLang: sourceLang,
        mode: "free",
        createdAt: tx.createdAt.toISOString(),
        durationMs: tx.durationMs,
        kind,
        viewOnce: Boolean(tx.viewOnce),
      });
    }
    for (const tx of sent) {
      for (const target of tx.targets) {
        if (target.userId === user.id) continue;
        const peer = toPublicUser(target.user);
        const sourceLang =
          detectLang(tx.originalText || "") || user.speakLang || user.listenLang;
        items.push({
          id: `${tx.id}:${target.userId}`,
          senderName: user.displayName,
          senderId: user.id,
          mine: true,
          peerId: target.userId,
          peerName: target.user.displayName,
          peerAvatar: peer.avatarUrl,
          peerGender: peer.voiceGender,
          originalText: tx.originalText,
          translatedText: tx.originalText,
          audioUrl: publicMedia(this.storage, tx.originalAudioUrl),
          language: sourceLang,
          speakLang: sourceLang,
          mode: "free",
          createdAt: tx.createdAt.toISOString(),
          durationMs: tx.durationMs,
          kind: tx.kind || (tx.originalAudioUrl ? "walkie" : "text"),
          viewOnce: Boolean(tx.viewOnce),
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
      include: { transmission: { include: { sender: true, renders: true } } },
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
      const sourceLang =
        detectLang(tx.originalText || "") ||
        tx.sender.speakLang ||
        tx.sender.listenLang;
      const sameLang = row.language === sourceLang;
      const langRender = tx.renders.find((r) => r.language === row.language);
      const audioUrl = sameLang
        ? publicMedia(this.storage, tx.originalAudioUrl)
        : publicMedia(this.storage, langRender?.audioUrl) || publicMedia(this.storage, tx.originalAudioUrl);
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
        originalText: tx.originalText,
        translatedText: sameLang ? tx.originalText : langRender?.translatedText || "",
        durationMs: tx.durationMs,
        usedOriginalVoice: sameLang || !langRender?.translatedText,
        needsAccept: true,
        live: false,
        senderPhone: tx.sender.phoneE164,
        senderAvatarUrl: senderPublic.avatarUrl,
        voiceGender: senderPublic.voiceGender ?? "male",
        kind: "walkie",
        viewOnce: Boolean(tx.viewOnce),
        readyAt: new Date(tx.createdAt).getTime(),
        releasedAt: new Date(tx.createdAt).getTime(),
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
    await this.prisma.transmissionTarget.updateMany({
      where: {
        userId: user.id,
        playedAt: null,
        transmission: {
          senderId: peerId,
          OR: [{ kind: { in: ["text", "voice"] } }, { originalAudioUrl: "" }],
        },
      },
      data: { playedAt: new Date() },
    });
    return { ok: true };
  }

  async markPlayed(user: User, transmissionId: string) {
    await this.prisma.transmissionTarget.updateMany({
      where: { transmissionId, userId: user.id },
      data: { playedAt: new Date() },
    });
    return { ok: true };
  }

  async closeViewOnce(user: User, transmissionId: string) {
    const tx = await this.prisma.transmission.findUnique({
      where: { id: transmissionId },
      include: { targets: true, renders: true },
    });
    if (!tx?.viewOnce) throw new BadRequestException("זו לא הקלטה חד-פעמית");
    const allowed = tx.senderId === user.id || tx.targets.some((row) => row.userId === user.id);
    if (!allowed) throw new ForbiddenException();
    const burn = tx.targets.some((row) => row.userId === user.id);
    if (!burn) return { ok: true, kept: true };
    await this.storage.remove(tx.originalAudioUrl);
    for (const render of tx.renders) await this.storage.remove(render.audioUrl);
    const watchers = [...new Set([tx.senderId, ...tx.targets.map((row) => row.userId)])];
    await this.prisma.transmission.delete({ where: { id: tx.id } });
    void this.firebase.removeTransmission(watchers, tx.id);
    for (const id of watchers) {
      this.realtime.emitToUser(id, SOCKET_EVENTS.TRANSMISSION_REMOVED, { transmissionId: tx.id });
    }
    return { ok: true };
  }

  private async resolveTargets(
    sender: User,
    input: { channelId?: string; targetUserIds?: string[]; everyone?: boolean },
  ) {
    if (input.everyone) {
      const matches = await this.prisma.contact.findMany({
        where: { ownerId: sender.id, matchedUserId: { not: null }, status: "ACCEPTED" },
        select: { matchedUserId: true },
      });
      const ids = [...new Set(matches.map((m) => m.matchedUserId).filter((id): id is string => Boolean(id)))];
      return this.withoutBlocked(sender.id, ids);
    }
    if (input.targetUserIds?.length) {
      return this.withoutBlocked(
        sender.id,
        [...new Set(input.targetUserIds.filter((id) => id !== sender.id))],
      );
    }
    if (input.channelId) {
      await this.channels.assertMember(input.channelId, sender.id);
      const members = await this.prisma.channelMember.findMany({
        where: { channelId: input.channelId, userId: { not: sender.id } },
      });
      return members.map((m) => m.userId);
    }
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

  private async ensureChannel(sender: User, channelId: string | undefined, targetIds: string[]) {
    if (channelId) {
      await this.channels.assertMember(channelId, sender.id);
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        include: { members: { include: { user: true } } },
      });
      if (!channel) throw new BadRequestException("ערוץ לא נמצא");
      return channel;
    }
    if (targetIds.length === 1) {
      const summary = await this.channels.getOrCreateDirect(sender, targetIds[0]);
      const channel = await this.prisma.channel.findUnique({
        where: { id: summary.id },
        include: { members: { include: { user: true } } },
      });
      if (!channel) throw new BadRequestException("ערוץ לא נמצא");
      this.realtime.joinChannel(sender.id, channel.id);
      this.realtime.joinChannel(targetIds[0], channel.id);
      return channel;
    }
    const summary = await this.channels.createGroup(sender, "שידור", targetIds);
    const channel = await this.prisma.channel.findUnique({
      where: { id: summary.id },
      include: { members: { include: { user: true } } },
    });
    if (!channel) throw new BadRequestException("ערוץ לא נמצא");
    for (const id of [sender.id, ...targetIds]) this.realtime.joinChannel(id, channel.id);
    return channel;
  }
}

function extFrom(file: Express.Multer.File) {
  const fromName = file.originalname.split(".").pop();
  if (fromName && fromName.length <= 5) return fromName;
  return "m4a";
}

function publicMedia(storage: StorageService, path?: string | null) {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  if (!path.startsWith("/media")) return null;
  return storage.publicUrl(path);
}
