import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class AdminLoginDto {
  @IsString()
  @MinLength(1)
  token!: string;
}

export class CreateFeedbackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}

export class CreateReportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  targetId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  targetName?: string;

  @IsOptional()
  @IsIn(["user", "group"])
  targetKind?: "user" | "group";

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class BanPhoneDto {
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  phone!: string;
}

export class TtlPurgeRunDto {
  /** Default true. Actual delete requires MEDIA_TTL_PURGE_ENABLED and dryRun=false. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
