import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SttService } from "./stt.service";
import { TranslateService } from "./translate.service";

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly stt: SttService,
    private readonly translate: TranslateService,
  ) {}

  async process(transmissionId: string) {
    const transmission = await this.prisma.transmission.findUnique({
      where: { id: transmissionId },
      include: { sender: true, targets: { include: { user: true } } },
    });
    if (!transmission) return;

    const speakerLang = transmission.sender.speakLang;
    const targetLangs = [...new Set(transmission.targets.map((t) => t.language))];
    const needTranslate = targetLangs.filter((lang) => lang !== speakerLang);
    const filePath = this.storage.absolutePath(transmission.originalAudioUrl);

    try {
      if (!needTranslate.length) {
        await this.prisma.transmissionRender.upsert({
          where: { transmissionId_language: { transmissionId, language: speakerLang } },
          create: {
            transmissionId,
            language: speakerLang,
            audioUrl: transmission.originalAudioUrl,
            translatedText: transmission.originalText || null,
          },
          update: {
            audioUrl: transmission.originalAudioUrl,
            translatedText: transmission.originalText || undefined,
          },
        });
        await this.prisma.transmission.update({
          where: { id: transmissionId },
          data: { status: "READY" },
        });
        return { usedOriginalOnly: true, originalText: transmission.originalText };
      }

      const t0 = Date.now();
      const cloudText = await this.stt.transcribe(filePath, speakerLang);
      const originalText = cloudText || transmission.originalText || "";
      const sttMs = Date.now() - t0;

      const t1 = Date.now();
      await Promise.all([
        this.prisma.transmission.update({
          where: { id: transmissionId },
          data: { originalText: originalText || undefined, status: "READY" },
        }),
        this.prisma.transmissionRender.upsert({
          where: { transmissionId_language: { transmissionId, language: speakerLang } },
          create: {
            transmissionId,
            language: speakerLang,
            audioUrl: transmission.originalAudioUrl,
            translatedText: originalText || null,
          },
          update: {
            audioUrl: transmission.originalAudioUrl,
            translatedText: originalText || undefined,
          },
        }),
        ...needTranslate.map(async (language) => {
          const translated = originalText
            ? (await this.translate.translate(originalText, speakerLang, language)).text
            : "";
          await this.prisma.transmissionRender.upsert({
            where: { transmissionId_language: { transmissionId, language } },
            create: {
              transmissionId,
              language,
              audioUrl: transmission.originalAudioUrl,
              translatedText: translated || null,
            },
            update: { translatedText: translated || null },
          });
        }),
      ]);
      this.logger.log(
        `Pipeline ${transmissionId} stt=${sttMs}ms tr=${Date.now() - t1}ms total=${Date.now() - t0}ms`,
      );
      return { usedOriginalOnly: false, originalText };
    } catch (error) {
      this.logger.error(`Pipeline failed for ${transmissionId}`, error as Error);
      await this.prisma.transmission.update({
        where: { id: transmissionId },
        data: { status: "FAILED" },
      });
      throw error;
    }
  }
}
