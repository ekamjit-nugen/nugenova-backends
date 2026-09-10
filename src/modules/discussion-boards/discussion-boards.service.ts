import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DiscussionBoardEntity } from './entities/discussion-board.entity';
import { BoardNoteEntity } from './entities/board-note.entity';
import { BoardNodeEntity } from './entities/board-node.entity';
import { BoardCommentEntity } from './entities/board-comment.entity';

/** Who is asking — drives participant-based access. */
export interface BoardCaller {
  userId: string;
  /** Owner/admin see every board; everyone else only their own participations. */
  isAdmin: boolean;
}

export interface DiscussionBoardSummary {
  id: string;
  title: string;
  description: string | null;
  template: string | null;
  background: string | null;
  isArchived: boolean;
  participantCount: number;
  /** First few participant display names, for an avatar stack on the card. */
  participantsPreview: { name: string }[];
  createdByName: string | null;
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

  /** True when the caller may see/open this board: an admin, its creator, or a
   *  listed participant. Discussion boards are private to their participants. */
  private canAccess(board: DiscussionBoardEntity, caller: BoardCaller): boolean {
    if (caller.isAdmin) return true;
    if (board.createdBy && board.createdBy === caller.userId) return true;
    return (
      Array.isArray(board.participants) &&
      board.participants.some((p) => String((p as { userId?: unknown })?.userId) === caller.userId)
    );
  }

  /**
   * The boards the caller may see (most-recently-updated first) with participant
   * + note counts. Owner/admin see every org board; every other member sees only
   * the boards they created or participate in.
   */
  async listBoards(orgId: string, caller: BoardCaller): Promise<DiscussionBoardSummary[]> {
    const all = await this.boards.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { updatedAt: 'DESC' },
    });
    const boards = all.filter((b) => this.canAccess(b, caller));
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

    return boards.map((b) => {
      const parts = Array.isArray(b.participants) ? b.participants : [];
      return {
        id: b.id,
        title: b.title,
        description: b.description,
        template: b.template,
        background: b.background,
        isArchived: b.isArchived,
        participantCount: parts.length,
        participantsPreview: parts
          .slice(0, 5)
          .map((p) => ({ name: String((p as { name?: unknown })?.name ?? '') }))
          .filter((p) => p.name),
        createdByName: b.createdByName,
        noteCount: noteCountByBoard.get(b.id) ?? 0,
        updatedAt: b.updatedAt,
      };
    });
  }

  /** One board with all its live notes, nodes and comments — participant-gated. */
  async getBoard(orgId: string, id: string, caller: BoardCaller): Promise<DiscussionBoardView> {
    const board = await this.boards.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) {
      throw new ForbiddenException('You do not have access to this board');
    }

    const [notes, nodes, comments] = await Promise.all([
      this.notes.find({ where: { boardId: id, organizationId: orgId, isDeleted: false }, order: { zIndex: 'ASC', createdAt: 'ASC' } }),
      this.nodes.find({ where: { boardId: id, organizationId: orgId, isDeleted: false }, order: { zIndex: 'ASC', createdAt: 'ASC' } }),
      this.comments.find({ where: { boardId: id, organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } }),
    ]);

    return { board, notes, nodes, comments };
  }

  /**
   * Edit a note's text/title. Same participant gate as viewing — anyone who can
   * open the board can edit its notes (owner/admin, creator, or a participant).
   */
  async updateNote(
    orgId: string,
    caller: BoardCaller,
    boardId: string,
    noteId: string,
    patch: { text?: string; title?: string },
  ): Promise<BoardNoteEntity> {
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) {
      throw new ForbiddenException('You do not have access to this board');
    }
    const note = await this.notes.findOne({ where: { id: noteId, boardId, organizationId: orgId, isDeleted: false } });
    if (!note) throw new NotFoundException('Note not found');

    if (patch.text !== undefined) note.text = patch.text;
    if (patch.title !== undefined) note.title = patch.title;
    return this.notes.save(note);
  }
}
