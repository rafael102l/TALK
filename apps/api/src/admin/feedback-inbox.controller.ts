import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { User } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateFeedbackDto } from "./admin.dto";
import { AdminService } from "./admin.service";

@Controller("feedback")
@UseGuards(JwtAuthGuard)
export class FeedbackInboxController {
  constructor(private readonly admin: AdminService) {}

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: User, @Body() body: CreateFeedbackDto) {
    return this.admin.saveFeedback(user, body.text);
  }
}
