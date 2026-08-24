import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../database/pg-base.entity';

/**
 * A persisted record of every email the system produced.
 *
 * The monolith's mailer was fire-and-forget with no trail. Here every send is
 * logged to this table regardless of driver, so:
 *  - dev/CI (the `outbox` driver) can run with NO SMTP/ZeptoMail at all and tests
 *    still assert "an email was produced" by querying this table;
 *  - the super-admin UI can show a delivery history per org;
 *  - a real send failure is captured (`status: 'failed'`, `error`) instead of lost.
 *
 * `status`: `queued` (outbox driver, not actually transmitted) | `sent` (a real
 * driver accepted it) | `failed` (a real driver rejected it).
 */
@Entity('email_outbox')
export class EmailOutboxEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** Comma-joined recipient list (rendered from the send options). */
  @Column({ type: 'varchar' })
  to: string;

  @Column({ type: 'varchar' })
  subject: string;

  @Column({ type: 'text' })
  html: string;

  /** Coarse grouping for the UI, e.g. `onboarding.documents_requested`. */
  @Index()
  @Column({ type: 'varchar', nullable: true, default: null })
  category: string | null;

  @Index()
  @Column({ type: 'varchar', default: 'queued' })
  status: string; // queued | sent | failed

  /** Which transport handled it: outbox | smtp | zeptomail. */
  @Column({ type: 'varchar', nullable: true, default: null })
  driver: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  error: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  sentAt: Date | null;
}
