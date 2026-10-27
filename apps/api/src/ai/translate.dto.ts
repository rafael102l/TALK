import { IsIn, IsOptional, IsString } from "class-validator";

export class TranslateDto {
  @IsString()
  text!: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  target?: string;
}

export class TranslatorDto {
  @IsOptional()
  @IsString()
  text?: string;

  @IsString()
  langA!: string;

  @IsString()
  langB!: string;

  @IsOptional()
  @IsIn(["male", "female", "child"])
  gender?: "male" | "female" | "child";

  @IsOptional()
  @IsString()
  speak?: string;
}

export class TranslatorSpeakDto {
  @IsString()
  text!: string;

  @IsString()
  lang!: string;

  @IsOptional()
  @IsIn(["male", "female", "child"])
  gender?: "male" | "female" | "child";
}
