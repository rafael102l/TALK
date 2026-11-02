import {
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { User } from "@prisma/client";
import { memoryStorage } from "multer";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AdminService } from "./admin.service";

@Controller("feedback")
@UseGuards(JwtAuthGuard)
export class FeedbackInboxController {
  constructor(private readonly admin: AdminService) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024, files: 12 },
    }),
  )
  create(
    @CurrentUser() user: User,
    @Body() body: { text?: string },
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const text = typeof body?.text === "string" ? body.text : "";
    const images = (files || []).filter((file) => file.fieldname === "images" || file.fieldname === "image" || file.mimetype?.startsWith("image/"));
    return this.admin.saveFeedback(user, text, images, "feedback");
  }
}
