import { IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/** Schedule a meeting for later. */
export class CreateMeetingDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsISO8601()
  scheduledStart?: string;

  @IsOptional()
  @IsISO8601()
  scheduledEnd?: string;

  /** User ids to invite (names are resolved server-side). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  participantIds?: string[];

  @IsOptional()
  @IsBoolean()
  lobbyEnabled?: boolean;

  @IsOptional()
  @IsIn(['none', 'daily', 'weekly'])
  recurrence?: 'none' | 'daily' | 'weekly';
}

/** Add people to an existing meeting. */
export class AddMeetingParticipantsDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  userIds: string[];
}

/** Start an instant ("meet now") meeting. */
export class InstantMeetingDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  participantIds?: string[];
}

/** Edit a scheduled meeting (any field optional). */
export class UpdateMeetingDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601()
  scheduledStart?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601()
  scheduledEnd?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  participantIds?: string[];

  @IsOptional()
  @IsBoolean()
  lobbyEnabled?: boolean;
}
