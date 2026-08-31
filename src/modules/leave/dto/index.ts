import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ApplyLeaveDto {
  // Any configured type key (standard or custom); the service validates it's an
  // enabled type for the org.
  @IsString()
  @MaxLength(40)
  leaveType: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;

  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @IsOptional()
  @IsIn(['first_half', 'second_half'])
  halfDaySlot?: string;
}

export class RejectLeaveDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class CancelLeaveDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class LeaveQueryDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsInt()
  year?: number;
}
