import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type VendorStatus = 'active' | 'inactive' | 'archived';

/**
 * Where a vendor is in onboarding. `invited` → they have a portal login but have
 * signed nothing; `agreements_pending` → some required agreement is unsigned;
 * `active` → cleared to supply people; `suspended` → blocked (no new assignments).
 */
export type VendorOnboardingStatus = 'invited' | 'agreements_pending' | 'active' | 'suspended';

/** The vendor-side person we deal with day to day, stored inline for the card. */
export interface VendorPrimaryContact {
  name: string;
  email?: string | null;
  phone?: string | null;
  designation?: string | null;
}

export interface VendorBillingAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zip?: string | null;
}

/**
 * A supplier company — staffing partners, subcontractors and service vendors.
 * The mirror image of `clients`: a client buys our people, a vendor sells us
 * theirs. Org-scoped. The vendor's own people live in `vendor_employees`, the
 * people we correspond with in `vendor_contacts`.
 */
@Entity('vendors')
@Index('ix_vendors_org_status', ['organizationId', 'status'])
@Index('ix_vendors_org_deleted', ['organizationId', 'isDeleted'])
export class VendorEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  companyName: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  displayName: string | null;

  /** Free text, e.g. Staffing, Facilities, IT services. `categories()` lists what an org uses. */
  @Column({ type: 'varchar', default: 'other' })
  serviceCategory: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  website: string | null;

  /** GSTIN / VAT / tax registration — shown on bills once billing lands. */
  @Column({ type: 'varchar', nullable: true, default: null })
  taxId: string | null;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'varchar', default: 'active' })
  status: VendorStatus;

  @Column({ type: 'varchar', default: 'invited' })
  onboardingStatus: VendorOnboardingStatus;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  onboardedAt: Date | null;

  /**
   * Whether this vendor's people clock in through our attendance. Off by
   * default: most vendors bill from their own timesheets, and a contractor in
   * the attendance roster skews the org's own numbers.
   */
  @Column({ type: 'boolean', nullable: false, default: false })
  timeTrackingEnabled: boolean;

  /**
   * The master switch for this vendor's portal. Off means nobody at the vendor
   * can sign in, even someone invited earlier — the check is on every portal
   * read, not just on invite, so turning it off locks the door immediately
   * without deleting anyone's login.
   */
  @Column({ type: 'boolean', nullable: false, default: false })
  portalEnabled: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  billingAddress: VendorBillingAddress | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  primaryContact: VendorPrimaryContact | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
