import { IsString, MinLength } from "class-validator";

export class AdminLoginDto {
  @IsString()
  @MinLength(1)
  token!: string;
}
