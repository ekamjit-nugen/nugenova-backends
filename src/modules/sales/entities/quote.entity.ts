import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { SalesEntityType } from '../sales.constants';

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';

/** A single priced line on a quote. Amount is derived (quantity × rate). */
export interface QuoteItem {
  description: string;
  unit: string; // hours | days | fixed | unit
  quantity: number;
  rate: number;
}

/**
 * A quote / proposal for a lead or deal — a set of priced line items (often built
 * from the deal's requirements) with a discount + tax, rolled up to a total. Sent
 * to the client and accepted/rejected. Money fields are stored numeric and
 * recomputed from `items` on every save.
 */
@Entity('sales_quotes')
@Index('ix_sales_quotes_entity', ['organizationId', 'entityType', 'entityId'])
export class QuoteEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  entityType: SalesEntityType;

  @Column({ type: 'varchar', length: 24 })
  entityId: string;

  /** Human quote number, e.g. Q-0007, unique-ish per org. */
  @Column({ type: 'varchar', nullable: true, default: null })
  number: string | null;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', default: 'draft' })
  status: QuoteStatus;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  items: QuoteItem[];

  /** 'percent' | 'amount' */
  @Column({ type: 'varchar', default: 'percent' })
  discountType: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  discountValue: string;

  @Column({ type: 'numeric', precision: 6, scale: 3, default: 0 })
  taxPercent: string;

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  // ── computed money (recomputed on save) ──
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  subtotal: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  discountAmount: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  taxAmount: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  total: string;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  validUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  acceptedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  rejectedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
