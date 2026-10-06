import { IsString, Matches, MinLength } from "class-validator";

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
  @Matches(/^\d{6}$/)
  code!: string;
}
