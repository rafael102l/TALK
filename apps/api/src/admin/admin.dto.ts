import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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
