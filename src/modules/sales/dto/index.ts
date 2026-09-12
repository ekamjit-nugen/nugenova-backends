import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { ACTIVITY_TYPES, FOLLOWUP_STATUSES, LEAD_SOURCES, LEAD_STATUSES } from '../sales.constants';

export class CreateLeadDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(120) sourceDetail?: string;
  @IsOptional() @IsString() @MaxLength(24) stageId?: string;
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) score?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(8000) notes?: string;
  @IsOptional() @IsString() @MaxLength(100000) requirement?: string;
}

export class UpdateLeadDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(120) sourceDetail?: string;
  @IsOptional() @IsString() @MaxLength(24) stageId?: string;
  @IsOptional() @IsIn(LEAD_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) score?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(8000) notes?: string;
  @IsOptional() @IsString() @MaxLength(100000) requirement?: string;
}

/** Attach an uploaded file (from /media/upload) to a lead. */
export class CreateLeadDocumentDto {
  @IsString() @MaxLength(24) fileId: string;
  @IsString() @MaxLength(500) fileName: string;
  @IsOptional() @IsString() @MaxLength(200) mimeType?: string;
  @IsOptional() @IsNumber() size?: number;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}

/** Kanban drag: move a lead to another stage. */
export class MoveStageDto {
  @IsString() @MaxLength(24) stageId: string;
}

export class CreateActivityDto {
  @IsIn(ACTIVITY_TYPES as unknown as string[]) type: string;
  @IsOptional() @IsString() @MaxLength(60) typeDetail?: string;
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

// ── requirements (effort estimation) ──
export class CreateRequirementDto {
  @IsString() @MaxLength(300) title: string;
  @IsOptional() @IsString() @MaxLength(8000) details?: string;
  @IsOptional() @IsString() @MaxLength(120) category?: string;
  @IsOptional() @IsString() @MaxLength(120) role?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(60, { each: true }) skills?: string[];
  @IsOptional() @IsIn(['must_have', 'should_have', 'could_have', 'wont_have', 'other']) priority?: string;
  @IsOptional() @IsString() @MaxLength(40) priorityDetail?: string;
  @IsOptional() @IsIn(['open', 'in_progress', 'fulfilled', 'dropped']) status?: string;
  @IsOptional() @IsIn(['hours', 'days', 'fixed', 'other']) unit?: string;
  @IsOptional() @IsString() @MaxLength(40) unitDetail?: string;
  @IsOptional() @IsNumber() quantity?: number;
  @IsOptional() @IsNumber() rate?: number;
  @IsOptional() @IsDateString() neededBy?: string;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string;
}

export class UpdateRequirementDto extends CreateRequirementDto {
  @IsOptional() @IsString() @MaxLength(300) declare title: string;
}

// ── quotes ──
export class QuoteItemDto {
  @IsString() @MaxLength(500) description: string;
  @IsOptional() @IsIn(['hours', 'days', 'fixed', 'unit']) unit?: string;
  @IsNumber() quantity: number;
  @IsNumber() rate: number;
}

export class CreateQuoteDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuoteItemDto) items?: QuoteItemDto[];
  @IsOptional() @IsIn(['percent', 'amount']) discountType?: string;
  @IsOptional() @IsNumber() discountValue?: number;
  @IsOptional() @IsNumber() taxPercent?: number;
  @IsOptional() @IsString() @MaxLength(8000) notes?: string;
  @IsOptional() @IsDateString() validUntil?: string;
}

export class UpdateQuoteDto extends CreateQuoteDto {
  @IsOptional() @IsIn(['draft', 'sent', 'accepted', 'rejected', 'expired']) status?: string;
}

export class CreateStageDto {
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsInt() order?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) probability?: number;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsBoolean() isWon?: boolean;
  @IsOptional() @IsBoolean() isLost?: boolean;
}
