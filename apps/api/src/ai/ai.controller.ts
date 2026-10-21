import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { extname } from "path";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { TranslateDto, TranslatorDto, TranslatorSpeakDto } from "./translate.dto";
import { TranslateService } from "./translate.service";
import { TranslatorService } from "./translator.service";

@Controller("ai")
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly translate: TranslateService,
    private readonly translator: TranslatorService,
  ) {}

  @Post("translate")
  async translateText(@Body() body: TranslateDto) {
    const text = body.text?.trim() ?? "";
    const source = body.source?.trim() || "he";
    const target = body.target?.trim() || "en";
    if (!text) return { text: "" };
    const result = await this.translate.translate(text, source, target);
    return { text: result.text };
  }

  @Post("translator")
  @UseInterceptors(
    FileInterceptor("audio", { storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }),
  )
  async translatorTurn(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: TranslatorDto) {
    const original = file?.originalname || "";
    return this.translator.runTurn({
      audio: file?.buffer ? Buffer.from(file.buffer) : undefined,
      mime: file?.mimetype || "audio/mp4",
      ext: extname(original).replace(".", "") || "m4a",
      langA: body.langA?.trim() || "he",
      langB: body.langB?.trim() || "en",
      gender: body.gender || "male",
    });
  }

  @Post("translator/speak")
  async translatorSpeak(@Body() body: TranslatorSpeakDto) {
    return this.translator.speakTurn(body.text || "", body.lang, body.gender || "male");
  }
}
