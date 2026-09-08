import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** One chat message in a completion request. */
export class AiMessageDto {
  @IsIn(['system', 'user', 'assistant'])
  role: 'system' | 'user' | 'assistant';

  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  content: string;
}

/** Body of `POST /ai/complete`. */
export class CompleteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AiMessageDto)
  messages: AiMessageDto[];

  /** Override the provider's default model for this call. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  maxTokens?: number;
}
