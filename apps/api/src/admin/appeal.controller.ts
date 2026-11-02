import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { PrismaService } from "../prisma/prisma.service";
import { AdminService } from "./admin.service";

type AppealPayload = { typ?: string; sub?: string; phone?: string };

@Controller("appeals")
export class AppealController {
  constructor(
    private readonly admin: AdminService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024, files: 12 },
    }),
  )
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { text?: string; appealToken?: string },
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const raw =
      (typeof body?.appealToken === "string" && body.appealToken.trim()) ||
      (authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "");
    if (!raw) throw new UnauthorizedException("appeal token required");

    let payload: AppealPayload;
    try {
      payload = await this.jwt.verifyAsync<AppealPayload>(raw);
    } catch {
      throw new UnauthorizedException("appeal token invalid");
    }
    if (payload.typ !== "ban_appeal" || !payload.sub) {
      throw new UnauthorizedException("appeal token invalid");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, displayName: true, phoneE164: true, bannedAt: true },
    });
    if (!user) throw new UnauthorizedException("user missing");
    if (!user.bannedAt) {
      return { ok: true, unbanned: true, message: "החשבון כבר שוחרר מחסימה" };
    }

    const text = typeof body?.text === "string" ? body.text : "";
    const images = (files || []).filter(
      (file) => file.fieldname === "images" || file.fieldname === "image" || file.mimetype?.startsWith("image/"),
    );
    const saved = await this.admin.saveFeedback(user, text, images, "appeal");
    return { ok: true, id: saved.id, images: saved.images };
  }
}
