import { Logger, Module, OnModuleInit } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";

@Module({
  imports: [RealtimeModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule implements OnModuleInit {
  private readonly log = new Logger(AdminModule.name);

  onModuleInit() {
    this.log.log("loaded — GET /admin  POST /admin/session  POST /admin/logout  GET /admin/api/snapshot");
  }
}
