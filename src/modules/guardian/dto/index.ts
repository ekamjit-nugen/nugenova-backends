import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** Link a guardian membership to a student membership. */
export class LinkGuardianDto {
  @IsString()
  @IsNotEmpty()
  guardianMembershipId: string;

  @IsString()
  @IsNotEmpty()
  studentMembershipId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  relationship?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

/**
 * Record a consent for a learner. `grantedByMembershipId` defaults to the subject
 * (self-consent); pass a linked guardian's membership for a minor.
 */
export class RecordConsentDto {
  @IsString()
  @IsNotEmpty()
  subjectMembershipId: string;

  @IsString()
  @IsNotEmpty()
  purpose: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  grantedByMembershipId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

/** Revoke every active consent for a learner + purpose. */
export class RevokeConsentDto {
  @IsString()
  @IsNotEmpty()
  subjectMembershipId: string;

  @IsString()
  @IsNotEmpty()
  purpose: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  revokedByMembershipId?: string;
}
