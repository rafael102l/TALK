import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { ChannelsModule } from "./channels/channels.module";
import { ContactsModule } from "./contacts/contacts.module";
import { MetaController } from "./meta.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { PushModule } from "./push/push.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { RedisModule } from "./redis/redis.module";
import { StorageModule } from "./storage/storage.module";
import { FirebaseModule } from "./firebase/firebase.module";
import { TransmissionsModule } from "./transmissions/transmissions.module";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env", "apps/api/.env", "../../.env"] }),
    PrismaModule,
    FirebaseModule,
    RedisModule,
    StorageModule,
    PushModule,
    RealtimeModule,
    AuthModule,
    UsersModule,
    ContactsModule,
    ChannelsModule,
    AiModule,
    TransmissionsModule,
  ],
  controllers: [MetaController],
})
export class AppModule {}
