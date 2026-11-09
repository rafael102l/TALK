import { Module, forwardRef } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { ChannelsModule } from "../channels/channels.module";
import { ContactsModule } from "../contacts/contacts.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { TransmissionsController } from "./transmissions.controller";
import { TransmissionsService } from "./transmissions.service";
import { TtlPurgeService } from "./ttl-purge.service";

@Module({
  imports: [AiModule, ChannelsModule, forwardRef(() => RealtimeModule), ContactsModule],
  controllers: [TransmissionsController],
  providers: [TransmissionsService, TtlPurgeService],
  exports: [TtlPurgeService, TransmissionsService],
})
export class TransmissionsModule {}
