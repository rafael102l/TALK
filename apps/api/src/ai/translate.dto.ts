import { IsIn, IsOptional, IsString } from "class-validator";
import { LANGUAGES } from "@talk/shared";

const codes = LANGUAGES.map((l) => l.code);

export class TranslateDto {
  @IsString()
  text!: string;

  @IsOptional()
  @IsIn(codes)
  source?: string;

  @IsOptional()
  @IsIn(codes)
  target?: string;
}
