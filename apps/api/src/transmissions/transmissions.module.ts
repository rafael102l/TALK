import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { ChannelsModule } from "../channels/channels.module";
import { ContactsModule } from "../contacts/contacts.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { TransmissionsController } from "./transmissions.controller";
import { TransmissionsService } from "./transmissions.service";

@Module({
  imports: [AiModule, ChannelsModule, RealtimeModule, ContactsModule],
  controllers: [TransmissionsController],
  providers: [TransmissionsService],
})
export class TransmissionsModule {}
