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

  /**
   * Requested AI tier for this call (0–3). Defaults to 1. The policy denies with
   * `tier_ceiling` when this exceeds the org's vertical-pack `aiTierCeiling`.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  tier?: number;

  /**
   * Optional subject (learner) membership id whose data this call processes.
   * When set, the policy checks guardian consent for the AI purpose and denies
   * with `not_consented` if it is missing. Omit for non-regulated calls.
   */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  subjectMembershipId?: string;
}

/**
 * Query params for `GET /ai/usage/events` — the paginated ledger. All optional;
 * `page`/`limit` are coerced from the querystring. Mirrors the admin dashboard
 * contract (`AiUsageQueryParams`).
 */
export class UsageEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(24)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  feature?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  projectId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
