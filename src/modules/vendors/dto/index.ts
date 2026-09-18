import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class VendorPrimaryContactDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;
}

export class VendorBillingAddressDto {
  @IsOptional() @IsString() @MaxLength(200) street?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) state?: string;
  @IsOptional() @IsString() @MaxLength(120) country?: string;
  @IsOptional() @IsString() @MaxLength(20) zip?: string;
}

export class CreateVendorDto {
  @IsString() @MaxLength(200)
  companyName: string;

  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  serviceCategory?: string;

  @IsOptional() @IsString() @MaxLength(300)
  website?: string;

  @IsOptional() @IsString() @MaxLength(60)
  taxId?: string;

  @IsOptional() @IsString() @MaxLength(3)
  currency?: string;

  @IsOptional() @IsBoolean()
  timeTrackingEnabled?: boolean;

  @IsOptional()
  billingAddress?: VendorBillingAddressDto;

  @IsOptional()
  primaryContact?: VendorPrimaryContactDto;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;
}

export class UpdateVendorDto extends CreateVendorDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare companyName: string;

  @IsOptional() @IsIn(['active', 'inactive', 'archived'])
  status?: 'active' | 'inactive' | 'archived';

  @IsOptional() @IsIn(['invited', 'agreements_pending', 'active', 'suspended'])
  onboardingStatus?: 'invited' | 'agreements_pending' | 'active' | 'suspended';
}

export class CreateVendorContactDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;

  @IsOptional() @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateVendorContactDto extends CreateVendorContactDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare name: string;
}

export class CreateVendorEmployeeDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  skills?: string[];

  @IsOptional() @IsIn(['contract', 'full_time', 'part_time', 'freelance'])
  employmentType?: 'contract' | 'full_time' | 'part_time' | 'freelance';

  @IsOptional() @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  // Money: a rate can be 0 (unpaid intern-style placements) but never negative,
  // and the cap keeps a typo out of the billing figures.
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000)
  rateAmount?: number;

  @IsOptional() @IsString() @MaxLength(3)
  rateCurrency?: string;

  @IsOptional() @IsIn(['hour', 'day', 'month'])
  rateUnit?: 'hour' | 'day' | 'month';

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;
}

export class UpdateVendorEmployeeDto extends CreateVendorEmployeeDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare name: string;
}

// ── agreements ───────────────────────────────────────────────────────────────

const AGREEMENT_CATEGORIES = ['msa', 'nda', 'sow', 'code_of_conduct', 'other'];

/** A signature/name/date box placed on the PDF (page-relative percentages). */
export class VendorAgreementFieldDto {
  @IsString() @MaxLength(60)
  key: string;

  @IsIn(['signature', 'initials', 'name', 'firstName', 'lastName', 'date', 'text', 'email'])
  type: string;

  @IsNumber() page: number;
  @IsNumber() xPct: number;
  @IsNumber() yPct: number;
  @IsNumber() wPct: number;
  @IsNumber() hPct: number;

  @IsOptional() @IsBoolean()
  required?: boolean;

  @IsOptional() @IsString() @MaxLength(120)
  label?: string;
}

/** A value typed into a placed text field, merged by key when signing. */
export class VendorAgreementFieldValueDto {
  @IsString() @MaxLength(60)
  key: string;

  @IsString() @MaxLength(2000)
  value: string;
}

export class CreateVendorAgreementTemplateDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsString() @MaxLength(200)
  title?: string;

  @IsOptional() @IsIn(AGREEMENT_CATEGORIES)
  category?: string;

  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  @IsOptional() @IsString() @MaxLength(24)
  sourceFileId?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VendorAgreementFieldDto)
  fields?: VendorAgreementFieldDto[];

  @IsOptional() @IsBoolean()
  required?: boolean;

  @IsOptional() @IsArray() @IsString({ each: true })
  appliesToCategories?: string[];
}

export class UpdateVendorAgreementTemplateDto extends CreateVendorAgreementTemplateDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare name: string;

  @IsOptional() @IsBoolean()
  isArchived?: boolean;
}

export class CreateVendorAgreementDto {
  /** Start from a template; its content is copied, so later template edits don't leak in. */
  @IsOptional() @IsString() @MaxLength(24)
  templateId?: string;

  @IsOptional() @IsString() @MaxLength(200)
  title?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsIn(AGREEMENT_CATEGORIES)
  category?: string;

  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  @IsOptional() @IsString() @MaxLength(24)
  sourceFileId?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VendorAgreementFieldDto)
  fields?: VendorAgreementFieldDto[];

  @IsOptional() @IsBoolean()
  requiredForOnboarding?: boolean;

  @IsOptional() @IsDateString()
  expiresAt?: string;
}

export class UpdateVendorAgreementDto extends CreateVendorAgreementDto {}

/** Record a signature we received — in the app, or on paper/by email (`offline`). */
export class SignVendorAgreementDto {
  @IsString() @MaxLength(200)
  signerName: string;

  @IsOptional() @IsEmail()
  signerEmail?: string;

  @IsOptional() @IsIn(['drawn', 'typed', 'offline'])
  method?: 'drawn' | 'typed' | 'offline';

  @IsOptional() @IsString() @MaxLength(24)
  signatureFileId?: string;

  /** The signed copy: a flattened PDF, or the scan of a paper signature. */
  @IsOptional() @IsString() @MaxLength(24)
  signedFileId?: string;

  @IsOptional() @IsString() @MaxLength(500)
  recordedNote?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VendorAgreementFieldValueDto)
  fieldValues?: VendorAgreementFieldValueDto[];

  @IsOptional() @IsDateString()
  signedAt?: string;
}

export class DeclineVendorAgreementDto {
  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string;
}

// ── bills ────────────────────────────────────────────────────────────────────

/** One line of a bill: a contractor, how much of them, at what rate. */
export class VendorBillLineDto {
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  /** The supplied person this line is for; must belong to the billing vendor. */
  @IsOptional() @IsString() @MaxLength(24)
  vendorEmployeeId?: string;

  /** Kept as typed, so the bill still reads right if that person's record changes. */
  @IsOptional() @IsString() @MaxLength(200)
  contractorName?: string;

  @IsNumber() @Min(0) @Max(1000000)
  quantity: number;

  @IsOptional() @IsIn(['hour', 'day', 'month', 'fixed'])
  unit?: 'hour' | 'day' | 'month' | 'fixed';

  @IsNumber() @Min(0) @Max(100000000)
  rate: number;
}

export class CreateVendorBillDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => VendorBillLineDto)
  lineItems: VendorBillLineDto[];

  /** The vendor's own invoice number, when they gave us one. */
  @IsOptional() @IsString() @MaxLength(60)
  vendorInvoiceNumber?: string;

  /** What the bill covers, as people say it: "Aug 2026", "Sprint 14". */
  @IsOptional() @IsString() @MaxLength(60)
  period?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  taxPercent?: number;

  @IsOptional() @IsString() @MaxLength(3)
  currency?: string;

  @IsOptional() @IsDateString()
  issueDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsString() @MaxLength(24)
  invoiceFileId?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;
}

export class UpdateVendorBillDto extends CreateVendorBillDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VendorBillLineDto)
  declare lineItems: VendorBillLineDto[];
}

export class MarkVendorBillPaidDto {
  /** UTR, cheque number, transfer reference — how the payment can be traced. */
  @IsOptional() @IsString() @MaxLength(120)
  paymentReference?: string;

  @IsOptional() @IsDateString()
  paidAt?: string;
}

export class CancelVendorBillDto {
  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string;
}

// ── portal ───────────────────────────────────────────────────────────────────

export class InviteVendorContactDto {
  @IsOptional() @IsString() @MaxLength(120)
  firstName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  lastName?: string;
}

/** A vendor signing for themselves in the portal (never `offline`). */
export class PortalSignAgreementDto {
  @IsString() @MaxLength(200)
  signerName: string;

  @IsOptional() @IsEmail()
  signerEmail?: string;

  /** DocumentFile id of a drawn signature; typed signing leaves it out. */
  @IsOptional() @IsString() @MaxLength(24)
  signatureFileId?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VendorAgreementFieldValueDto)
  fieldValues?: VendorAgreementFieldValueDto[];
}
