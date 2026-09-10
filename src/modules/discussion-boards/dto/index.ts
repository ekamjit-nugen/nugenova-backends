import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Edit a sticky note's content (double-click-to-edit on the board). */
export class UpdateNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;
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
