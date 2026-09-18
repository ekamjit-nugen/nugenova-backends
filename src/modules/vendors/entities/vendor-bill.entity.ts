import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type VendorBillStatus = 'draft' | 'approved' | 'paid' | 'cancelled';
export type BillLineUnit = 'hour' | 'day' | 'month' | 'fixed';

/**
 * One line of a bill — usually "this contractor, this many days, at this rate".
 * `vendorEmployeeId` links it to the supplied person when there is one;
 * `contractorName` is kept as typed so the bill still reads correctly years
 * later, after that person's record has changed or gone.
 *
 * `amount` is always recomputed server-side from quantity × rate: a client may
 * suggest totals, it may never decide them.
 */
export interface VendorBillLine {
  description: string;
  vendorEmployeeId?: string | null;
  contractorName?: string | null;
  quantity: number;
  unit: BillLineUnit;
  rate: number;
  amount: number;
}

/**
 * A bill from a vendor — what they charged us for the people they supplied.
 *
 * Lifecycle: draft → approved → paid, and draft/approved → cancelled. A bill is
 * only editable while it is a draft; after approval it is a financial record,
 * so corrections mean cancelling and raising a new one. Every money figure is
 * recomputed from the lines on write.
 *
 * This is the first billing surface in the platform: there is no invoice,
 * payment or ledger model to hang it off yet, so `markPaid` records that we paid
 * (when, by whom, with what reference) rather than moving money anywhere.
 */
@Entity('vendor_bills')
@Index('ix_vendor_bills_org_status', ['organizationId', 'status'])
@Index('ix_vendor_bills_vendor', ['vendorId'])
@Index('ux_vendor_bills_org_number', ['organizationId', 'billNumber'], { unique: true })
export class VendorBillEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  vendorId: string;

  /** The vendor's name as it was when the bill was raised. */
  @Column({ type: 'varchar', nullable: true, default: null })
  vendorName: string | null;

  /** Per-org running number, e.g. VB-00007. */
  @Column({ type: 'varchar' })
  billNumber: string;

  /** The vendor's own invoice number, when they gave us one. */
  @Column({ type: 'varchar', nullable: true, default: null })
  vendorInvoiceNumber: string | null;

  /** What the bill covers, as people say it: "Aug 2026", "Sprint 14". */
  @Column({ type: 'varchar', nullable: true, default: null })
  period: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  lineItems: VendorBillLine[];

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  // ── computed money (recomputed from lineItems on every write) ──
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  subtotal: string;

  @Column({ type: 'numeric', precision: 6, scale: 3, default: 0 })
  taxPercent: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  taxAmount: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  total: string;

  @Column({ type: 'varchar', default: 'draft' })
  status: VendorBillStatus;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  issueDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  dueDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  approvedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  approvedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  paidAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  paidBy: string | null;

  /** How the payment was made — UTR, cheque number, transfer reference. */
  @Column({ type: 'varchar', nullable: true, default: null })
  paymentReference: string | null;

  /** Why a bill was cancelled, for the audit trail. */
  @Column({ type: 'text', nullable: true, default: null })
  cancelReason: string | null;

  /** DocumentFile id of the vendor's own invoice PDF, when they sent one. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  invoiceFileId: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
