import { Transform } from "class-transformer";
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";

export class CreateTransmissionDto {
  @IsOptional()
  @IsString()
  channelId?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [String(parsed)];
      } catch {
        return value
          .replace(/[\[\]"]/g, "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  targetUserIds?: string[];

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  everyone?: boolean;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  durationMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  originalText?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true" || value === "1")
  @IsBoolean()
  viewOnce?: boolean;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  releasedAt?: number;
}

export class CreateTextDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  originalText!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetUserIds?: string[];

  @IsOptional()
  @IsBoolean()
  everyone?: boolean;

  @IsOptional()
  @IsString()
  channelId?: string;
}

export class ReadPeerDto {
  @IsString()
  peerId!: string;
}
