import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SalaryComponentDto {
  @IsString() @MaxLength(20) code: string;
  @IsString() @MaxLength(60) name: string;
  @IsNumber() @Min(0) @Max(100000000) amount: number;
}

export class TaxInputsDto {
  @IsOptional() @IsIn(['new', 'old']) regime?: 'new' | 'old';
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) section80C?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) section80D?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) section80E?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) homeLoanInterest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) hraExemptionAnnual?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) otherExemptions?: number;
}

export class StatutoryIdsDto {
  @IsOptional() @IsString() @MaxLength(16) pan?: string | null;
  @IsOptional() @IsString() @MaxLength(20) uan?: string | null;
  @IsOptional() @IsString() @MaxLength(24) esicNumber?: string | null;
}

export class RecurringDeductionDto {
  @IsString() @MaxLength(20) code: string;
  @IsString() @MaxLength(60) name: string;
  @IsNumber() @Min(0) @Max(100000000) amount: number;
  /** Total to recover (loan principal); recovery stops once reached. */
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) total?: number;
}

export class SetSalaryDto {
  /** Monthly gross salary in rupees. */
  @IsNumber()
  @Min(0)
  @Max(100000000)
  monthlySalary: number;

  /** Earning breakdown (Basic/HRA/…); omit ⇒ whole salary treated as Basic. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalaryComponentDto)
  components?: SalaryComponentDto[];

  /** Employee-specific recurring recoveries (loan EMI, advance). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecurringDeductionDto)
  recurringDeductions?: RecurringDeductionDto[];

  /** Income-tax regime + declared deductions (drives TDS). */
  @IsOptional()
  @ValidateNested()
  @Type(() => TaxInputsDto)
  taxInputs?: TaxInputsDto;

  /** Statutory identifiers (PAN / UAN / ESIC) for registers & Form 16. */
  @IsOptional()
  @ValidateNested()
  @Type(() => StatutoryIdsDto)
  statutoryIds?: StatutoryIdsDto;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;
}

export class GeneratePayslipsDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  /** Specific employees; omit to run every active-salaried member. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];
}

export class PayslipQueryDto {
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

// ── investment declarations (Phase C) ──────────────────────────────────────────

export class TaxProofDto {
  @IsString() @MaxLength(24) fileId: string;
  @IsString() @MaxLength(200) name: string;
  @IsInt() @Min(0) size: number;
  @IsString() @MaxLength(40) section: string;
}

export class SaveTaxDeclarationDto {
  @IsIn(['new', 'old']) regime: 'new' | 'old';
  @IsOptional() @IsInt() @Min(0) @Max(100000000) section80C?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) section80D?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) section80E?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) homeLoanInterest?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) hraExemptionAnnual?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) otherExemptions?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TaxProofDto)
  proofs?: TaxProofDto[];
}

export class ReviewTaxDeclarationDto {
  @IsIn(['verify', 'reject']) action: 'verify' | 'reject';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
