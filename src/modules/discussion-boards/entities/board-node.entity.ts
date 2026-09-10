import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * BoardNode — a flow/diagram shape on a {@link DiscussionBoardEntity} (legacy
 * `boardnodes`): a labelled box with a kind, fill/stroke and canvas geometry.
 * (`boardedges` was empty in the source, so edges are not modelled yet.)
 */
@Entity('board_nodes')
@Index('ix_board_nodes_board', ['boardId'])
@Index('ix_board_nodes_org', ['organizationId'])
export class BoardNodeEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  boardId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  authorId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  authorName: string | null;

  /** Shape kind, e.g. `rounded`, `rect`, `diamond`. */
  @Column({ type: 'varchar', nullable: true, default: null })
  nodeKind: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  label: string | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  x: number | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  y: number | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  width: number | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  height: number | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  fill: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  stroke: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  zIndex: number | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
