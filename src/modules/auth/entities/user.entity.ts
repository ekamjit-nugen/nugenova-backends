import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * User — the global platform login identity. Postgres port of user.schema.ts.
 *
 * Denormalized list fields (organizations/roles/permissions/mfaBackupCodes) →
 * `text[]`; nested objects (oauthProviders/preferences) → `jsonb`. The password
 * column holds the bcrypt hash as-is (passwordless OTP users have a placeholder
 * or null) — no hashing hook here; the ETL copies the stored hash verbatim.
 */
@Entity('users')
export class UserEntity extends PgBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  email: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  password: string | null;

  @Column({ type: 'varchar' })
  firstName: string;

  @Column({ type: 'varchar', default: '' })
  lastName: string;

  @Column({ type: 'text', nullable: true, default: null })
  avatar: string | null;

  @Column({ type: 'boolean', default: false })
  isEmailVerified: boolean;

  @Column({ type: 'varchar', nullable: true, default: null })
  emailVerificationToken: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  emailVerificationExpiry: Date | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phoneNumber: string | null;

  @Column({ type: 'boolean', default: false })
  isPhoneVerified: boolean;

  @Column({ type: 'varchar', nullable: true, default: null })
  phoneVerificationToken: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  phoneVerificationExpiry: Date | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  jobTitle: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  department: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  bio: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  location: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  timezone: string | null;

  /** Person-level HR attributes carried over from the legacy Nugen employee record. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  dateOfBirth: Date | null;

  /** Free-form skill tags (legacy `employee.skills`); jsonb to tolerate string[] or object[]. */
  @Column({ type: 'jsonb', nullable: true, default: null })
  skills: unknown[] | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  linkedIn: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  github: string | null;

  @Column({ type: 'boolean', default: false })
  mfaEnabled: boolean;

  @Column({ type: 'varchar', nullable: true, default: null })
  mfaMethod: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  mfaSecret: string | null;

  @Column({ type: 'text', array: true, nullable: true, default: null })
  mfaBackupCodes: string[] | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastLogin: Date | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  lastLoginIp: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  tokensValidFrom: Date | null;

  @Column({ type: 'int', default: 0 })
  loginAttempts: number;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lockUntil: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  deletedAt: Date | null;

  @Index()
  @Column({ type: 'varchar', default: 'otp_verified' })
  setupStage: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  defaultOrganizationId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  lastOrgId: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  organizations: string[];

  @Column({ type: 'text', array: true, default: () => "'{user}'" })
  roles: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  permissions: string[];

  @Column({ type: 'jsonb', nullable: true, default: null })
  oauthProviders: Record<string, unknown> | null;

  @Index()
  @Column({ type: 'boolean', default: false })
  isPlatformAdmin: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  preferences: Record<string, unknown> | null;

  // OTP fields (ephemeral, but migrated for continuity).
  @Column({ type: 'varchar', nullable: true, default: null })
  otp: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  otpExpiresAt: Date | null;

  @Column({ type: 'int', default: 0 })
  otpAttempts: number;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  otpLastRequestedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  otpRequestCount: number;

  @Column({ type: 'boolean', default: false })
  gdprDeletionRequested: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  gdprDeletionRequestedAt: Date | null;

  @Index()
  @Column({ type: 'timestamptz', nullable: true, default: null })
  gdprDeletionScheduledAt: Date | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  gdprDeletionReason: string | null;
}
