import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { User } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CheckoutDto } from "./dto";
import { InvestmentsService } from "./investments.service";

@Controller("investments")
export class InvestmentsController {
  constructor(private readonly investments: InvestmentsService) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User) {
    return this.investments.summary(user);
  }

  @Post("checkout")
  @UseGuards(JwtAuthGuard)
  checkout(@CurrentUser() user: User, @Body() body: CheckoutDto) {
    return this.investments.checkout(user, body.amountUsd);
  }

  @Post("webhook")
  @HttpCode(200)
  webhook(@Body() body: Record<string, unknown>, @Query() query: Record<string, string>, @Req() req: Request) {
    const raw = {
      ...(typeof req.query === "object" ? (req.query as Record<string, unknown>) : {}),
      ...(query || {}),
      ...(body && typeof body === "object" ? body : {}),
    };
    return this.investments.webhook(raw);
  }

  @Get("webhook")
  @HttpCode(200)
  webhookGet(@Query() query: Record<string, string>) {
    return this.investments.webhook(query || {});
  }

  @Get("done")
  @Header("Cache-Control", "no-store")
  done(@Query("ok") ok: string, @Res() res: Response) {
    const good = ok !== "0" && ok !== "false";
    res.type("html").send(`<!doctype html>
<html lang="he" dir="rtl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TalkHim</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#E8F4FC;color:#111B21;font:18px/1.5 system-ui,sans-serif;padding:24px;text-align:center">
  <div>
    <p style="font-weight:800;font-size:22px;margin:0 0 8px">${good ? "התשלום התקבל" : "התשלום לא הושלם"}</p>
    <p style="margin:0;color:#667781">${good ? "אפשר לחזור לאפליקציה — האחוזים יופיעו בדף ההשקעות." : "אפשר לחזור לאפליקציה ולנסות שוב."}</p>
  </div>
</body>
</html>`);
  }
}
