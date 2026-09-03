import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const FIELD_TYPES = [
  'signature',
  'initials',
  'name',
  'firstName',
  'lastName',
  'date',
  'text',
  'email',
];

export class DocumentFieldDto {
  @IsString()
  @MaxLength(64)
  key: string;

  @IsIn(FIELD_TYPES)
  type: string;

  @IsInt()
  page: number;

  @IsNumber()
  xPct: number;

  @IsNumber()
  yPct: number;

  @IsNumber()
  wPct: number;

  @IsNumber()
  hPct: number;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class CustomDocumentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string; // free-text: pick a suggestion or enter a custom category

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  bodyHtml?: string;

  @IsOptional()
  @IsBoolean()
  requiresSignature?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresUpload?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DocumentFieldDto)
  fields?: DocumentFieldDto[];

  /** DocumentFile id of a PDF (uploaded via the admin upload endpoint) that the
   * owner fills/signs in place; `fields` are positioned on it. */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  sourceFileId?: string;
}

/** Super admin: request a batch of documents from an org (templates + custom). */
export class RequestDocumentsDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  templateKeys?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomDocumentDto)
  customDocuments?: CustomDocumentDto[];

  /** When true, (re)send the "documents requested" email to the owner. */
  @IsOptional()
  @IsBoolean()
  notify?: boolean;
}

/** HR requesting one ad-hoc document from an employee (Directory / Onboarding). */
export class RequestEmployeeDocumentDto {
  @IsString()
  @MaxLength(120)
  title: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string; // free-text: pick a suggestion or enter a custom category

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  bodyHtml?: string;

  @IsOptional()
  @IsBoolean()
  requiresSignature?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresUpload?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DocumentFieldDto)
  fields?: DocumentFieldDto[];
}

export class ApprovalDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RejectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note: string;
}

export class SetChecklistItemDto {
  @IsBoolean()
  done: boolean;
}

export class FieldValueDto {
  @IsString()
  @MaxLength(64)
  key: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  value?: string;
}

/** Owner: submit / sign a requested document. */
export class SubmitDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signerName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  signerEmail?: string;

  @IsOptional()
  @IsIn(['drawn', 'typed'])
  method?: 'drawn' | 'typed';

  /** DocumentFile id of the drawn-signature image (method === 'drawn'). */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  signatureFileId?: string;

  /** DocumentFile id of the uploaded document (requiresUpload). */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  submittedFileId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FieldValueDto)
  fieldValues?: FieldValueDto[];
}

// ── employee onboarding lifecycle ───────────────────────────────────────────

/** HR: start onboarding for an existing member. Requirements come from policy. */
export class InitiateOnboardingDto {
  /** The membership (or the member's userId) to onboard. */
  @IsString()
  @MaxLength(24)
  membershipId: string;

  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  probationMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  targetDays?: number;

  /** Optional buddy / reporting manager (a userId in the same org). */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  reportingManagerId?: string;
}

/** Employee self-service: mark an uploaded document against its slot. */
export class UploadOnboardingDocumentDto {
  @IsString()
  @MaxLength(24)
  fileId: string;
}

