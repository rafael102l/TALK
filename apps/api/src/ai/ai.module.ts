import { Module } from "@nestjs/common";
import { AiController } from "./ai.controller";
import { PipelineService } from "./pipeline.service";
import { SttService } from "./stt.service";
import { TranslateService } from "./translate.service";
import { TranslatorService } from "./translator.service";
import { TtsService } from "./tts.service";
import { VoiceCloneService } from "./voice-clone.service";

@Module({
  controllers: [AiController],
  providers: [SttService, TranslateService, TranslatorService, TtsService, VoiceCloneService, PipelineService],
  exports: [SttService, TranslateService, TranslatorService, TtsService, VoiceCloneService, PipelineService],
})
export class AiModule {}
