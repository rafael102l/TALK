import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { LANGUAGES } from "@talk/shared";

const codes = LANGUAGES.map((l) => l.code);

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  displayName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(codes)
  speakLang?: string;

  @IsOptional()
  @IsIn(codes)
  listenLang?: string;

  @IsOptional()
  @IsIn(["male", "female", "child"])
  voiceGender?: "male" | "female" | "child";

  @IsOptional()
  @IsIn(["FREE", "PLUS"])
  plan?: "FREE" | "PLUS";
}

export class PushTokenDto {
  @IsString()
  @MinLength(8)
  token!: string;
}
