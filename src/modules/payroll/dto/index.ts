import { IsArray, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class SetSalaryDto {
  /** Monthly gross salary in rupees. */
  @IsNumber()
  @Min(0)
  @Max(100000000)
  monthlySalary: number;

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
