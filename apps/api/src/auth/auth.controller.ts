import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { User } from "@prisma/client";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./current-user.decorator";
import { ConfirmDeviceTransferDto, RequestOtpDto, VerifyOtpDto } from "./dto";
import { JwtAuthGuard } from "./jwt-auth.guard";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("otp/request")
  requestOtp(@Body() body: RequestOtpDto) {
    return this.auth.requestOtp(body.phone);
  }

  @Post("otp/verify")
  verifyOtp(@Body() body: VerifyOtpDto) {
    return this.auth.verifyOtp(body.phone, body.code);
  }

  @Post("device-transfer/confirm")
  confirmDeviceTransfer(@Body() body: ConfirmDeviceTransferDto) {
    return this.auth.confirmDeviceTransfer({
      challengeToken: body.challengeToken,
      email: body.email,
      smsCode: body.smsCode,
      emailCode: body.emailCode,
      confirmOwnership: body.confirmOwnership,
    });
  }

  @Post("logout")
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() user: User) {
    return this.auth.logout(user);
  }
}
