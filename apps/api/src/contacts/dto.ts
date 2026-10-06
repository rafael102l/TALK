import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length, ValidateNested } from "class-validator";

export class ContactSyncItemDto {
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}

export class SyncContactsDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ContactSyncItemDto)
  contacts!: ContactSyncItemDto[];
}

export class InviteDto {
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;
}

export class LookupDto {
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;
}

export class AddContactDto {
  @IsString()
  phone!: string;
}

export class ContactUserDto {
  @IsString()
  userId!: string;
}
