import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * BoardNote — one sticky note on a {@link DiscussionBoardEntity} (legacy
 * `boardnotes`). Positioned freely on the canvas (`x`/`y`/`width`/`height`,
 * `zIndex`) with a colour; comments hang off it by `note_id`.
 */
@Entity('board_notes')
@Index('ix_board_notes_board', ['boardId'])
@Index('ix_board_notes_org', ['organizationId'])
export class BoardNoteEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  boardId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  authorId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  authorName: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  text: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  color: string | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  x: number | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  y: number | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  width: number | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  height: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  zIndex: number | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
