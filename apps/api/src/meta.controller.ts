import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { User } from "@prisma/client";
import { LANGUAGES } from "@talk/shared";
import type { Response } from "express";
import { existsSync } from "fs";
import { join } from "path";
import { CurrentUser } from "./auth/current-user.decorator";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { PresenceService } from "./realtime/presence.service";

@Controller()
export class MetaController {
  constructor(private readonly presence: PresenceService) {}

  @Get("health")
  health() {
    return { ok: true, name: "talk-api" };
  }

  @Get("install")
  installPage(@Res() res: Response) {
    res.type("html").send(`<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>התקנת TALK</title>
  <style>
    body { font-family: sans-serif; padding: 24px; background: #111; color: #eee; }
    a { display: block; background: #F5C518; color: #111; text-align: center; padding: 16px; border-radius: 12px; font-weight: 800; text-decoration: none; margin-top: 16px; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <h1>התקנת TALK</h1>
  <p>הגרסה במכשיר לא מצליחה להתחבר לשרת. התקינו את העדכון ואז פתחו את האפליקציה.</p>
  <a href="/talk.apk">הורידו את TALK</a>
  <p>אחרי ההתקנה הזינו מספר פלאפון, ואז את הקוד 000000.</p>
</body>
</html>`);
  }

  @Get("talk.apk")
  downloadApk(@Res() res: Response) {
    if (process.env.NODE_ENV === "production") {
      res.status(404).json({ message: "Not found" });
      return;
    }
    const file = [
      join(__dirname, "..", "..", "mobile", "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
      join(process.cwd(), "..", "mobile", "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
    ].find((path) => existsSync(path));
    if (!file) {
      res.status(404).json({ message: "APK not found" });
      return;
    }
    res.download(file, "TALK.apk");
  }

  @Get("meta")
  meta() {
    return {
      languages: LANGUAGES,
      contactHashSalt: process.env.CONTACT_HASH_SALT ?? "talk-contact-salt-dev",
      maxPttSeconds: 30,
    };
  }

  @Get("presence")
  @UseGuards(JwtAuthGuard)
  async presenceCheck(@CurrentUser() _user: User, @Query("userIds") userIds?: string) {
    const ids = (userIds ?? "").split(",").filter(Boolean);
    const online = await this.presence.onlineUserIds(ids);
    return { online: [...online] };
  }
}
