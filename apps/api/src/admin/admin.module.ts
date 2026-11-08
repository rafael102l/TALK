import { Logger, Module, OnModuleInit } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { RealtimeModule } from "../realtime/realtime.module";
import { TransmissionsModule } from "../transmissions/transmissions.module";
import { AdminController } from "./admin.controller";
import { AdminGuard, TtlPurgeGuard } from "./admin.guard";
import { AdminService } from "./admin.service";
import { AppealController } from "./appeal.controller";
import { FeedbackInboxController } from "./feedback-inbox.controller";
import { ReportInboxController } from "./report-inbox.controller";

@Module({
  imports: [
    RealtimeModule,
    TransmissionsModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "talk-dev-jwt-secret-change-in-production",
    }),
  ],
  controllers: [AdminController, FeedbackInboxController, ReportInboxController, AppealController],
  providers: [AdminService, AdminGuard, TtlPurgeGuard],
})
export class AdminModule implements OnModuleInit {
  private readonly log = new Logger(AdminModule.name);

  constructor(private readonly admin: AdminService) {}

  async onModuleInit() {
    this.log.log("loaded — GET /admin  POST /feedback  POST /appeals  POST /reports");
    await this.admin.ensureSchema();
  }
}
