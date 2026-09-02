import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GeoLocationDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @IsOptional()
  @IsString()
  address?: string;
}

export class CheckInDto {
  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoLocationDto)
  location?: GeoLocationDto;

  /** Clock in despite an approved-leave conflict (G-C1 override). */
  @IsOptional()
  @IsBoolean()
  confirmOverride?: boolean;

  @IsOptional()
  @IsIn(['office', 'home'])
  workMode?: 'office' | 'home';
}

export class CheckOutDto {
  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoLocationDto)
  location?: GeoLocationDto;
}

export class ManualEntryDto {
  /** Target employee (auth userId). Defaults to the caller when omitted. */
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsISO8601()
  date: string;

  @IsISO8601()
  checkInTime: string;

  @IsISO8601()
  checkOutTime: string;

  @IsString()
  @MaxLength(500)
  reason: string;
}

export class ApproveEntryDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;
}

export class RequestEditDto {
  @IsOptional()
  @IsISO8601()
  checkInTime?: string;

  @IsOptional()
  @IsISO8601()
  checkOutTime?: string;

  @IsString()
  @MaxLength(500)
  reason: string;
}

export class ReviewEditDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;
}

export class RequestWfhDto {
  @IsISO8601()
  startDate: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReviewWfhDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AttendanceQueryDto {
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  employeeId?: string;
}

export class StatsQueryDto {
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  endDate?: string;
}

export class CreateHolidayDto {
  @IsISO8601()
  date: string;

  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsIn(['national', 'regional', 'optional', 'bank', 'other'])
  type?: 'national' | 'regional' | 'optional' | 'bank' | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class HolidayQueryDto {
  @IsOptional()
  @IsNumber()
  @Min(2000)
  year?: number;
}
