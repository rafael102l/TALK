import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { ContactsModule } from "../contacts/contacts.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [AiModule, RealtimeModule, ContactsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
