import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/** Create a course. `code` is unique per org among active courses. */
export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 32)
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  academicYearId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  credits?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Patch a course (all fields optional). */
export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 32)
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  academicYearId?: string | null;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  credits?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Create a class/section — a course taught in a term. */
export class CreateClassDto {
  @IsString()
  @IsNotEmpty()
  courseId: string;

  @IsString()
  @IsNotEmpty()
  termId: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 64)
  section: string;

  @IsOptional()
  @IsString()
  teacherMembershipId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Patch a class/section. `teacherMembershipId: null` unassigns the teacher. */
export class UpdateClassDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(1, 64)
  section?: string;

  @IsOptional()
  @IsString()
  teacherMembershipId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Enrol a STUDENT membership into a class. */
export class EnrolStudentDto {
  @IsString()
  @IsNotEmpty()
  studentMembershipId: string;
}
