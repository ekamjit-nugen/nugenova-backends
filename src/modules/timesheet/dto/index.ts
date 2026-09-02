import { IsArray, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class TimesheetEntryDto {
  @IsString() @MaxLength(10) date: string; // YYYY-MM-DD
  @IsNumber() @Min(0) @Max(24) hours: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class SaveTimesheetDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TimesheetEntryDto)
  entries?: TimesheetEntryDto[];
}

export class ReviewTimesheetDto {
  @IsIn(['approve', 'reject']) action: 'approve' | 'reject';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
