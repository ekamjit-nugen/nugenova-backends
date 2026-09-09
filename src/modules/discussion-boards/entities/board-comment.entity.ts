import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * BoardComment — a comment on a note of a {@link DiscussionBoardEntity} (legacy
 * `boardcomments`). Keyed to both its board and the note it hangs off.
 */
@Entity('board_comments')
@Index('ix_board_comments_board', ['boardId'])
@Index('ix_board_comments_note', ['noteId'])
export class BoardCommentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  boardId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  noteId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  authorId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  authorName: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  text: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
