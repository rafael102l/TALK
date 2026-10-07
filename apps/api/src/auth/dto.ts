import { IsBoolean, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class RequestOtpDto {
  @IsString()
  @MinLength(8)
  phone!: string;
}

export class VerifyOtpDto {
  @IsString()
  @MinLength(8)
  phone!: string;

  @IsString()
  @Matches(/^\d{4,8}$/)
  code!: string;
}

export class ConfirmDeviceTransferDto {
  @IsString()
  @MinLength(20)
  challengeToken!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @Matches(/^\d{4,8}$/)
  smsCode!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4,8}$/)
  emailCode?: string;

  /** Explicit confirmation that this is the account owner. */
  @IsBoolean()
  confirmOwnership!: boolean;
}
