import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { User } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateTextDto, CreateTransmissionDto, ReadPeerDto } from "./dto";
import { TransmissionsService } from "./transmissions.service";

@Controller("transmissions")
@UseGuards(JwtAuthGuard)
export class TransmissionsController {
  private readonly logger = new Logger(TransmissionsController.name);

  constructor(private readonly transmissions: TransmissionsService) {}

  @Get("unread")
  unread(@CurrentUser() user: User) {
    return this.transmissions.unread(user);
  }

  @Get("waiting")
  waiting(@CurrentUser() user: User) {
    return this.transmissions.waiting(user);
  }

  @Get()
  history(@CurrentUser() user: User) {
    return this.transmissions.history(user);
  }

  @Post("read")
  readPeer(@CurrentUser() user: User, @Body() body: ReadPeerDto) {
    return this.transmissions.markPeerTextRead(user, body.peerId);
  }

  @Post("text")
  createText(@CurrentUser() user: User, @Body() body: CreateTextDto) {
    return this.transmissions.createText(user, body);
  }

  @Post()
  @UseInterceptors(FileInterceptor("audio"))
  create(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CreateTransmissionDto,
  ) {
    this.logger.log(
      `POST /transmissions from=${user.displayName || user.id} bytes=${file?.buffer?.length ?? 0} targets=${body.targetUserIds?.length ?? 0} kind=${body.kind || "walkie"}`,
    );
    return this.transmissions.create(user, file, body);
  }

  @Post(":id/once-close")
  closeOnce(@CurrentUser() user: User, @Param("id") id: string) {
    return this.transmissions.closeViewOnce(user, id);
  }

  @Post(":id/played")
  played(@CurrentUser() user: User, @Param("id") id: string) {
    return this.transmissions.markPlayed(user, id);
  }
}
