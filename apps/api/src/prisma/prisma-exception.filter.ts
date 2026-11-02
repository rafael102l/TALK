import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Request, Response } from "express";
import { pushIncident } from "../admin/error-bus";

@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== "http") return;
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const path = String(request?.originalUrl || request?.url || "");
    const method = String(request?.method || "");

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (status >= 500 || (path.startsWith("/admin") && status === 401)) {
        const message =
          typeof body === "string"
            ? body
            : typeof body === "object" && body && "message" in body
              ? String((body as { message?: unknown }).message || exception.message)
              : exception.message;
        pushIncident({
          kind: status === 401 ? "security" : "server",
          status,
          path,
          method,
          message,
        });
      }
      response.status(status).json(typeof body === "string" ? { message: body } : body);
      return;
    }

    const poolFull =
      exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === "P2024";
    const detail =
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : String(exception ?? "unknown");
    if (poolFull) {
      console.error("[db] connection pool full");
    } else {
      console.error("[api]", exception);
    }
    pushIncident({
      kind: poolFull ? "db" : "server",
      status: 500,
      path,
      method,
      message: poolFull ? "מאגר החיבורים למסד הנתונים מלא" : "שגיאת שרת (500)",
      detail,
    });
    // 503 makes the phone retry and grab another connection. A pool timeout must stay final.
    response.status(500).json({ message: "שגיאת שרת (500)" });
  }
}
