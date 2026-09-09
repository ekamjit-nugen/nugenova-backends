import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * DiscussionBoard — a collaborative "communication board" (legacy Mongo
 * `discussionboards`): a retro/brainstorm canvas of sticky notes, flow nodes and
 * comments, shared by a set of participants. Ported from the monolith; the note/
 * node/comment children live in their own tables keyed by `board_id`.
 *
 * `participants` and `lanes` are low-volume embedded arrays kept as jsonb.
 * Legacy `_id` is preserved as `id` so child `board_id` references keep resolving.
 */
@Entity('discussion_boards')
@Index('ix_discussion_boards_org', ['organizationId'])
export class DiscussionBoardEntity extends PgBaseEntity {
  /** Owning org — the tenant boundary. */
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** Starting template, e.g. `retro`, `blank`, `flow`. */
  @Column({ type: 'varchar', nullable: true, default: null })
  template: string | null;

  /** Canvas background (color or preset key). */
  @Column({ type: 'varchar', nullable: true, default: null })
  background: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  createdByName: string | null;

  /** [{ userId, name, role, addedAt }] */
  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  participants: unknown[];

  /** Optional column/lane definitions (e.g. retro columns). */
  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  lanes: unknown[];

  /** Metadata about a Cloud Drive export of the board, if any. */
  @Column({ type: 'jsonb', nullable: true, default: null })
  driveExport: Record<string, unknown> | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isArchived: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
