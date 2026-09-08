import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Body of `POST /ai/ask`. */
export class AskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question: string;

  /** How many org chunks to retrieve as context (1–20, default 6). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number;
}
