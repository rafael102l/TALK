import { Global, Module } from "@nestjs/common";
import { FirebaseRtdbService } from "./firebase-rtdb.service";

@Global()
@Module({
  providers: [FirebaseRtdbService],
  exports: [FirebaseRtdbService],
})
export class FirebaseModule {}
