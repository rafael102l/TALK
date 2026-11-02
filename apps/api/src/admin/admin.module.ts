import { Logger, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";
import { FeedbackInboxController } from "./feedback-inbox.controller";
import { ReportInboxController } from "./report-inbox.controller";

@Module({
  imports: [RealtimeModule],
  controllers: [AdminController, FeedbackInboxController, ReportInboxController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule implements OnModuleInit {
  private readonly log = new Logger(AdminModule.name);

  onModuleInit() {
    this.log.log("loaded — GET /admin  POST /feedback  POST /reports  GET /admin/api/snapshot");
  }
}
