import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { ORG_TYPES } from '../vertical-packs';

/** The per-org override block (all fields optional; merged over the default pack). */
export class VerticalPackOverrideDto {
  @IsOptional()
  @IsObject()
  vocabulary?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledModules?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  aiTierCeiling?: number;
}

/**
 * Admin: set the org's vertical. Either field may be sent; `verticalPack: null`
 * clears the override back to the orgType default.
 */
export class SetVerticalPackDto {
  @IsOptional()
  @IsIn(ORG_TYPES as unknown as string[])
  orgType?: string;

  @IsOptional()
  @IsObject()
  verticalPack?: VerticalPackOverrideDto | null;
}
