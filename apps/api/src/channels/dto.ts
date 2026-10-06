import { ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from "class-validator";

export class DirectChannelDto {
  @IsString()
  userId!: string;
}

export class GroupChannelDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  userIds!: string[];
}
