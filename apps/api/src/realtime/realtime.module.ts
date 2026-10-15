import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AiModule } from "../ai/ai.module";
import { FloorService } from "./floor.service";
import { LiveDubService } from "./live-dub.service";
import { PresenceService } from "./presence.service";
import { RealtimeGateway } from "./realtime.gateway";

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "talk-dev-jwt-secret-change-in-production",
    }),
    AiModule,
  ],
  providers: [PresenceService, FloorService, LiveDubService, RealtimeGateway],
  exports: [PresenceService, FloorService, RealtimeGateway],
})
export class RealtimeModule {}
