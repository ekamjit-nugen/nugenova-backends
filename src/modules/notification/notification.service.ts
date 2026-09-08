import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { NotificationEntity } from './entities/notification.entity';

export interface NotificationView {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  priority: string;
  actorId: string | null;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateNotificationInput {
  organizationId: string;
  userId: string;
  actorId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  priority?: string;
}

export interface ListOptions {
  limit?: number;
  /** Compound cursor `<createdAtMs>:<id>` from a previous page's nextCursor. */
  before?: string | null;
  unreadOnly?: boolean;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}

/** attendance | leave | onboarding | policy | system — the coarse family of a type. */
export function categoryForType(type: string): string {
  const t = (type || '').toLowerCase();
  if (t.startsWith('wfh') || t.startsWith('attendance')) return 'attendance';
  if (t.startsWith('leave')) return 'leave';
  if (t.startsWith('timesheet')) return 'timesheet';
  if (t.startsWith('payroll') || t.startsWith('tax_declaration')) return 'payroll';
  if (t.startsWith('onboarding')) return 'onboarding';
  if (t.startsWith('policy') || t.startsWith('policies')) return 'policy';
  if (t.startsWith('chat')) return 'chat';
  return 'system';
}

const MAX_LIMIT = 50;

/**
 * NotificationService — the recipient-scoped inbox store. Persistence is the
 * whole point: every notification a user is sent is durably tracked here and
 * surfaced in their panel. EVERY method takes the caller's `userId` (from the
 * JWT, never the request body) and filters on it, so a member can only ever read
 * or mutate their OWN notifications — the isolation guarantee.
 *
 * Pagination is a compound cursor (`createdAt`,`id`) so it stays correct even if
 * two rows share a millisecond. Deletes are hard (the panel is transient
 * history), scoped to the owner.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly repo: Repository<NotificationEntity>,
  ) {}

  /** Persist one notification. Returns the created row's view. */
  async create(input: CreateNotificationInput): Promise<NotificationView> {
    const row = await this.repo.save(
      this.repo.create({
        organizationId: input.organizationId,
        userId: input.userId,
        actorId: input.actorId ?? null,
        type: input.type,
        category: categoryForType(input.type),
        title: input.title,
        body: input.body ?? null,
        data: input.data ?? {},
        priority: input.priority ?? 'normal',
        read: false,
      }),
    );
    return this.toView(row);
  }

  /**
   * The caller's own notifications, newest first, cursor-paginated. `unreadOnly`
   * filters server-side (the panel's "Unread" tab), so counts and the list never
   * disagree. Always returns the live `unreadCount` for the badge.
   */
  async list(userId: string, opts: ListOptions = {}): Promise<NotificationPage> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_LIMIT);

    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId })
      .andWhere('n.isDeleted = false')
      .orderBy('n.createdAt', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .take(limit + 1);

    if (opts.unreadOnly) qb.andWhere('n.read = false');

    const cursor = parseCursor(opts.before);
    if (cursor) {
      // Rows strictly older than the cursor (compound compare on createdAt,id).
      qb.andWhere(
        new Brackets((w) => {
          w.where('n.createdAt < :cts', { cts: cursor.createdAt }).orWhere(
            new Brackets((w2) => {
              w2.where('n.createdAt = :cts2', { cts2: cursor.createdAt }).andWhere(
                'n.id < :cid',
                { cid: cursor.id },
              );
            }),
          );
        }),
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? `${last.createdAt.getTime()}:${last.id}` : null;

    return {
      items: page.map((r) => this.toView(r)),
      nextCursor,
      unreadCount: await this.unreadCount(userId),
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.repo.count({ where: { userId, read: false, isDeleted: false } });
  }

  /** Mark ONE of the caller's notifications read. No-op if it isn't theirs. */
  async markRead(id: string, userId: string): Promise<void> {
    await this.repo.update(
      { id, userId, read: false },
      { read: true, readAt: new Date() },
    );
  }

  /** Mark every unread notification of the caller read. Returns how many. */
  async markAllRead(userId: string): Promise<number> {
    const res = await this.repo.update(
      { userId, read: false, isDeleted: false },
      { read: true, readAt: new Date() },
    );
    return res.affected ?? 0;
  }

  /** Hard-delete one of the caller's notifications (dismiss). */
  async remove(id: string, userId: string): Promise<void> {
    await this.repo.delete({ id, userId });
  }

  /** Hard-delete all of the caller's READ notifications (clear read). */
  async clearRead(userId: string): Promise<number> {
    const res = await this.repo.delete({ userId, read: true });
    return res.affected ?? 0;
  }

  private toView(r: NotificationEntity): NotificationView {
    return {
      id: r.id,
      type: r.type,
      category: r.category,
      title: r.title,
      body: r.body,
      data: r.data ?? {},
      priority: r.priority,
      actorId: r.actorId,
      read: r.read,
      readAt: r.readAt,
      createdAt: r.createdAt,
    };
  }
}

/** Parse a `<createdAtMs>:<id>` cursor; tolerate a bare id or garbage → null. */
function parseCursor(
  raw: string | null | undefined,
): { createdAt: Date; id: string } | null {
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const ms = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { createdAt: new Date(ms), id };
}
