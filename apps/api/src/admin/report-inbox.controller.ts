import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { User } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateReportDto } from "./admin.dto";
import { AdminService } from "./admin.service";

@Controller("reports")
@UseGuards(JwtAuthGuard)
export class ReportInboxController {
  constructor(private readonly admin: AdminService) {}

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: User, @Body() body: CreateReportDto) {
    return this.admin.saveReport(user, body);
  }
}
