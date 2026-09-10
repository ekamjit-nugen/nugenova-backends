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
