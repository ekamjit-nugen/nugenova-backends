import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, IsOptional } from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class SendOtpDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email: string;
}

export class VerifyOtpDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'otp must be a 6-digit numeric code' })
  otp: string;
}

export class MfaAuthenticateDto {
  @IsString()
  mfaChallengeToken: string;

  @IsString()
  @MaxLength(64)
  code: string;
}

export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class MfaVerifyDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit numeric code' })
  code: string;
}

/** Update the current user's own profile (setup wizard step 2 + settings). */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  jobTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  linkedIn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  github?: string;

  /** A data-URL (base64) avatar, ~256px. Empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  avatar?: string;
}
