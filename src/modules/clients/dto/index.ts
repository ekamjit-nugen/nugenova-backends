import { Type } from 'class-transformer';
import {
  IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';

export class PrimaryContactDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;
}

export class CreateClientDto {
  @IsString() @MaxLength(200)
  companyName: string;

  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  industry?: string;

  @IsOptional() @IsString() @MaxLength(300)
  website?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(4000)
  notes?: string;

  @IsOptional() @ValidateNested() @Type(() => PrimaryContactDto)
  primaryContact?: PrimaryContactDto;
}

export class UpdateClientDto {
  @IsOptional() @IsString() @MaxLength(200)
  companyName?: string;

  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  industry?: string;

  @IsOptional() @IsString() @MaxLength(300)
  website?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(4000)
  notes?: string;

  @IsOptional() @ValidateNested() @Type(() => PrimaryContactDto)
  primaryContact?: PrimaryContactDto;
}

export class CreateContactDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;
}

export class UpdateContactDto {
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;
}

/** Promote a contact to a portal login. Name falls back to the contact's name. */
export class InviteContactDto {
  @IsOptional() @IsString() @MaxLength(120)
  firstName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  lastName?: string;
}

export class AssignEmployeeDto {
  @IsString() @MaxLength(24)
  userId: string;

  @IsOptional() @IsString() @MaxLength(120)
  assignmentRole?: string;
}

export class ShareBoardDto {
  @IsString() @MaxLength(24)
  boardId: string;

  @IsOptional() @IsIn(['view', 'comment'])
  permission?: 'view' | 'comment';
}
