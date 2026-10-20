import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { decodeReply, HistoryItem, packReply, SOCKET_EVENTS, TransmissionReadyPayload } from "@talk/shared";
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
      speakLang?: string;
      sourceLanguage?: string;
      replyToId?: string;
      replyToName?: string;
      replyToText?: string;
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
    const targetIds = await this.resolveTargets(sender, input);
    if (!targetIds.length) throw new BadRequestException("לא נבחרו נמענים");

    const users = await this.prisma.user.findMany({ where: { id: { in: targetIds } } });
    if (kind === "walkie") {
      return this.relayWalkie(sender, file, input, users, targetIds, clientRelease, input.sourceLanguage || input.speakLang || "");
    }
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

    const channel = await this.ensureChannel(sender, input.channelId, targetIds);
    const audioUrl = await this.storage.save(file.buffer, ext, "audio");
    const sttP = sttEarly;

    const transmission = await this.prisma.transmission.create({
      data: {
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
        targets: {
          create: users.map((user) => ({
            userId: user.id,
            language: user.listenLang || user.speakLang,
          })),
        },
      },
      include: { targets: true },
    });

    void this.finish(transmission, sender, sttP, started, { clientRelease, sameLanguage });
    void Promise.all(
      users.map(async (target) => {
        await this.contacts.ensureIncoming(target, sender);
        await this.contacts.ensureMutualTalk(sender, target);
      }),
    );
    return { id: transmission.id, status: "PROCESSING" as const, channelId: channel.id };
  }

  /** Walkie is the recording itself. Translation stays in the codebase and is not on this path. */
  private async relayWalkie(
    sender: User,
    file: Express.Multer.File,
    input: { channelId?: string; durationMs?: number },
    users: User[],
    targetIds: string[],
    clientRelease: number,
    sourceLanguage = "",
  ) {
    try {
      return await this.relayWalkieNow(sender, file, input, users, targetIds, clientRelease, sourceLanguage);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2024") {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          return await this.relayWalkieNow(sender, file, input, users, targetIds, clientRelease, sourceLanguage);
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
    input: { channelId?: string; durationMs?: number },
    users: User[],
    targetIds: string[],
    clientRelease: number,
    sourceLanguage = "",
  ) {
    const channel = await this.ensureChannel(sender, input.channelId, targetIds);
    const audioUrl = await this.storage.save(file.buffer, extFrom(file), "audio");
    const lang = (sourceLanguage || sender.speakLang || sender.listenLang || "").slice(0, 2).toLowerCase();
    const transmission = await this.prisma.transmission.create({
      data: {
        senderId: sender.id,
        channelId: channel.id,
        originalAudioUrl: audioUrl,
        originalText: null,
        durationMs: input.durationMs ?? null,
        kind: "walkie",
        viewOnce: false,
        status: "READY",
        targets: {
          create: users.map((user) => ({
            userId: user.id,
            language: (user.listenLang || user.speakLang || lang).slice(0, 2).toLowerCase(),
          })),
        },
      },
      include: { targets: true },
    });
    const senderPublic = toPublicUser(sender);
    const voiceGender =
      sender.voiceGender === "female" || sender.voiceGender === "child" ? sender.voiceGender : "male";
    const payload: TransmissionReadyPayload = {
      transmissionId: transmission.id,
      channelId: transmission.channelId,
      senderId: sender.id,
      senderName: sender.displayName || sender.phoneE164,
      language: lang,
      speakLang: lang,
      mode: sender.plan === "PLUS" ? "plus" : "free",
      audioUrl: this.storage.publicUrl(audioUrl),
      originalText: "",
      translatedText: "",
      durationMs: transmission.durationMs,
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
    };
    const speak = (lang || "").slice(0, 2).toLowerCase();
    let textOnly = 0;
    const dubbed: { targetId: string; language: string }[] = [];
    for (const target of transmission.targets) {
      const listener = users.find((user) => user.id === target.userId);
      const hear = (listener?.listenLang || listener?.speakLang || "").slice(0, 2).toLowerCase();
      const sameLanguage = Boolean(speak && hear && hear === speak);
      if (!sameLanguage) {
        textOnly += 1;
        if (hear) dubbed.push({ targetId: target.userId, language: hear });
        continue;
      }
      this.realtime.emitToUser(target.userId, SOCKET_EVENTS.TRANSMISSION_READY, payload);
      void this.prisma.transmissionTarget.update({
        where: { id: target.id },
        data: { deliveredAt: new Date() },
      });
    }
    if (dubbed.length) {
      void this.dubWalkie(file, transmission.id, payload, speak, voiceGender, dubbed);
    }
    this.realtime.emitToUser(sender.id, SOCKET_EVENTS.TRANSMISSION_READY, payload);
    this.logger.log(
      `Walkie relay ${transmission.id} bytes=${file.buffer.length} targets=${transmission.targets.length} textOnly=${textOnly}`,
    );
    void Promise.all(
      users.map(async (target) => {
        await this.contacts.ensureIncoming(target, sender);
        await this.contacts.ensureMutualTalk(sender, target);
      }),
    );
    return { id: transmission.id, status: "READY" as const, channelId: channel.id };
  }

  /** Cross-language walkie: Gemini text becomes TTS. The original recording stays with the speaker. */
  private async dubWalkie(
    file: Express.Multer.File,
    transmissionId: string,
    payload: TransmissionReadyPayload,
    speak: string,
    voiceGender: "male" | "female" | "child",
    dubbed: { targetId: string; language: string }[],
  ) {
    try {
      const ext = extFrom(file);
      const heard = await this.stt.hearClip(file.buffer, file.mimetype || "audio/wav", ext, speak);
      const originalText = heard.stt.trim();
      if (!originalText) {
        this.logger.warn(`Walkie dub empty stt ${transmissionId}`);
        return;
      }
      await this.prisma.transmission.update({
        where: { id: transmissionId },
        data: { originalText },
      });
      const languages = [...new Set(dubbed.map((row) => row.language))];
      for (const language of languages) {
        const translated = await this.stt.translateHeard(originalText, language, voiceGender);
        const line = translated.text.replace(/\s+/g, " ").trim();
        if (!line || /^\[unclear\]$/i.test(line)) {
          this.logger.warn(`Walkie dub no translation ${transmissionId} ${speak}->${language}`);
          continue;
        }
        const saved = await this.tts.speak(line, language, null, voiceGender, {
          allowEleven: true,
          preferEleven: true,
          timeoutMs: 12000,
        });
        if (!saved) {
          this.logger.warn(`Walkie dub no tts ${transmissionId} ${speak}->${language}`);
          continue;
        }
        await this.prisma.transmissionRender.upsert({
          where: { transmissionId_language: { transmissionId, language } },
          create: { transmissionId, language, audioUrl: saved, translatedText: line },
          update: { audioUrl: saved, translatedText: line },
        });
        const audioUrl = this.storage.publicUrl(saved);
        for (const row of dubbed.filter((item) => item.language === language)) {
          this.realtime.emitToUser(row.targetId, SOCKET_EVENTS.TRANSMISSION_READY, {
            ...payload,
            language,
            audioUrl,
            originalText,
            translatedText: line,
            usedOriginalVoice: false,
            suppressOriginal: true,
          });
          this.logger.log(`Walkie dub ${transmissionId} ${speak}->${language} user=${row.targetId} tts`);
        }
      }
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
    },
  ) {
    const packed = packReply(input.originalText.trim(), {
      id: input.replyToId,
      name: input.replyToName,
      text: input.replyToText,
    });
    const visible = decodeReply(packed).text.trim();
    if (!visible) throw new BadRequestException("חסרה הודעה");
    const targetIds = await this.resolveTargets(sender, input);
    if (!targetIds.length) throw new BadRequestException("לא נבחרו נמענים");
    const channel = await this.ensureChannel(sender, input.channelId, targetIds);
    const users = await this.prisma.user.findMany({ where: { id: { in: targetIds } } });
    const transmission = await this.prisma.transmission.create({
      data: {
        senderId: sender.id,
        channelId: channel.id,
        originalAudioUrl: "",
        originalText: packed,
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
        text: visible,
        lang: detectLang(visible) || sender.speakLang || sender.listenLang,
      }),
      Date.now(),
      { textOnly: true },
    );
    void Promise.all(
      users.map(async (target) => {
        await this.contacts.ensureIncoming(target, sender);
        await this.contacts.ensureMutualTalk(sender, target);
      }),
    );
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
          replyToId: quoted.reply?.id || null,
          replyToName: quoted.reply?.name || null,
          replyToText: quoted.reply?.text || null,
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
        if (!this.presence.isSocketLive(target.userId)) void this.push.notifyUsers(
          [target.userId],
          title,
          body,
          {
            type: delivery === "text" ? "message" : "walkie",
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
        senderName: tx.sender.displayName,
        senderId: tx.senderId,
        mine: false,
        peerId: tx.senderId,
        peerName: tx.sender.displayName,
        peerAvatar: senderPublic.avatarUrl,
        peerGender: senderPublic.voiceGender,
        originalText: quoted.text || tx.originalText,
        translatedText: (langRender?.translatedText ?? quoted.text) || tx.originalText,
        replyToId: quoted.reply?.id || null,
        replyToName: quoted.reply?.name || null,
        replyToText: quoted.reply?.text || null,
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
        const quoted = decodeReply(tx.originalText);
        const sourceLang =
          detectLang(quoted.text) || user.speakLang || user.listenLang;
        items.push({
          id: `${tx.id}:${target.userId}`,
          senderName: user.displayName,
          senderId: user.id,
          mine: true,
          peerId: target.userId,
          peerName: target.user.displayName,
          peerAvatar: peer.avatarUrl,
          peerGender: peer.voiceGender,
          originalText: quoted.text || tx.originalText,
          translatedText: quoted.text || tx.originalText,
          replyToId: quoted.reply?.id || null,
          replyToName: quoted.reply?.name || null,
          replyToText: quoted.reply?.text || null,
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
      const id = await this.channels.directChannelId(sender, targetIds[0]);
      this.realtime.joinChannel(sender.id, id);
      this.realtime.joinChannel(targetIds[0], id);
      return { id };
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
  const name = file.originalname || "";
  const fromName = name.includes(".") ? name.split(".").pop() : "";
  if (fromName && fromName.length <= 5) return fromName;
  const mime = file.mimetype || "";
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
