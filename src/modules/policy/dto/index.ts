import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { POLICY_CATEGORIES } from '../entities/policy.entity';

export class WorkTimingDto {
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsString() endTime?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsNumber() graceMinutes?: number;
  @IsOptional() @IsNumber() minWorkingHours?: number;
  @IsOptional() @IsNumber() breakMinutes?: number;
  @IsOptional() @IsNumber() lateToHalfDayMinutes?: number;
  @IsOptional() @IsNumber() minHoursForPresent?: number;
  @IsOptional() @IsBoolean() isNightShift?: boolean;
}

export class OfficeDto {
  @IsOptional() @IsString() name?: string;
  @IsNumber() latitude: number;
  @IsNumber() longitude: number;
  @IsOptional() @IsNumber() radiusKm?: number;
}

export class WorkLocationDto {
  @IsOptional() @IsIn(['office', 'home', 'hybrid']) mode?: 'office' | 'home' | 'hybrid';
  @IsOptional() @IsNumber() geoFenceRadiusKm?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OfficeDto)
  offices?: OfficeDto[];
}

export class WfhConfigDto {
  @IsOptional() @IsNumber() maxDaysPerMonth?: number;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedDays?: string[];
}

export class AttachmentDto {
  @IsString() fileId: string;
  @IsString() name: string;
  @IsString() mimeType: string;
  @IsNumber() size: number;
  @IsOptional() @IsString() uploadedAt?: string;
}

export class CreatePolicyDto {
  @IsString() @MaxLength(200)
  policyName: string;

  @IsIn(POLICY_CATEGORIES as unknown as string[])
  category: string;

  @IsOptional() @IsString() @MaxLength(20000)
  description?: string; // rich-text HTML

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @IsOptional() @ValidateNested() @Type(() => WorkTimingDto)
  workTiming?: WorkTimingDto;

  @IsOptional() @ValidateNested() @Type(() => WorkLocationDto)
  workLocation?: WorkLocationDto;

  @IsOptional() @ValidateNested() @Type(() => WfhConfigDto)
  wfhConfig?: WfhConfigDto;

  @IsOptional() @IsIn(['all', 'department', 'designation', 'specific'])
  applicableTo?: 'all' | 'department' | 'designation' | 'specific';

  @IsOptional() @IsArray() @IsString({ each: true })
  applicableIds?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  excludedEmployeeIds?: string[];

  @IsOptional() @IsISO8601() effectiveFrom?: string;
  @IsOptional() @IsISO8601() effectiveTo?: string;
  @IsOptional() @IsBoolean() acknowledgementRequired?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Update is a partial of create; every field optional. */
export class UpdatePolicyDto extends CreatePolicyDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare policyName: string;

  @IsOptional() @IsIn(POLICY_CATEGORIES as unknown as string[])
  declare category: string;
}

export class PolicyQueryDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) isActive?: boolean;
  @IsOptional() @IsBoolean() @Type(() => Boolean) mineOnly?: boolean;
}

export class CreateFromTemplateDto {
  @IsOptional() @IsString() @MaxLength(200)
  policyName?: string;

  @IsOptional() @IsIn(['all', 'department', 'designation', 'specific'])
  applicableTo?: 'all' | 'department' | 'designation' | 'specific';

  @IsOptional() @IsArray() @IsString({ each: true })
  applicableIds?: string[];

  /** Override the template's acknowledgement default (location templates → true). */
  @IsOptional() @IsBoolean()
  acknowledgementRequired?: boolean;
}

export class AcknowledgePolicyDto {
  @IsOptional() @IsNumber() version?: number;
}

// ── onboarding requirements config ──────────────────────────────────────────

const CHECKLIST_CATEGORIES = [
  'documents',
  'welcome',
  'training',
  'it_setup',
  'compliance',
  'other',
];
const ASSIGNED_TO = ['self', 'hr', 'it'];

export class OnboardingConfigDocumentDto {
  @IsString() @MaxLength(64) key: string;
  @IsString() @MaxLength(160) title: string;
  @IsBoolean() required: boolean;
}

export class OnboardingConfigChecklistItemDto {
  // Only `key` is required — the client may send just the selected keys and the
  // server canonicalises standard tasks + defaults custom ones (sanitizeChecklist).
  @IsString() @MaxLength(64) key: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsIn(CHECKLIST_CATEGORIES) category?: string;
  @IsOptional() @IsIn(ASSIGNED_TO) assignedTo?: string;
}

export class UpdateOnboardingConfigDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingConfigDocumentDto)
  documents?: OnboardingConfigDocumentDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingConfigChecklistItemDto)
  checklist?: OnboardingConfigChecklistItemDto[];

  @IsOptional() @IsInt() @Min(0) @Max(24) defaultProbationMonths?: number;

  @IsOptional() @IsInt() @Min(1) @Max(365) targetDays?: number;

  /** Profile field keys a new hire must fill for "profile complete". */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  profileFields?: string[];
}

export class LeaveConfigTypeDto {
  @IsString() @MaxLength(40) key: string;
  @IsOptional() @IsString() @MaxLength(60) label?: string;
  @IsOptional() @IsInt() @Min(0) @Max(366) annualAllocation?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateLeaveConfigDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LeaveConfigTypeDto)
  leaveTypes?: LeaveConfigTypeDto[];
}
