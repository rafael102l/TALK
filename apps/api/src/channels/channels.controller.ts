import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { User } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ChannelsService } from "./channels.service";
import { DirectChannelDto, GroupChannelDto } from "./dto";

@Controller("channels")
@UseGuards(JwtAuthGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.channels.list(user);
  }

  @Post("direct")
  direct(@CurrentUser() user: User, @Body() body: DirectChannelDto) {
    return this.channels.getOrCreateDirect(user, body.userId);
  }

  @Post("group")
  group(@CurrentUser() user: User, @Body() body: GroupChannelDto) {
    return this.channels.createGroup(user, body.name ?? "", body.userIds);
  }
}
