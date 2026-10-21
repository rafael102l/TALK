import { Body, Controller, Post, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { memoryStorage } from "multer";
import { extname } from "path";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { TranslateDto, TranslatorDto } from "./translate.dto";
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
  async translatorTurn(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: TranslatorDto,
    @Res() res: Response,
  ) {
    const original = file?.originalname || "";
    const turn = await this.translator.transcribe({
      audio: file?.buffer,
      mime: file?.mimetype || "audio/mp4",
      ext: extname(original).replace(".", "") || "m4a",
      text: body.text?.trim() ?? "",
      langA: body.langA?.trim() || "he",
      langB: body.langB?.trim() || "en",
    });
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.socket?.setNoDelay(true);
    res.write(JSON.stringify({ event: "text", ...turn }) + "\n");
    const flushed = res as Response & { flush?: () => void };
    flushed.flush?.();
    let audio: Buffer | null = null;
    try {
      audio = turn.translatedText
        ? await this.translator.speak(turn.translatedText, turn.targetLang, body.gender || "male")
        : null;
    } catch {
      audio = null;
    }
    res.write(
      JSON.stringify({
        event: "audio",
        mime: "audio/mpeg",
        audioBase64: audio ? audio.toString("base64") : "",
      }) + "\n",
    );
    res.end();
  }
}
