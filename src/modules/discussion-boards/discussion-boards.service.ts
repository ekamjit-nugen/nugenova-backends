import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';

import { StorageService } from '../../bootstrap/storage/storage.service';
import { UserEntity } from '../auth/entities/user.entity';
import { NotifierService } from '../notification/notifier.service';
import { DiscussionBoardEntity } from './entities/discussion-board.entity';
import { BoardNoteEntity } from './entities/board-note.entity';
import { BoardNodeEntity } from './entities/board-node.entity';
import { BoardCommentEntity } from './entities/board-comment.entity';

/** Files uploaded as board images are tagged with this category so the public
 *  asset endpoint will only ever serve board images, never other documents. */
export const BOARD_ASSET_CATEGORY = 'board-asset';

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
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly storage: StorageService,
    private readonly notifier: NotifierService,
  ) {}

  /** Display name for a user id (best-effort). */
  private async userName(userId: string): Promise<string> {
    const u = await this.users.findOne({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } }).catch(() => null);
    return u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Someone' : 'Someone';
  }

  /** Participant userIds on a board. */
  private participantIds(board: DiscussionBoardEntity): string[] {
    return (Array.isArray(board.participants) ? board.participants : [])
      .map((p) => String((p as { userId?: unknown })?.userId))
      .filter((x) => x && x !== 'undefined');
  }

  /** @mention userIds embedded in note HTML (data-id on mention spans). */
  private mentionIds(html: string | null): string[] {
    if (!html) return [];
    const ids = new Set<string>();
    const re = /data-type="mention"[^>]*data-id="([^"]+)"|data-id="([^"]+)"[^>]*data-type="mention"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.add(m[1] || m[2]);
    return [...ids];
  }

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
    patch: { text?: string; title?: string; color?: string; dueDate?: string | null; completed?: boolean },
  ): Promise<BoardNoteEntity> {
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) {
      throw new ForbiddenException('You do not have access to this board');
    }
    const note = await this.notes.findOne({ where: { id: noteId, boardId, organizationId: orgId, isDeleted: false } });
    if (!note) throw new NotFoundException('Note not found');

    const oldText = note.text;
    if (patch.text !== undefined) note.text = patch.text;
    if (patch.title !== undefined) note.title = patch.title;
    if (patch.color !== undefined) note.color = patch.color;
    if (patch.dueDate !== undefined) {
      const d = patch.dueDate ? new Date(patch.dueDate) : null;
      // A changed deadline re-arms all reminder stages.
      if ((note.dueDate?.getTime() ?? null) !== (d?.getTime() ?? null)) note.remindersSent = [];
      note.dueDate = d;
    }
    if (patch.completed !== undefined) {
      note.completed = patch.completed;
      note.completedAt = patch.completed ? new Date() : null;
    }
    const saved = await this.notes.save(note);

    // Only fan out on a content change (not a colour/complete/date toggle).
    if (patch.text !== undefined || patch.title !== undefined) {
      void this.notifyOnNoteChange(orgId, board, saved, caller.userId, oldText, patch).catch(() => undefined);
    }
    return saved;
  }

  /** Create a new card (note) on a board. Colour defaults to white. */
  async createNote(
    orgId: string,
    caller: BoardCaller,
    boardId: string,
    input: { text?: string; title?: string; color?: string; dueDate?: string | null; completed?: boolean },
  ): Promise<BoardNoteEntity> {
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) throw new ForbiddenException('You do not have access to this board');

    const note = this.notes.create({
      organizationId: orgId,
      boardId,
      authorId: caller.userId,
      authorName: await this.userName(caller.userId),
      text: input.text ?? '',
      title: input.title ?? null,
      color: input.color || '#FFFFFF',
      x: 0, y: 0, width: 200, height: 200, zIndex: 10,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      completed: !!input.completed,
      completedAt: input.completed ? new Date() : null,
      remindersSent: [],
      isDeleted: false,
    });
    return this.notes.save(note);
  }

  /**
   * Deadline reminder sweep (called by the cron). For every open, dated note,
   * fire the stage that has come due (a day before → on the day → overdue) once,
   * to all board participants. Marking the note complete stops all reminders.
   */
  async runDueReminders(now: Date = new Date()): Promise<{ checked: number; notified: number }> {
    const notes = await this.notes.find({ where: { completed: false, isDeleted: false, dueDate: Not(IsNull()) } });
    const boardCache = new Map<string, DiscussionBoardEntity | null>();
    let notified = 0;
    for (const n of notes) {
      if (!n.dueDate) continue;
      const stage = dueStage(n.dueDate, now);
      if (!stage) continue;
      const sent = Array.isArray(n.remindersSent) ? n.remindersSent : [];
      if (sent.includes(stage)) continue;

      let board = boardCache.get(n.boardId);
      if (board === undefined) {
        board = await this.boards.findOne({ where: { id: n.boardId, isDeleted: false } });
        boardCache.set(n.boardId, board ?? null);
      }
      if (!board) continue;

      const label = n.title?.trim() || plain(n.text).slice(0, 40) || 'a card';
      const title = stage === 'day_before' ? `“${label}” is due tomorrow on “${board.title}”`
        : stage === 'due_day' ? `“${label}” is due today on “${board.title}”`
        : `“${label}” is overdue on “${board.title}”`;
      for (const userId of this.participantIds(board)) {
        await this.notifier.notify({
          organizationId: n.organizationId, userId, type: 'board_due',
          title, body: label,
          priority: stage === 'overdue' ? 'high' : undefined,
          data: { actionUrl: `/discussion-boards/${board.id}`, boardId: board.id, noteId: n.id, stage },
        });
        notified++;
      }
      n.remindersSent = [...sent, stage];
      await this.notes.save(n);
    }
    return { checked: notes.length, notified };
  }

  /**
   * Notify on a note change:
   *  - anyone NEWLY @mentioned in the note gets a mention notification;
   *  - every other board participant (except the editor and the just-mentioned)
   *    is told which board, which note, who updated it and what changed.
   */
  private async notifyOnNoteChange(
    orgId: string,
    board: DiscussionBoardEntity,
    note: BoardNoteEntity,
    actorId: string,
    oldText: string | null,
    patch: { text?: string; title?: string },
  ): Promise<void> {
    const actorName = await this.userName(actorId);
    const label = note.title?.trim() || plain(note.text).slice(0, 40) || 'a note';
    const actionUrl = `/discussion-boards/${board.id}`;

    // Newly-mentioned users.
    const before = new Set(this.mentionIds(oldText));
    const newMentions = this.mentionIds(patch.text !== undefined ? note.text : null)
      .filter((id) => !before.has(id) && id !== actorId);
    const mentionedSet = new Set(newMentions);
    for (const userId of newMentions) {
      await this.notifier.notify({
        organizationId: orgId, userId, actorId, type: 'board_mention',
        title: `${actorName} mentioned you on “${board.title}”`,
        body: label,
        data: { actionUrl, boardId: board.id, noteId: note.id },
      });
    }

    // What changed, for the update notification.
    const titleChanged = patch.title !== undefined;
    const textChanged = patch.text !== undefined && patch.text !== oldText;
    const what = titleChanged && textChanged ? 'edited the note and its title'
      : titleChanged ? 'renamed the note'
      : textChanged ? 'edited the note'
      : 'updated the note';

    const recipients = this.participantIds(board).filter((id) => id !== actorId && !mentionedSet.has(id));
    for (const userId of recipients) {
      await this.notifier.notify({
        organizationId: orgId, userId, actorId, type: 'board_note_updated',
        title: `${actorName} ${what} on “${board.title}”`,
        body: label,
        data: { actionUrl, boardId: board.id, noteId: note.id },
      });
    }
  }

  /** Add a member as a board participant (participant-gated). Notifies them. */
  async addParticipant(
    orgId: string,
    caller: BoardCaller,
    boardId: string,
    input: { userId: string; role?: string },
  ): Promise<DiscussionBoardEntity> {
    if (!input?.userId) throw new BadRequestException('userId is required');
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) throw new ForbiddenException('You do not have access to this board');

    const parts = Array.isArray(board.participants) ? [...board.participants] : [];
    if (parts.some((p) => String((p as { userId?: unknown })?.userId) === input.userId)) return board; // already a member
    const name = await this.userName(input.userId);
    parts.push({ userId: input.userId, name, role: input.role || 'member', addedAt: new Date().toISOString() });
    board.participants = parts;
    const saved = await this.boards.save(board);

    void this.notifier.notify({
      organizationId: orgId, userId: input.userId, actorId: caller.userId, type: 'board_added',
      title: `${await this.userName(caller.userId)} added you to “${board.title}”`,
      body: 'You can now view and edit this board.',
      data: { actionUrl: `/discussion-boards/${board.id}`, boardId: board.id },
    }).catch(() => undefined);
    return saved;
  }

  /** Remove a participant from a board (participant-gated). */
  async removeParticipant(orgId: string, caller: BoardCaller, boardId: string, userId: string): Promise<DiscussionBoardEntity> {
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) throw new ForbiddenException('You do not have access to this board');
    board.participants = (Array.isArray(board.participants) ? board.participants : [])
      .filter((p) => String((p as { userId?: unknown })?.userId) !== userId);
    return this.boards.save(board);
  }

  /**
   * Store an uploaded board image and return a stable relative URL the note
   * content embeds. Same participant gate as editing. Images are tagged
   * `board-asset` so the public asset endpoint only ever serves board images.
   */
  async uploadAsset(
    orgId: string,
    caller: BoardCaller,
    boardId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string } | undefined,
  ): Promise<{ id: string; url: string; mimeType: string }> {
    if (!file?.buffer?.length) throw new BadRequestException('No image provided');
    if (!/^image\//i.test(file.mimetype)) throw new BadRequestException('Only image files are allowed');
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) throw new ForbiddenException('You do not have access to this board');

    const meta = await this.storage.save({
      organizationId: orgId,
      uploadedBy: caller.userId,
      originalName: file.originalname || 'image',
      mimeType: file.mimetype,
      buffer: file.buffer,
      category: BOARD_ASSET_CATEGORY,
    });
    return { id: meta.id, url: `/discussion-boards/assets/${meta.id}`, mimeType: meta.mimeType };
  }

  /**
   * Files shared on a board — every image/asset referenced by its notes, with
   * metadata. Board-scoped (from the notes' content), participant-gated.
   */
  async getBoardFiles(orgId: string, caller: BoardCaller, boardId: string): Promise<Array<{
    id: string; url: string; name: string; mimeType: string; size: number; createdAt: Date | null; uploadedBy: string | null; noteId: string;
  }>> {
    const board = await this.boards.findOne({ where: { id: boardId, organizationId: orgId, isDeleted: false } });
    if (!board) throw new NotFoundException('Board not found');
    if (!this.canAccess(board, caller)) throw new ForbiddenException('You do not have access to this board');

    const notes = await this.notes.find({ where: { boardId, organizationId: orgId, isDeleted: false } });
    // asset id → first note that references it
    const assetNote = new Map<string, string>();
    const re = /\/discussion-boards\/assets\/([a-z0-9]{24})/gi;
    for (const n of notes) {
      let m: RegExpExecArray | null;
      const t = n.text ?? '';
      while ((m = re.exec(t))) if (!assetNote.has(m[1])) assetNote.set(m[1], n.id);
    }
    const ids = [...assetNote.keys()];
    if (!ids.length) return [];
    const files = await this.storage.listByIds(ids, orgId);
    return files
      .filter((f) => f.category === 'board-asset')
      .map((f) => ({
        id: f.id,
        url: `/discussion-boards/assets/${f.id}`,
        name: f.originalName,
        mimeType: f.mimeType,
        size: f.size,
        createdAt: f.createdAt,
        uploadedBy: f.uploadedBy,
        noteId: assetNote.get(f.id) ?? '',
      }))
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }

  /** Raw bytes for the PUBLIC asset endpoint — ONLY files tagged `board-asset`,
   *  so it can never be used to read confidential documents by id. */
  async getAssetBytes(id: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const f = await this.storage.getMeta(id).catch(() => null);
    if (!f || f.category !== BOARD_ASSET_CATEGORY) throw new NotFoundException('Asset not found');
    const buffer = await this.storage.getBytes(f);
    return { buffer, mimeType: f.mimeType, filename: f.originalName };
  }
}

/** The reminder stage a due date has reached, relative to `now` (or null). */
function dueStage(due: Date, now: Date): 'day_before' | 'due_day' | 'overdue' | null {
  if (now.getTime() > due.getTime()) return 'overdue';
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(due) - startOfDay(now)) / 86400000);
  if (diffDays === 0) return 'due_day';
  if (diffDays === 1) return 'day_before';
  return null;
}

/** Strip HTML tags + markdown punctuation to a short plain-text snippet. */
function plain(s: string | null): string {
  return (s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>`~![\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
