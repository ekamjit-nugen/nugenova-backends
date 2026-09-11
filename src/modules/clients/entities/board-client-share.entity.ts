import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type BoardSharePermission = 'view' | 'comment';

/**
 * A discussion board shared with a client. Every active portal user of the
 * client — and every staff member assigned to the client — can open the board
 * (read; comment when permission = 'comment'). Unsharing revokes immediately.
 */
@Entity('board_client_shares')
@Index('uq_board_client_share', ['boardId', 'clientId'], { unique: true })
@Index('ix_board_client_shares_client', ['organizationId', 'clientId'])
@Index('ix_board_client_shares_board', ['boardId'])
export class BoardClientShareEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  boardId: string;

  @Column({ type: 'varchar', length: 24 })
  clientId: string;

  @Column({ type: 'varchar', default: 'view' })
  permission: BoardSharePermission;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sharedBy: string | null;
}
