import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CATEGORIES = [
  'nda',
  'msa',
  'agreement',
  'certificate',
  'tax',
  'kyc',
  'bank',
  'other',
];
const FIELD_TYPES = ['signature', 'initials', 'name', 'date', 'text', 'email'];

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
  @IsIn(CATEGORIES)
  category?: string;

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
  @IsIn(CATEGORIES)
  category?: string;

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
