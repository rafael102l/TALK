import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { User } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PushService } from "../push/push.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { CallEndDto, CallPushDto, PushTokenDto, UpdateProfileDto } from "./dto";
import { UsersService } from "./users.service";

@Controller("users")
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly push: PushService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get("me")
  me(@CurrentUser() user: User) {
    return this.users.me(user);
  }

  @Patch("me")
  update(@CurrentUser() user: User, @Body() body: UpdateProfileDto) {
    return this.users.update(user, body);
  }

  @Post("me/push-token")
  pushToken(@CurrentUser() user: User, @Body() body: PushTokenDto) {
    return this.users.savePushToken(user, body.token);
  }

  /** FCM device token (Android) and PushKit VoIP token (iOS). */
  @Post("me/call-push")
  callPush(@CurrentUser() user: User, @Body() body: CallPushDto) {
    console.log(`[HIT] call-push user=${user.id} fcm=${Boolean(body.fcmToken)} voip=${Boolean(body.voipToken)}`);
    return this.push.saveCallDevice(user.id, body);
  }

  @Post("me/call-end")
  callEnd(@CurrentUser() user: User, @Body() body: CallEndDto) {
    return this.realtime.hangupFromHttp(user.id, body.callId, body.reason || "cancelled");
  }

  @Post("me/voice-sample")
  @UseInterceptors(FileInterceptor("audio"))
  voiceSample(@CurrentUser() user: User, @UploadedFile() file: Express.Multer.File) {
    return this.users.cloneVoice(user, file);
  }

  @Post("me/avatar")
  @UseInterceptors(FileInterceptor("photo"))
  avatar(@CurrentUser() user: User, @UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException("לא נבחרה תמונה");
    return this.users.saveAvatar(user, file);
  }

  @Delete("me")
  remove(@CurrentUser() user: User) {
    return this.users.remove(user);
  }
}
