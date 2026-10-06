import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "path";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: true, credentials: true });
  // Log every upload attempt before guards — proves whether phones reach the API.
  app.use((req: { method?: string; url?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }, _res: unknown, next: () => void) => {
    if (req.method === "POST" && (req.url === "/transmissions" || req.url?.startsWith("/transmissions?"))) {
      console.log(`[HIT] POST /transmissions from ${req.socket?.remoteAddress} ct=${String(req.headers?.["content-type"] || "?")}`);
    }
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useStaticAssets(join(process.cwd(), "storage"), { prefix: "/media/" });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
  console.log(`TALK API listening on http://0.0.0.0:${port}`);
}

bootstrap();
