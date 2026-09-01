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
