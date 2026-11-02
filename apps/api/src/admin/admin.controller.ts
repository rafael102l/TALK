import { Body, Controller, Get, Header, HttpCode, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ADMIN_DASHBOARD_HTML } from "./admin.page";
import { AdminLoginDto, BanPhoneDto } from "./admin.dto";
import { ADMIN_COOKIE, AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";

@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @Header("X-Robots-Tag", "noindex, nofollow")
  @Header("Cache-Control", "no-store")
  page(@Res() res: Response) {
    res.type("html").send(ADMIN_DASHBOARD_HTML);
  }

  @Post("session")
  @HttpCode(200)
  login(@Body() body: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    this.admin.assertToken(body.token);
    res.cookie(ADMIN_COOKIE, body.token.trim(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/admin",
      maxAge: 12 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
    });
    return { ok: true };
  }

  @Post("logout")
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ADMIN_COOKIE, { path: "/admin" });
    return { ok: true };
  }

  @Get("api/snapshot")
  @UseGuards(AdminGuard)
  @Header("Cache-Control", "no-store")
  snapshot() {
    return this.admin.snapshot();
  }

  @Get("api/people/:userId/events")
  @UseGuards(AdminGuard)
  @Header("Cache-Control", "no-store")
  userEvents(@Param("userId") userId: string) {
    return this.admin.eventsForUser(userId);
  }

  @Post("api/people/:userId/ban")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  ban(@Param("userId") userId: string) {
    return this.admin.setBanned(userId, true);
  }

  @Post("api/people/:userId/unban")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  unban(@Param("userId") userId: string) {
    return this.admin.setBanned(userId, false);
  }

  @Post("api/people/ban-phone")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  banPhone(@Body() body: BanPhoneDto) {
    return this.admin.setBannedByPhone(body.phone, true);
  }

  @Post("api/people/unban-phone")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  unbanPhone(@Body() body: BanPhoneDto) {
    return this.admin.setBannedByPhone(body.phone, false);
  }

  @Post("api/incidents/clear")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  clearIncidents() {
    return this.admin.clearErrorLog();
  }
}
