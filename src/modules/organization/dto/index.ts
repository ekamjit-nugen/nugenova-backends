import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
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

  /**
   * Optional, legacy: which library T&C to record on the org. Terms are now
   * platform-wide — every org gates on the single ACTIVE T&C — so provisioning
   * no longer needs this; when omitted, the active T&C is used.
   */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  termsId?: string;
}

/** Create or edit an HTML T&C document in the library. */
/** Owner setup wizard — update org name + workspace settings (merged). */
export class UpdateOrgProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  /** Free-form workspace config merged into org.settings (industry, size, etc.). */
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

/** Owner setup wizard — advance the step / mark complete. */
export class UpdateOnboardingDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  step?: number;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

export class UpsertHtmlTermsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @IsString()
  @MinLength(10)
  @MaxLength(100000)
  text: string;
}

/** Create or replace a PDF T&C document (multipart; file carries the PDF). */
export class UpsertPdfTermsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;
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

  // Department this role is scoped to. Send an empty string to clear it back to
  // org-wide (all departments). Absent = leave unchanged.
  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionDto)
  permissions?: PermissionDto[];
}

export class UpdateMemberDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  role?: string;

  @IsOptional()
  @IsString()
  roleId?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;
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

/**
 * Super-admin: platform-wide defaults applied to new orgs + used as the fallback
 * for any org without an explicit override. All fields optional (partial update).
 */
export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  defaultOrgStorageGb?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  defaultUserQuotaGb?: number;

  // Seat cap for a new org (owner + members). null = unlimited.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  defaultMaxMembers?: number | null;
}

/**
 * Super-admin: per-org limit overrides. Storage writes `drive_quotas`; the seat
 * cap writes `organizations.limits`. Any field omitted = leave unchanged; send
 * `maxMembers: null` to clear the override back to the platform default…
 * unlimited only if the platform default is unlimited.
 */
export class UpdateOrgLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  teamQuotaGb?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  defaultUserQuotaGb?: number;

  // null clears the per-org override (inherit platform default).
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxMembers?: number | null;
}
