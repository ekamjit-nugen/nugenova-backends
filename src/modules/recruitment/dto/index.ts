import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUrl,
  Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import {
  CANDIDATE_SOURCES, CANDIDATE_STATUSES, DOCUMENT_KINDS, EMPLOYMENT_TYPES, INTERVIEW_STATUSES, INTERVIEW_TYPES,
  MANUAL_ACTIVITY_TYPES, NOTICE_STATUSES, OFFER_STATUSES, OPENING_STATUSES, PRIORITIES, RECOMMENDATIONS, STAGE_KINDS,
  WORK_MODES,
} from '../recruitment.constants';
import { BILL_UNITS, SUBMISSION_STATUSES } from '../submission-rules';

const list = (arr: readonly string[]) => arr as unknown as string[];

// ── candidates ─────────────────────────────────────────────────────────────────

export class EducationDto {
  @IsOptional() @IsString() @MaxLength(200) degree?: string | null;
  @IsOptional() @IsString() @MaxLength(200) institution?: string | null;
  @IsOptional() @IsString() @MaxLength(40) year?: string | null;
  @IsOptional() @IsString() @MaxLength(40) score?: string | null;
}

export class WorkDto {
  @IsOptional() @IsString() @MaxLength(200) company?: string | null;
  @IsOptional() @IsString() @MaxLength(200) designation?: string | null;
  @IsOptional() @IsString() @MaxLength(40) from?: string | null;
  @IsOptional() @IsString() @MaxLength(40) to?: string | null;
  @IsOptional() @IsBoolean() current?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) summary?: string | null;
}

/** Every editable profile field (all optional — shared by create/update/import). */
export class CandidateFieldsDto {
  @IsOptional() @IsString() @MaxLength(200) fullName?: string;
  @IsOptional() @IsString() @MaxLength(254) email?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(40) altPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(120) currentLocation?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(80, { each: true }) preferredLocations?: string[];
  @IsOptional() @IsBoolean() willingToRelocate?: boolean | null;
  @IsOptional() @IsInt() @Min(0) @Max(720) totalExpMonths?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(720) relevantExpMonths?: number | null;
  @IsOptional() @IsString() @MaxLength(200) currentCompany?: string | null;
  @IsOptional() @IsString() @MaxLength(200) currentDesignation?: string | null;
  @IsOptional() @IsNumber() @Min(0) currentCtc?: number | null;
  @IsOptional() @IsNumber() @Min(0) expectedCtc?: number | null;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsInt() @Min(0) @Max(365) noticePeriodDays?: number | null;
  @IsOptional() @IsIn(list(NOTICE_STATUSES)) noticeStatus?: string;
  @IsOptional() @IsDateString() lastWorkingDay?: string | null;
  @IsOptional() @IsString() @MaxLength(200) highestQualification?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => EducationDto) education?: EducationDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => WorkDto) workHistory?: WorkDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(60, { each: true }) skills?: string[];
  @IsOptional() @IsString() @MaxLength(500) linkedinUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(500) githubUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(500) portfolioUrl?: string | null;
  @IsOptional() @IsIn(list(CANDIDATE_SOURCES)) source?: string;
  @IsOptional() @IsString() @MaxLength(200) sourceDetail?: string | null;
  @IsOptional() @IsString() @MaxLength(24) referredBy?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) externalResumeUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsInt() @Min(0) @Max(5) rating?: number | null;
  @IsOptional() @IsString() @MaxLength(2000) aiSummary?: string | null;
  @IsOptional() @IsString() @MaxLength(24) ownerId?: string | null;
  @IsOptional() @IsIn(list(CANDIDATE_STATUSES)) status?: string;
  @IsOptional() @IsBoolean() consent?: boolean;
}

export class CreateCandidateDto extends CandidateFieldsDto {
  @IsString() @MaxLength(200) declare fullName: string;
  /** Apply straight to an opening. */
  @IsOptional() @IsString() @MaxLength(24) openingId?: string;
  @IsOptional() @IsString() @MaxLength(24) stageId?: string;
  /** Attach an uploaded CV (from /media/upload). */
  @IsOptional() @IsString() @MaxLength(24) resumeFileId?: string;
  /** Create even when a possible duplicate exists (name match only — email/phone stay unique). */
  @IsOptional() @IsBoolean() force?: boolean;
}

export class UpdateCandidateDto extends CandidateFieldsDto {}

export class SubmitTargetDto {
  @IsString() @MaxLength(24) leadId: string;
  @IsOptional() @IsString() @MaxLength(24) requirementId?: string;
}

/** Create from a parsed CV — or attach the CV to an existing candidate. */
export class CandidateFromCvDto {
  @IsString() @MaxLength(24) fileId: string;
  @ValidateNested() @Type(() => CandidateFieldsDto) data: CandidateFieldsDto;
  /** Attach to this existing candidate instead of creating one. */
  @IsOptional() @IsString() @MaxLength(24) candidateId?: string;
  /** When attaching: overwrite existing values (default only fills blanks). */
  @IsOptional() @IsBoolean() overwrite?: boolean;
  @IsOptional() @IsString() @MaxLength(24) openingId?: string;
  @IsOptional() @IsString() @MaxLength(24) stageId?: string;
  @IsOptional() @IsObject() parsedJson?: Record<string, unknown>;
  /** Shortlist straight against a client lead (optionally a requirement). */
  @IsOptional() @ValidateNested() @Type(() => SubmitTargetDto) submitTo?: SubmitTargetDto;
}

export class ParseCvDto {
  @IsString() @MaxLength(24) fileId: string;
  /** Skip the LLM and only run text extraction + regex (cheap). */
  @IsOptional() @IsBoolean() skipAi?: boolean;
}

export class MergeCandidatesDto {
  @IsString() @MaxLength(24) primaryId: string;
  @IsString() @MaxLength(24) duplicateId: string;
}

export class BulkCandidateActionDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) @MaxLength(24, { each: true }) candidateIds: string[];
  @IsIn(['add_to_opening', 'add_tags', 'remove_tags', 'set_owner', 'set_status', 'delete']) action: string;
  @IsOptional() @IsString() @MaxLength(24) openingId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(24) ownerId?: string | null;
  @IsOptional() @IsIn(list(CANDIDATE_STATUSES)) status?: string;
}

export class AddDocumentDto {
  @IsString() @MaxLength(24) fileId: string;
  @IsOptional() @IsIn(list(DOCUMENT_KINDS)) kind?: string;
  @IsOptional() @IsBoolean() makePrimary?: boolean;
}

export class CreateCandidateActivityDto {
  @IsIn(list(MANUAL_ACTIVITY_TYPES)) type: string;
  @IsString() @MaxLength(8000) body: string;
  @IsOptional() @IsString() @MaxLength(24) applicationId?: string;
  @IsOptional() @IsDateString() occurredAt?: string;
}

// ── openings ───────────────────────────────────────────────────────────────────

export class OpeningFieldsDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(40) code?: string | null;
  @IsOptional() @IsString() @MaxLength(24) departmentId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) location?: string | null;
  @IsOptional() @IsIn(list(WORK_MODES)) workMode?: string;
  @IsOptional() @IsIn(list(EMPLOYMENT_TYPES)) employmentType?: string;
  @IsOptional() @IsInt() @Min(0) @Max(60) expMinYears?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(60) expMaxYears?: number | null;
  @IsOptional() @IsNumber() @Min(0) budgetMin?: number | null;
  @IsOptional() @IsNumber() @Min(0) budgetMax?: number | null;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) positions?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(60, { each: true }) skills?: string[];
  @IsOptional() @IsString() @MaxLength(100000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(24) hiringManagerId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(24, { each: true }) recruiterIds?: string[];
  @IsOptional() @IsIn(list(OPENING_STATUSES)) status?: string;
  @IsOptional() @IsIn(list(PRIORITIES)) priority?: string;
  @IsOptional() @IsDateString() targetDate?: string | null;
  @IsOptional() @IsString() @MaxLength(24) scorecardTemplateId?: string | null;
}

export class CreateOpeningDto extends OpeningFieldsDto {
  @IsString() @MaxLength(200) declare title: string;
}

export class UpdateOpeningDto extends OpeningFieldsDto {}

// ── applications / pipeline ────────────────────────────────────────────────────

export class CreateApplicationDto {
  @IsString() @MaxLength(24) candidateId: string;
  @IsString() @MaxLength(24) openingId: string;
  @IsOptional() @IsString() @MaxLength(24) stageId?: string;
  @IsOptional() @IsString() @MaxLength(24) ownerId?: string;
}

export class MoveApplicationDto {
  @IsString() @MaxLength(24) stageId: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() @MaxLength(200) rejectionReason?: string;
}

export class BulkMoveDto extends MoveApplicationDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) @MaxLength(24, { each: true }) applicationIds: string[];
}

export class UpdateApplicationDto {
  @IsOptional() @IsString() @MaxLength(24) ownerId?: string | null;
  @IsOptional() @IsIn(['withdrawn', 'active']) status?: string;
}

// ── stages + settings ──────────────────────────────────────────────────────────

export class CreateStageDto {
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsIn(list(STAGE_KINDS)) kind?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsInt() order?: number;
}

export class UpdateStageDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsIn(list(STAGE_KINDS)) kind?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class ReorderStagesDto {
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(24, { each: true }) ids: string[];
}

export class UpdateSettingsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(200, { each: true }) rejectionReasons?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsInt() @Min(0) @Max(168) feedbackReminderHours?: number;
}

export class ScorecardTemplateDto {
  @IsString() @MaxLength(120) name: string;
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) criteria: string[];
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

// ── interviews ─────────────────────────────────────────────────────────────────

export class CreateInterviewDto {
  /** Internal round: the opening application. */
  @IsOptional() @IsString() @MaxLength(24) applicationId?: string;
  /** Client round: the lead submission. Exactly one of applicationId / submissionId. */
  @IsOptional() @IsString() @MaxLength(24) submissionId?: string;
  @IsString() @MaxLength(120) roundName: string;
  @IsOptional() @IsIn(list(INTERVIEW_TYPES)) type?: string;
  @IsDateString() scheduledAt: string;
  @IsOptional() @IsInt() @Min(5) @Max(600) durationMin?: number;
  @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(24, { each: true }) interviewerIds: string[];
  @IsOptional() @IsString() @MaxLength(300) location?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(1000) meetingLink?: string;
  /** Create a built-in video meeting (Meetings module) for the interviewers. */
  @IsOptional() @IsBoolean() createMeeting?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) criteria?: string[];
  @IsOptional() @IsString() @MaxLength(24) scorecardTemplateId?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateInterviewDto {
  @IsOptional() @IsString() @MaxLength(120) roundName?: string;
  @IsOptional() @IsIn(list(INTERVIEW_TYPES)) type?: string;
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsInt() @Min(5) @Max(600) durationMin?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(24, { each: true }) interviewerIds?: string[];
  @IsOptional() @IsString() @MaxLength(300) location?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) meetingLink?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) criteria?: string[];
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
  @IsOptional() @IsIn(list(INTERVIEW_STATUSES)) status?: string;
}

export class SubmitFeedbackDto {
  @IsObject() ratings: Record<string, number>;
  @IsIn(list(RECOMMENDATIONS)) recommendation: string;
  @IsOptional() @IsString() @MaxLength(4000) strengths?: string;
  @IsOptional() @IsString() @MaxLength(4000) concerns?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

// ── offers ─────────────────────────────────────────────────────────────────────

export class CreateOfferDto {
  @IsString() @MaxLength(24) applicationId: string;
  @IsString() @MaxLength(200) designation: string;
  @IsOptional() @IsString() @MaxLength(24) departmentId?: string;
  @IsOptional() @IsNumber() @Min(0) offeredCtc?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsDateString() joiningDate?: string;
  @IsOptional() @IsDateString() expiresOn?: string;
  @IsOptional() @IsString() @MaxLength(24) offerLetterFileId?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateOfferDto {
  @IsOptional() @IsString() @MaxLength(200) designation?: string;
  @IsOptional() @IsString() @MaxLength(24) departmentId?: string | null;
  @IsOptional() @IsNumber() @Min(0) offeredCtc?: number | null;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsDateString() joiningDate?: string | null;
  @IsOptional() @IsDateString() expiresOn?: string | null;
  @IsOptional() @IsString() @MaxLength(24) offerLetterFileId?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

export class OfferStatusDto {
  @IsIn(list(OFFER_STATUSES)) status: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class OfferHandoffDto {
  @IsString() @MaxLength(24) membershipId: string;
}

// ── import / export ────────────────────────────────────────────────────────────

export class ImportRowDto {
  /** Sheet / opening title the row came from. */
  @IsOptional() @IsString() @MaxLength(200) opening?: string;
  @IsOptional() @IsString() @MaxLength(300) fullName?: string;
  @IsOptional() @IsString() @MaxLength(100) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) email?: string;
  @IsOptional() @IsString() @MaxLength(500) qualification?: string;
  @IsOptional() @IsString() @MaxLength(100) experience?: string;
  @IsOptional() @IsString() @MaxLength(300) currentCompany?: string;
  @IsOptional() @IsString() @MaxLength(300) currentDesignation?: string;
  @IsOptional() @IsString() @MaxLength(100) noticePeriod?: string;
  @IsOptional() @IsString() @MaxLength(300) currentLocation?: string;
  @IsOptional() @IsString() @MaxLength(2000) remarks?: string;
  @IsOptional() @IsString() @MaxLength(1000) resumeUrl?: string;
  @IsOptional() @IsString() @MaxLength(100) source?: string;
  @IsOptional() @IsString() @MaxLength(1000) skills?: string;
  @IsOptional() @IsString() @MaxLength(100) currentCtc?: string;
  @IsOptional() @IsString() @MaxLength(100) expectedCtc?: string;
  @IsOptional() @IsString() @MaxLength(100) stage?: string;
  @IsOptional() @IsString() @MaxLength(300) linkedinUrl?: string;
  /** Client lead name or company — the candidate is shortlisted against it. */
  @IsOptional() @IsString() @MaxLength(200) lead?: string;
  /** Requirement title / role within that lead. */
  @IsOptional() @IsString() @MaxLength(300) requirement?: string;
  /** 1-based row number in the source sheet, echoed back in results. */
  @IsOptional() @IsInt() rowNumber?: number;
  @IsOptional() @IsString() @MaxLength(200) sheet?: string;
}

export class ImportCandidatesDto {
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ImportRowDto) rows: ImportRowDto[];
  @IsOptional() @IsBoolean() dryRun?: boolean;
  /** Source applied when a row has none (the team sources from Cutshort). */
  @IsOptional() @IsIn(list(CANDIDATE_SOURCES)) defaultSource?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
}


// ── client-lead submissions ────────────────────────────────────────────────────

const submissionStatuses = list(SUBMISSION_STATUSES);

export class CreateSubmissionDto {
  @IsString() @MaxLength(24) leadId: string;
  @IsOptional() @IsString() @MaxLength(24) requirementId?: string;
  @IsString() @MaxLength(24) candidateId: string;
  @IsOptional() @IsString() @MaxLength(24) applicationId?: string;
  @IsOptional() @IsIn(['shortlisted', 'submitted']) status?: string;
  @IsOptional() @IsNumber() @Min(0) billRate?: number;
  @IsOptional() @IsIn(list(BILL_UNITS)) billUnit?: string;
  @IsOptional() @IsNumber() @Min(0) costRate?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsDateString() availableFrom?: string;
  @IsOptional() @IsDateString() proposedStart?: string;
  @IsOptional() @IsString() @MaxLength(24) sharedDocumentId?: string;
  @IsOptional() @IsString() @MaxLength(24) ownerId?: string;
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
}

export class BulkSubmissionDto {
  @IsString() @MaxLength(24) leadId: string;
  @IsOptional() @IsString() @MaxLength(24) requirementId?: string;
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(24, { each: true }) candidateIds: string[];
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
}

export class UpdateSubmissionDto {
  @IsOptional() @IsNumber() @Min(0) billRate?: number | null;
  @IsOptional() @IsIn(list(BILL_UNITS)) billUnit?: string;
  @IsOptional() @IsNumber() @Min(0) costRate?: number | null;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsDateString() availableFrom?: string | null;
  @IsOptional() @IsDateString() proposedStart?: string | null;
  @IsOptional() @IsString() @MaxLength(24) sharedDocumentId?: string | null;
  @IsOptional() @IsString() @MaxLength(8000) clientFeedback?: string | null;
  @IsOptional() @IsString() @MaxLength(24) ownerId?: string | null;
}

export class MoveSubmissionDto {
  @IsIn(submissionStatuses) status: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsString() @MaxLength(8000) clientFeedback?: string;
}

// ── lead workspace (wraps Sales) ───────────────────────────────────────────────

export class UpdateLeadWorkspaceDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string | null;
  @IsOptional() @IsString() @MaxLength(254) email?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(120) title?: string | null;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(8000) notes?: string | null;
  @IsOptional() @IsString() @MaxLength(100000) requirement?: string | null;
  @IsOptional() @IsNumber() @Min(0) value?: number | null;
  @IsOptional() @IsIn(['open', 'won', 'lost', 'on_hold']) status?: string;
}

export class LeadRequirementDto {
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) details?: string | null;
  @IsOptional() @IsString() @MaxLength(120) role?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(60, { each: true }) skills?: string[];
  @IsOptional() @IsIn(['must_have', 'should_have', 'could_have', 'wont_have', 'other']) priority?: string;
  @IsOptional() @IsIn(['open', 'in_progress', 'fulfilled', 'dropped']) status?: string;
  @IsOptional() @IsIn(['hours', 'days', 'fixed', 'other']) unit?: string;
  @IsOptional() @IsNumber() @Min(0) quantity?: number;
  @IsOptional() @IsNumber() @Min(0) rate?: number;
  @IsOptional() @IsDateString() neededBy?: string | null;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(1000) positions?: number | null;
}

export class LeadFollowupDto {
  @IsDateString() dueAt: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() @MaxLength(24) assignedTo?: string;
}

export class UpdateLeadFollowupDto {
  @IsOptional() @IsIn(['pending', 'done', 'snoozed']) status?: string;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class LeadNoteDto {
  @IsIn(['note', 'call', 'email', 'meeting', 'whatsapp']) type: string;
  @IsString() @MaxLength(8000) body: string;
}

export class LeadDocumentDto {
  @IsString() @MaxLength(24) fileId: string;
  @IsString() @MaxLength(500) fileName: string;
  @IsOptional() @IsString() @MaxLength(200) mimeType?: string;
  @IsOptional() @IsNumber() size?: number;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}
