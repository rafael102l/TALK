import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { FloorService } from "./floor.service";
import { PresenceService } from "./presence.service";
import { RealtimeGateway } from "./realtime.gateway";

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "talk-dev-jwt-secret-change-in-production",
    }),
  ],
  providers: [PresenceService, FloorService, RealtimeGateway],
  exports: [PresenceService, FloorService, RealtimeGateway],
})
export class RealtimeModule {}
