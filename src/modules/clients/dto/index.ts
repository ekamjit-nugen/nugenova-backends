import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';

/** A signature/name/date box placed on a PDF (page-relative percentages). */
export class AgreementFieldDto {
  @IsString() @MaxLength(60)
  key: string;

  @IsIn(['signature', 'initials', 'name', 'firstName', 'lastName', 'date', 'text', 'email'])
  type: string;

  @IsNumber()
  page: number;

  @IsNumber() xPct: number;
  @IsNumber() yPct: number;
  @IsNumber() wPct: number;
  @IsNumber() hPct: number;

  @IsOptional() @IsBoolean()
  required?: boolean;

  @IsOptional() @IsString() @MaxLength(120)
  label?: string;
}

/** A value typed into a placed text field, merged by key at sign time. */
export class AgreementFieldValueDto {
  @IsString() @MaxLength(60)
  key: string;

  @IsString() @MaxLength(2000)
  value: string;
}

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

  /** Let this client sign in to the portal. Turning it on invites their contacts. */
  @IsOptional() @IsBoolean()
  portalEnabled?: boolean;
}

/** The portal master switch for a client. */
export class SetClientPortalDto {
  @IsBoolean()
  enabled: boolean;
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

/** Portal user posts a comment on a shared board (optionally on a note). */
export class PortalCommentDto {
  @IsString() @MaxLength(4000)
  text: string;

  @IsOptional() @IsString() @MaxLength(24)
  noteId?: string;
}

// ── agreements ────────────────────────────────────────────────────────────────

export class CreateAgreementDto {
  @IsString() @MaxLength(300)
  title: string;

  @IsOptional() @IsString() @MaxLength(4000)
  description?: string;

  @IsOptional() @IsIn(['nda', 'sow', 'msa', 'contract', 'other'])
  category?: string;

  /** Agreement text (rich HTML). Required unless a PDF is attached. */
  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  /** DocumentFile id of an attached PDF the client reads/signs. */
  @IsOptional() @IsString() @MaxLength(24)
  sourceFileId?: string;

  /** Signature/name/date boxes placed on the PDF for in-place signing. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AgreementFieldDto)
  fields?: AgreementFieldDto[];
}

export class UpdateAgreementDto {
  @IsOptional() @IsString() @MaxLength(300)
  title?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  description?: string;

  @IsOptional() @IsIn(['nda', 'sow', 'msa', 'contract', 'other'])
  category?: string;

  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  @IsOptional() @IsString() @MaxLength(24)
  sourceFileId?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AgreementFieldDto)
  fields?: AgreementFieldDto[];
}

/** A reusable agreement template. */
export class CreateAgreementTemplateDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsString() @MaxLength(300)
  title?: string;

  @IsOptional() @IsIn(['nda', 'sow', 'msa', 'contract', 'other'])
  category?: string;

  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  @IsOptional() @IsString() @MaxLength(24)
  sourceFileId?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AgreementFieldDto)
  fields?: AgreementFieldDto[];
}

export class UpdateAgreementTemplateDto {
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(300)
  title?: string;

  @IsOptional() @IsIn(['nda', 'sow', 'msa', 'contract', 'other'])
  category?: string;

  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  @IsOptional() @IsString() @MaxLength(24)
  sourceFileId?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AgreementFieldDto)
  fields?: AgreementFieldDto[];
}

/** Register a file (already uploaded to /media) into a client's document vault. */
export class CreateDocumentDto {
  @IsString() @MaxLength(24)
  fileId: string;

  @IsString() @MaxLength(500)
  fileName: string;

  @IsOptional() @IsString() @MaxLength(200)
  mimeType?: string;

  @IsOptional() @IsNumber()
  size?: number;

  @IsOptional() @IsString() @MaxLength(300)
  title?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  /** Ask the client to sign this one. Off unless ticked. */
  @IsOptional() @IsBoolean()
  signatureRequired?: boolean;

  /**
   * Record a document the CLIENT sent us, uploaded on their behalf because it
   * arrived by email. Staff-only; the portal route sets this itself.
   */
  @IsOptional() @IsBoolean()
  fromClient?: boolean;

  /** Who it came from, when recording one that arrived by email. */
  @IsOptional() @IsString() @MaxLength(200)
  fromName?: string;

  /** They want us to sign it. */
  @IsOptional() @IsBoolean()
  requestOurSignature?: boolean;
}

/** An admin turning the "client must sign" tick on or off after sharing. */
export class UpdateDocumentDto {
  @IsOptional() @IsBoolean()
  signatureRequired?: boolean;

  @IsOptional() @IsString() @MaxLength(300)
  title?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;
}

/** A client uploading a document to us from their portal. */
export class PortalUploadDocumentDto {
  @IsString() @MaxLength(24)
  fileId: string;

  @IsString() @MaxLength(500)
  fileName: string;

  @IsOptional() @IsString() @MaxLength(200)
  mimeType?: string;

  @IsOptional() @IsNumber()
  size?: number;

  @IsOptional() @IsString() @MaxLength(300)
  title?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  /** Ask us to sign it and send it back. */
  @IsOptional() @IsBoolean()
  requestOurSignature?: boolean;
}

/** Signing a document — by either side. */
export class SignDocumentDto {
  @IsString() @MaxLength(200)
  signerName: string;

  @IsOptional() @IsEmail()
  signerEmail?: string;

  @IsOptional() @IsIn(['drawn', 'typed'])
  method?: 'drawn' | 'typed';

  /** DocumentFile id of the signed copy, when one is attached. */
  @IsOptional() @IsString() @MaxLength(24)
  signedFileId?: string;
}

// ── tickets ──────────────────────────────────────────────────────────────────

export class CreateTicketDto {
  @IsString() @MaxLength(300)
  subject: string;

  @IsOptional() @IsString() @MaxLength(8000)
  description?: string;

  @IsOptional() @IsIn(['question', 'issue', 'request', 'billing', 'other'])
  category?: string;

  @IsOptional() @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;
}

export class UpdateTicketDto {
  @IsOptional() @IsIn(['open', 'in_progress', 'resolved', 'closed'])
  status?: string;

  @IsOptional() @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;

  @IsOptional() @IsString() @MaxLength(24)
  assignedToUserId?: string;
}

export class TicketMessageDto {
  @IsString() @MaxLength(8000)
  body: string;
}

/** A client portal user signs an agreement (drawn image or typed name). */
export class SignAgreementDto {
  @IsString() @MaxLength(200)
  signerName: string;

  @IsOptional() @IsIn(['drawn', 'typed'])
  method?: 'drawn' | 'typed';

  /** DocumentFile id of the drawn signature image (method === 'drawn'). */
  @IsOptional() @IsString() @MaxLength(24)
  signatureFileId?: string;

  /** DocumentFile id of the flattened, signature-embedded PDF. */
  @IsOptional() @IsString() @MaxLength(24)
  signedFileId?: string;

  /** Values typed into placed text fields (name/date/…). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AgreementFieldValueDto)
  fieldValues?: AgreementFieldValueDto[];
}
