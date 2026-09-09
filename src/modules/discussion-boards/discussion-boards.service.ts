import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DiscussionBoardEntity } from './entities/discussion-board.entity';
import { BoardNoteEntity } from './entities/board-note.entity';
import { BoardNodeEntity } from './entities/board-node.entity';
import { BoardCommentEntity } from './entities/board-comment.entity';

export interface DiscussionBoardSummary {
  id: string;
  title: string;
  description: string | null;
  template: string | null;
  background: string | null;
  isArchived: boolean;
  participantCount: number;
  noteCount: number;
  updatedAt: Date;
}

export interface DiscussionBoardView {
  board: DiscussionBoardEntity;
  notes: BoardNoteEntity[];
  nodes: BoardNodeEntity[];
  comments: BoardCommentEntity[];
}

/**
 * DiscussionBoardsService — read surface for the communication boards. Every
 * query is org-scoped. Writes/realtime collaboration are a later phase; this
 * stands up the model + a viewer API over the migrated legacy data.
 */
@Injectable()
export class DiscussionBoardsService {
  constructor(
    @InjectRepository(DiscussionBoardEntity)
    private readonly boards: Repository<DiscussionBoardEntity>,
    @InjectRepository(BoardNoteEntity)
    private readonly notes: Repository<BoardNoteEntity>,
    @InjectRepository(BoardNodeEntity)
    private readonly nodes: Repository<BoardNodeEntity>,
    @InjectRepository(BoardCommentEntity)
    private readonly comments: Repository<BoardCommentEntity>,
  ) {}

  /** An org's boards (most-recently-updated first) with participant + note counts. */
  async listBoards(orgId: string): Promise<DiscussionBoardSummary[]> {
    const boards = await this.boards.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { updatedAt: 'DESC' },
    });
    if (!boards.length) return [];

    // One grouped count instead of N per-board queries.
    const counts = await this.notes
      .createQueryBuilder('n')
      .select('n.board_id', 'boardId')
      .addSelect('COUNT(*)', 'cnt')
      .where('n.organization_id = :orgId AND n.is_deleted = false', { orgId })
      .groupBy('n.board_id')
      .getRawMany<{ boardId: string; cnt: string }>();
    const noteCountByBoard = new Map(counts.map((c) => [c.boardId, Number(c.cnt)]));

    return boards.map((b) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      template: b.template,
      background: b.background,
      isArchived: b.isArchived,
      participantCount: Array.isArray(b.participants) ? b.participants.length : 0,
      noteCount: noteCountByBoard.get(b.id) ?? 0,
      updatedAt: b.updatedAt,
    }));
  }

  /** One board with all its live notes, nodes and comments. */
  async getBoard(orgId: string, id: string): Promise<DiscussionBoardView> {
    const board = await this.boards.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');

    const [notes, nodes, comments] = await Promise.all([
      this.notes.find({ where: { boardId: id, organizationId: orgId, isDeleted: false }, order: { zIndex: 'ASC', createdAt: 'ASC' } }),
      this.nodes.find({ where: { boardId: id, organizationId: orgId, isDeleted: false }, order: { zIndex: 'ASC', createdAt: 'ASC' } }),
      this.comments.find({ where: { boardId: id, organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } }),
    ]);

    return { board, notes, nodes, comments };
  }
}
