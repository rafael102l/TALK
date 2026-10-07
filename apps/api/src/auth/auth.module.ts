import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { RealtimeModule } from "../realtime/realtime.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [
    PassportModule,
    RealtimeModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "talk-dev-jwt-secret-change-in-production",
      // Stay signed in across app restarts; only logout / new-device transfer clears it.
      signOptions: { expiresIn: "365d" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
