import { IsBoolean, IsHexColor, IsISO8601, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/** Edit a card: content, colour, due date, or completion. */
export class UpdateNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  /** ISO datetime, or null to clear the due date. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601()
  dueDate?: string | null;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

/** Create a new card on a board. */
export class CreateNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601()
  dueDate?: string | null;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

/** Add a member to a board's participants. */
export class AddParticipantDto {
  @IsString()
  @MaxLength(24)
  userId: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  role?: string;
}
