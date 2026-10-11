import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../prisma/prisma.service";
import { loadUser } from "./load-user";
import { JwtPayload } from "./jwt-payload";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET ?? "talk-dev-jwt-secret-change-in-production",
    });
  }

  async validate(payload: JwtPayload) {
    const user = await loadUser(this.prisma, payload.sub);
    if (!user) throw new UnauthorizedException("session expired");
    if (typeof payload.sv !== "number" || payload.sv !== user.sessionVersion) {
      throw new UnauthorizedException("session replaced");
    }
    // Heal sessions created before sessionActive existed — a valid JWT means signed in.
    if (!user.sessionActive) {
      return this.prisma.user.update({
        where: { id: user.id },
        data: { sessionActive: true },
      });
    }
    return user;
  }
}
