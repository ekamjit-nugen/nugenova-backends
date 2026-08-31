import {
  IsArray,
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
