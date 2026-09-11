import {
  IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { ACTIVITY_TYPES, FOLLOWUP_STATUSES, LEAD_SOURCES, LEAD_STATUSES } from '../sales.constants';

export class CreateLeadDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(24) stageId?: string;
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(8000) notes?: string;
}

export class UpdateLeadDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(24) stageId?: string;
  @IsOptional() @IsIn(LEAD_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) score?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(8000) notes?: string;
}

/** Kanban drag: move a lead to another stage. */
export class MoveStageDto {
  @IsString() @MaxLength(24) stageId: string;
}

export class CreateActivityDto {
  @IsIn(ACTIVITY_TYPES as unknown as string[]) type: string;
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
  @IsOptional() @IsDateString() occurredAt?: string;
}

export class CreateFollowupDto {
  @IsDateString() dueAt: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string;
}

export class UpdateFollowupDto {
  @IsOptional() @IsIn(FOLLOWUP_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class CreateAccountDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(200) domain?: string;
  @IsOptional() @IsString() @MaxLength(120) industry?: string;
  @IsOptional() @IsString() @MaxLength(40) size?: string;
  @IsOptional() @IsString() @MaxLength(300) website?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
}

export class UpdateAccountDto extends CreateAccountDto {
  @IsOptional() @IsString() @MaxLength(200) declare name: string;
}

export class CreateContactDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(24) accountId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
}

export class UpdateContactDto extends CreateContactDto {
  @IsOptional() @IsString() @MaxLength(200) declare name: string;
}

export class CreateStageDto {
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsInt() order?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) probability?: number;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsBoolean() isWon?: boolean;
  @IsOptional() @IsBoolean() isLost?: boolean;
}
