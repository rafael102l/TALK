import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import type { Request } from "express";

export const ADMIN_COOKIE = "talk_admin";

export function adminTokenConfigured() {
  return (process.env.ADMIN_DASHBOARD_TOKEN || "").trim().replace(/^["']|["']$/g, "").trim();
}

export function readAdminToken(req: Request) {
  const header = req.headers["x-admin-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return cookieValue(req.headers.cookie, ADMIN_COOKIE);
}

export function adminTokensMatch(given: string, expected: string) {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const n = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(n);
  const pb = Buffer.alloc(n);
  a.copy(pa);
  b.copy(pb);
  return a.length === b.length && timingSafeEqual(pa, pb);
}

function cookieValue(header: string | undefined, name: string) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return "";
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const expected = adminTokenConfigured();
    if (!expected) {
      throw new ServiceUnavailableException("ADMIN_DASHBOARD_TOKEN is not set");
    }
    const req = context.switchToHttp().getRequest<Request>();
    const given = readAdminToken(req);
    if (!adminTokensMatch(given, expected)) {
      throw new UnauthorizedException("Admin token required");
    }
    return true;
  }
}
