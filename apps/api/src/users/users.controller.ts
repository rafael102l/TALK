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
import { PushTokenDto, UpdateProfileDto } from "./dto";
import { UsersService } from "./users.service";

@Controller("users")
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

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
