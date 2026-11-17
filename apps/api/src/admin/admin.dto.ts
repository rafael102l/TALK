import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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

export class WatchBotDto {
  @IsBoolean()
  enabled!: boolean;
}

export class AddCostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @Type(() => Number)
  @IsNumber()
  amount!: number;

  @IsOptional()
  @IsIn(["ILS", "USD"])
  currency?: "ILS" | "USD";

  @IsOptional()
  @IsString()
  @MaxLength(32)
  at?: string;

  @IsOptional()
  @IsIn(["PAID", "DUE"])
  status?: "PAID" | "DUE";

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class TtlPurgeRunDto {
  /** Omit to follow MEDIA_TTL_PURGE_DRY_RUN. false = live delete when ENABLED. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
