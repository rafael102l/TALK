import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Response } from "express";

@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== "http") return;
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(typeof body === "string" ? { message: body } : body);
      return;
    }
    const poolFull =
      exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === "P2024";
    if (poolFull) {
      console.error("[db] connection pool full");
    } else {
      console.error("[api]", exception);
    }
    // The phone treats this wording as final and does not retry the request.
    response.status(poolFull ? 503 : 500).json({
      message: poolFull ? "שגיאת שרת (503)" : "שגיאת שרת (500)",
    });
  }
}
