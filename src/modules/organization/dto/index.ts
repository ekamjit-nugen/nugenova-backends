import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trimLowerEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateOrganizationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @Transform(trimLowerEmail)
  @IsEmail({}, { message: 'ownerEmail must be a valid email address' })
  @MaxLength(254)
  ownerEmail: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  ownerFirstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  ownerLastName?: string;
}

export class CreateDepartmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  headUserId?: string;

  @IsOptional()
  @IsString()
  parentDepartmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  costCenter?: string;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  headUserId?: string;

  @IsOptional()
  @IsString()
  parentDepartmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  costCenter?: string;
}

class PermissionDto {
  @IsString()
  resource: string;

  @IsArray()
  @IsString({ each: true })
  actions: string[];
}

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionDto)
  permissions?: PermissionDto[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionDto)
  permissions?: PermissionDto[];
}

export class AddMemberDto {
  @Transform(trimLowerEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  role?: string; // enforced tier: employee | manager | admin | owner

  @IsOptional()
  @IsString()
  roleId?: string; // optional custom role

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;
}
