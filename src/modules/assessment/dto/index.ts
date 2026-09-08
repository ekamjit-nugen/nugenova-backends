import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { ASSESSMENT_TYPES, AssessmentType } from '../entities/assessment.entity';

/** Create an assessment (gradebook column) for a class/section. */
export class CreateAssessmentDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  title: string;

  @IsIn(ASSESSMENT_TYPES as readonly string[])
  type: AssessmentType;

  @IsNumber()
  @Min(0)
  @Max(1000000)
  maxMarks: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  weight?: number;

  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

/** Patch an assessment (all fields optional). */
export class UpdateAssessmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsIn(ASSESSMENT_TYPES as readonly string[])
  type?: AssessmentType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  maxMarks?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  weight?: number;

  @IsOptional()
  @IsISO8601()
  dueDate?: string | null;

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

/**
 * Record (or re-grade) one student's mark on an assessment. `marksObtained: null`
 * clears a grade back to "not yet graded"; a number must be within [0, maxMarks]
 * (checked in the service against the assessment).
 */
export class RecordMarkDto {
  @IsString()
  @IsNotEmpty()
  enrolmentId: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  marksObtained?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string | null;
}
