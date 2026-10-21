import { Body, Controller, Post, UseGuards } from "@nestjs/common";
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
  async translatorTurn(@Body() body: TranslatorDto) {
    return this.translator.run(
      body.text?.trim() ?? "",
      body.langA?.trim() || "he",
      body.langB?.trim() || "en",
      body.gender || "male",
    );
  }
}

