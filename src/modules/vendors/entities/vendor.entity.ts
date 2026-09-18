import { ChildEntity, Column } from 'typeorm';
import { PartnerBillingAddress, PartnerEntity, PartnerPrimaryContact } from '../../partners/entities/partner.entity';

export type VendorStatus = 'active' | 'inactive' | 'archived';

/**
 * Where a vendor is in onboarding. `invited` → they have a portal login but have
 * signed nothing; `agreements_pending` → some required agreement is unsigned;
 * `active` → cleared to supply people; `suspended` → blocked (no new assignments).
 */
export type VendorOnboardingStatus = 'invited' | 'agreements_pending' | 'active' | 'suspended';

/** Kept as aliases so existing imports read the same. */
export type VendorPrimaryContact = PartnerPrimaryContact;
export type VendorBillingAddress = PartnerBillingAddress;

/**
 * A supplier company — staffing partners, subcontractors and service vendors:
 * the side that supplies people TO us.
 *
 * A `partners` row with `category = 'vendor'`; TypeORM adds that filter to every
 * query through this repository. The vendor's own people live in
 * `vendor_employees`, the people we correspond with in `vendor_contacts`.
 */
@ChildEntity('vendor')
export class VendorEntity extends PartnerEntity {
  /** Free text, e.g. Staffing, Facilities, IT services. `categories()` lists what an org uses. */
  @Column({ type: 'varchar', nullable: true, default: 'other' })
  serviceCategory: string;

  /** GSTIN / VAT / tax registration — shown on bills. */
  @Column({ type: 'varchar', nullable: true, default: null })
  taxId: string | null;

  @Column({ type: 'varchar', nullable: true, default: 'INR' })
  currency: string;

  @Column({ type: 'varchar', nullable: true, default: 'invited' })
  onboardingStatus: VendorOnboardingStatus;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  onboardedAt: Date | null;

  /**
   * Whether this vendor's people clock in through our attendance. Off by
   * default: most vendors bill from their own timesheets, and a contractor in
   * the attendance roster skews the org's own numbers.
   */
  @Column({ type: 'boolean', nullable: true, default: false })
  timeTrackingEnabled: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  billingAddress: PartnerBillingAddress | null;

  declare status: VendorStatus;
}
